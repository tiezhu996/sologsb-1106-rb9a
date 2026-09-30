import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { db } from '../src/utils/db'
import { returnStore } from '../src/stores/returnStore'

function useFactory(factory) {
  Dexie.dependencies.indexedDB = factory
  Dexie.dependencies.IDBKeyRange = IDBKeyRange
  // db 单例在构造时缓存了 IndexedDB 引用，测试里需要一并切换。
  db._deps.indexedDB = factory
  db._deps.IDBKeyRange = IDBKeyRange
  globalThis.indexedDB = factory
  globalThis.IDBKeyRange = IDBKeyRange
}

function resetDatabase() {
  db.close()
  useFactory(new IDBFactory())
}

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`PASS ${name}`)
  } else {
    failures += 1
    console.error(`FAIL ${name} ${detail}`)
  }
}

function returnText({ draft = '秦琼敬德', block, qty, defect = '', nodes = '刻版、修版', source, state = '已刻成' }) {
  return [
    `画稿：${draft}`,
    `版片：${block}`,
    `状态：${state}`,
    defect ? `崩口：${defect}` : '',
    qty ? `印数：${qty}` : '',
    nodes ? `工序节点：${nodes}` : '',
    `来源：${source}`,
  ]
    .filter(Boolean)
    .join('\n')
}

async function testHappyPath() {
  resetDatabase()
  await db.open()

  await returnStore.load()
  await db.blocks.toArray()

  const sources = ['西关刻坊-回执0312', '东关刻坊-回执0313', '南关刻坊-回执0314', '北关刻坊-回执0315']
  const names = ['墨线版', '黄版', '红版', '绿版']
  const qtys = [500, 360, 420, 300]

  for (let i = 0; i < 4; i += 1) {
    const res = await returnStore.ingest(
      returnText({ block: names[i], qty: qtys[i], defect: `${names[i]}崩口一处`, source: sources[i] }),
    )
    check(`首条回执 ${names[i]} ok=${res.ok} applied=${res.applied}`, res.ok && res.applied, res.message)
    if (i < 3) check(`前 ${i + 1} 版时尚不生成批次`, res.batchNo === null)
    else check(`第四版回传后生成批次`, res.batchNo !== null, res.message)
  }

  const blocks = await db.blocks.where('draftId').equals('draft-menshen-qin').toArray()
  check('四块版片全部刻成', blocks.every((b) => b.state === '已刻成'))
  check('四块版片标记为外协', blocks.every((b) => b.sourceMode === 'outsource'))
  check('崩口已写入', blocks.every((b) => b.defectNote.includes('崩口一处')))

  const red = blocks.find((b) => b.blockName === '红版')
  const redNodes = await db.nodes.where('blockId').equals(red.id).toArray()
  const redStages = redNodes.map((n) => n.stage)
  check('工序节点含刻版、修版', redStages.includes('刻版') && redStages.includes('修版'), JSON.stringify(redStages))

  const draft = await db.drafts.get('draft-menshen-qin')
  check('画稿状态转为可印', draft.status === '可印', draft.status)

  const batches = await db.batches.where('draftId').equals('draft-menshen-qin').toArray()
  const auto = batches.find((b) => b.id === 'batch-auto-draft-menshen-qin')
  check('自动批次存在', !!auto)
  check('印数取各版最小数 300', auto && auto.qty === 300, `qty=${auto?.qty}`)
  check('每版印次为4', auto && auto.pieceCount === 4)

  const carvers = await db.carvers.toArray()
  check('刻成后释放刻工负荷', carvers.every((c) => !c.activeBlockIds.some((id) => blocks.some((b) => b.id === id))))

  // 重复回传：只留来源，不改进度/印数
  const beforeCount = await db.carvingReturns.count()
  const dup = await returnStore.ingest(returnText({ block: '红版', qty: 999, defect: '不应覆盖', source: '西关刻坊-重复回执X' }))
  check('重复回执 ok 但不 applied', dup.ok && dup.applied === false, dup.message)
  const afterCount = await db.carvingReturns.count()
  check('重复回执仍留档一条', afterCount === beforeCount + 1)
  const redAfter = await db.blocks.get(red.id)
  check('重复回执未覆盖崩口', !redAfter.defectNote.includes('不应覆盖'))
  const autoAfter = (await db.batches.get(auto.id))
  check('重复回执未改动批次印数', autoAfter.qty === 300)
  const dupRows = await db.carvingReturns.where('blockId').equals(red.id).toArray()
  check('重复回执保留了来源', dupRows.some((r) => r.source.includes('重复回执X') && r.applied === false))

  // 写坏数据库后重试：让 nodes.add 抛错，模拟事务中途写入失败
  const nodesAdd = db.nodes.add.bind(db.nodes)
  db.nodes.add = () => Promise.reject(new Error('disk full'))
  const failed = await returnStore.ingest(returnText({ draft: '灶王司命', block: '红版', qty: 200, source: '西关刻坊-失败回执' }))
  db.nodes.add = nodesAdd
  check('写入失败返回 ok=false', failed.ok === false, failed.message)
  check('失败消息提示可重试', failed.message.includes('重试'))

  const zwCountAfterFail = await db.carvingReturns.where('draftId').equals('draft-zaowang-siming').count()
  check('失败事务整体回滚（灶王无残留回执）', zwCountAfterFail === 0)
  const msReturnsAfterFail = await db.carvingReturns.where('draftId').equals('draft-menshen-qin').count()
  check('已通过的秦琼回执仍保留', msReturnsAfterFail === 5)

  const retry = await returnStore.ingest(returnText({ draft: '灶王司命', block: '红版', qty: 200, source: '西关刻坊-失败回执' }))
  check('故障恢复后重试成功', retry.ok && retry.applied, retry.message)
  const zwRed = (await db.blocks.where('draftId').equals('draft-zaowang-siming').toArray()).find((b) => b.blockName === '红版')
  check('重试后灶王红版刻成', zwRed.state === '已刻成')

}

async function testMissingQtyNoBatch() {
  resetDatabase()
  await db.open()
  await returnStore.load()

  const sources = ['s1', 's2', 's3', 's4']
  const names = ['墨线版', '黄版', '红版', '绿版']
  for (let i = 0; i < 3; i += 1) {
    await returnStore.ingest(returnText({ draft: '灶王司命', block: names[i], qty: 100, source: sources[i], nodes: '' }))
  }
  const last = await returnStore.ingest(returnText({ draft: '灶王司命', block: '绿版', qty: 0, source: sources[3], nodes: '' }))
  check('缺印数的末版仍落库', last.ok && last.applied)
  const auto = await db.batches.get('batch-auto-draft-zaowang-siming')
  check('有一版缺印数时不生成批次', !auto)
}

async function testLocateErrors() {
  resetDatabase()
  await db.open()
  await returnStore.load()

  const badDraft = await returnStore.ingest(returnText({ draft: '不存在的年画', block: '红版', qty: 10, source: 'x' }))
  check('找不到画稿时报错且不落库', badDraft.ok === false)
  const badBlock = await returnStore.ingest(returnText({ block: '紫版', qty: 10, source: 'x' }))
  check('找不到版片时报错且不落库', badBlock.ok === false)
  const badState = await returnStore.ingest(
    ['画稿：秦琼敬德', '版片：红版', '状态：飞天遁地', '印数：100', '来源：x'].join('\n'),
  )
  check('状态无法识别时报错', badState.ok === false)
  check('定位失败均无回执残留', (await db.carvingReturns.count()) === 0)
}

async function testV3Migration() {
  db.close()
  const factory = new IDBFactory()
  useFactory(factory)

  // 以 v2 结构手动建库并写入一条旧版片（无 sourceMode）
  await new Promise((resolve, reject) => {
    const req = factory.open('gbwoodprint-db', 2)
    req.onupgradeneeded = () => {
      const idb = req.result
      for (const name of ['drafts', 'blocks', 'carvers', 'batches', 'nodes']) {
        if (!idb.objectStoreNames.contains(name)) idb.createObjectStore(name, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => {
      const idb = req.result
      const tx = idb.transaction('blocks', 'readwrite')
      tx.objectStore('blocks').put({
        id: 'old-block-1',
        draftId: 'draft-x',
        blockName: '墨线版',
        colorNo: 1,
        woodType: '黄杨',
        thicknessMm: 18,
        carvedBy: '老手',
        state: '在刻',
        defectNote: '',
        schemaRev: 2,
      })
      tx.oncomplete = () => {
        idb.close()
        resolve(null)
      }
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })

  await db.open()
  const oldBlock = await db.blocks.get('old-block-1')
  check('迁移后旧版片按本坊自刻处理', oldBlock.sourceMode === 'self', `sourceMode=${oldBlock.sourceMode}`)
  check('迁移后 schemaRev=3', oldBlock.schemaRev === 3)
  check('回传表已建立', db.carvingReturns.name === 'carvingReturns')

  // 自刻旧版片可以正常接收首条外协回执
  await db.drafts.add({
    id: 'draft-x', title: '旧年画', genre: '门神', designer: '旧人', sizeCm: '10x10', paperNote: '', status: '刻版中', schemaRev: 3,
  })
  const res = await returnStore.ingest(returnText({ draft: '旧年画', block: '墨线版', qty: 50, source: '新刻坊' }))
  check('旧数据升级后可接收回传', res.ok && res.applied, res.message)
  const updated = await db.blocks.get('old-block-1')
  check('旧版片回传后转为外协', updated.sourceMode === 'outsource' && updated.state === '已刻成')
  db.close()
}

async function testInProgressFirstReturn() {
  resetDatabase()
  await db.open()
  await returnStore.load()

  // 穆柯寨四块均待刻：首条黄版回执是「在刻」进度
  const first = await returnStore.ingest(returnText({ draft: '穆柯寨', block: '黄版', state: '在刻', qty: 0, nodes: '', source: '西坊-进度1' }))
  check('在刻首条回执生效', first.ok && first.applied, first.message)
  const yellow = (await db.blocks.where('draftId').equals('draft-muke-zhai').toArray()).find((b) => b.blockName === '黄版')
  check('版片状态更新为在刻', yellow.state === '在刻')

  // 随后真正的「已刻成」回执只能留来源，不再改写
  const second = await returnStore.ingest(returnText({ draft: '穆柯寨', block: '黄版', state: '已刻成', qty: 200, nodes: '刻版', source: '西坊-完成1' }))
  check('完成回执被视为重复', second.ok && second.applied === false)
  const yellowAfter = await db.blocks.get(yellow.id)
  check('重复完成回执未改写状态', yellowAfter.state === '在刻')

  // 其余三版均刻成回传，也不会自动生批次（黄版仍在刻）
  for (const name of ['墨线版', '红版', '绿版']) {
    const r = await returnStore.ingest(returnText({ draft: '穆柯寨', block: name, qty: 200, source: `西坊-${name}` }))
    check(`${name}回执落库`, r.ok && r.applied, r.message)
    check('在刻未齐时不生批次', r.batchNo === null)
  }

  // 手工在编排台标刻成后，四版齐备，仍不自动生批次（自动批次只在回传事务内判定）
  await db.blocks.update(yellow.id, { state: '已刻成' })
  const auto = await db.batches.get('batch-auto-draft-muke-zhai')
  check('在刻首条场景不自动生批次，转由批次页登记', !auto)
  db.close()
}

async function main() {
  await testHappyPath()
  await testMissingQtyNoBatch()
  await testInProgressFirstReturn()
  await testLocateErrors()
  await testV3Migration()
  if (failures > 0) {
    console.error(`\n${failures} checks failed`)
    process.exit(1)
  }
  console.log('\nAll checks passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
