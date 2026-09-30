// 端到端验证：外协回传入库逻辑（fake-indexeddb 模拟浏览器本地库）
import './setup-fake-idb'

import { db, initializeDatabase } from '../src/utils/db'
import { ingestCallbackMessage } from '../src/utils/ingest'
import { parseCallbackText, splitCallbackMessages } from '../src/utils/callback'

let failures = 0
function assert(condition: unknown, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}`)
  }
}

async function main(): Promise<void> {
  await initializeDatabase()

  console.log('— 解析器 —')
  const parsed = parseCallbackText('画稿：秦琼敬德；版片：红版\n印数：300；来源：wx-03；崩口：左下浅崩。')
  assert(parsed.draftRef === '秦琼敬德' && parsed.blockName === '红版' && parsed.printQty === 300, '单行分号串联多字段可解析')
  assert(parsed.sourceKey === 'wx-03' && parsed.defectNote.includes('左下'), '来源与崩口可解析')
  const onlyColor = parseCallbackText('画稿：穆柯寨\n色序：2\n印数：120\n来源：wx-x')
  assert(onlyColor.colorNo === 2 && onlyColor.blockName === null && onlyColor.errors.length === 0, '仅给色序也能定位')
  const bad = parseCallbackText('画稿：灶王司命\n版片：红版')
  assert(bad.errors.some((e) => e.includes('印数')) && bad.errors.some((e) => e.includes('来源')), '缺字段给出错误提示')
  const multi = splitCallbackMessages('画稿：A\n来源：s1\n---\n画稿：B\n来源：s2')
  assert(multi.length === 2, '三横线分隔多条消息')

  console.log('— 旧数据：无回传记录仍按自刻 —')
  const llCallbacks = await db.callbacks.where('draftId').equals('draft-liannian-youyu').count()
  assert(llCallbacks === 0, '莲年有余旧版片没有任何回传记录')
  const llDraft = await db.drafts.get('draft-liannian-youyu')
  assert(llDraft?.status === '可印', '旧画稿可印状态不被动')
  const llBatchCount = await db.batches.where('draftId').equals('draft-liannian-youyu').count()
  assert(llBatchCount === 2, '升级不替旧画稿补造批次')

  console.log('— 秦琼敬德：分次回传 —')
  const r1 = await ingestCallbackMessage('画稿：秦琼敬德\n版片：黄版\n印数：320\n崩口：甲胄边浅崩，已嵌补。\n来源：wx-ms-02')
  assert(r1.status === 'applied', '黄版首条回传 → applied')
  const ms02 = await db.blocks.get('block-ms-02')
  assert(ms02?.state === '已刻成', '黄版状态更新为已刻成')
  assert(ms02?.defectNote.includes('嵌补'), '黄版崩口已更新')
  const zhou = await db.carvers.get('carver-zhou')
  assert(!zhou?.activeBlockIds.includes('block-ms-02'), '黄版刻成后释放刻工在刻占用')
  const ms02Nodes = await db.nodes.where('blockId').equals('block-ms-02').toArray()
  assert(ms02Nodes.some((n) => n.stage === '刻版' && n.note.includes('wx-ms-02')), '黄版追加刻版工序节点（带来源）')
  assert(ms02Nodes.filter((n) => n.note.includes('外协刻坊回传')).length === 1, '只追加一个外协节点')

  const r1Dup = await ingestCallbackMessage('画稿：秦琼敬德\n版片：黄版\n印数：999\n崩口：不该覆盖\n来源：wx-ms-02')
  assert(r1Dup.status === 'duplicate', '同来源标识重发 → duplicate')
  const ms02AfterDup = await db.blocks.get('block-ms-02')
  assert(!ms02AfterDup?.defectNote.includes('不该覆盖'), '重复消息不覆盖崩口')
  assert(ms02AfterDup?.state === '已刻成', '重复消息不重算状态')
  const dupNodes = await db.nodes.where('blockId').equals('block-ms-02').toArray()
  assert(dupNodes.filter((n) => n.note.includes('外协刻坊回传')).length === 1, '重复消息不重复登记节点')

  const r1OtherSource = await ingestCallbackMessage('画稿：秦琼敬德\n色序：2\n印数：999\n来源：wx-ms-02-again')
  assert(r1OtherSource.status === 'duplicate', '换一个来源再发同一版 → 仍 duplicate（首条才算）')
  const ms02Callbacks = await db.callbacks.where('blockId').equals('block-ms-02').toArray()
  assert(ms02Callbacks.length === 2 && ms02Callbacks.filter((c) => c.applied).length === 1, '两条来源都留存，仅首条 applied')

  const r3 = await ingestCallbackMessage('画稿：秦琼敬德\n版片：红版\n印数：300\n来源：wx-ms-03')
  assert(r3.status === 'applied', '红版回传 → applied')
  const r4 = await ingestCallbackMessage('画稿：秦琼敬德\n版片：绿版\n印数：260\n来源：wx-ms-04')
  assert(r4.status === 'applied' && r4.message.includes('3/4'), '绿版回传后提示 3/4，未生成批次')

  const rOldBlock = await ingestCallbackMessage('画稿：秦琼敬德\n版片：墨线版\n印数：350\n来源：wx-ms-01')
  assert(rOldBlock.status === 'batch', '旧自刻版片首条回传也生效，四色齐 → batch')
  assert(rOldBlock.message.includes('260'), '批次印数取各版最小值 260')
  const msDraft = await db.drafts.get('draft-menshen-qin')
  assert(msDraft?.status === '可印', '画稿转为可印')
  const msBatches = await db.batches.where('draftId').equals('draft-menshen-qin').toArray()
  const outsourceBatch = msBatches.find((b) => b.source === '外协回传')
  assert(Boolean(outsourceBatch) && outsourceBatch?.qty === 260 && outsourceBatch.pieceCount === 4, '正式批次已生成：qty=260、4 版')

  const rAfterBatch = await ingestCallbackMessage('画稿：秦琼敬德\n版片：红版\n印数：1\n来源：wx-ms-03-late')
  assert(rAfterBatch.status === 'duplicate', '齐活后的迟到消息仅留来源')
  const msBatchCountAfter = await db.batches.where('draftId').equals('draft-menshen-qin').count()
  assert(msBatchCountAfter === msBatches.length, '迟到消息不重复生成批次')

  console.log('— 失败消息可重试，已通过的保留 —')
  const rBad = await ingestCallbackMessage('画稿：穆柯寨\n版片：红版')
  assert(rBad.status === 'error' && rBad.raw.includes('穆柯寨'), '字段不全 → error 且原文保留供重试')
  const mkCallbacksBefore = await db.callbacks.where('draftId').equals('draft-muke-zhai').count()
  assert(mkCallbacksBefore === 0, '失败消息未写入任何回传记录')
  const rRetry = await ingestCallbackMessage('画稿：穆柯寨\n版片：黄版\n印数：150\n来源：wx-mk-02')
  assert(rRetry.status === 'applied', '另一条合法消息先入档成功')
  const mkDraft = await db.drafts.get('draft-muke-zhai')
  assert(mkDraft?.status === '刻版中', '起稿画稿收到首条回传后进入刻版中')
  const rBadRetry = await ingestCallbackMessage(`${rBad.raw}\n印数：180\n来源：wx-mk-03`)
  assert(rBadRetry.status === 'applied', '补齐字段后重试成功')
  const mkAppliedBlocks = await db.callbacks
    .where('draftId')
    .equals('draft-muke-zhai')
    .filter((c) => c.applied)
    .toArray()
  assert(mkAppliedBlocks.length === 2, '重试不影响此前已通过的回传')

  console.log('— 定位失败 —')
  const rNoDraft = await ingestCallbackMessage('画稿：不存在的稿\n版片：红版\n印数：10\n来源：x')
  assert(rNoDraft.status === 'error' && rNoDraft.message.includes('找不到画稿'), '画稿定位失败')
  const rMismatch = await ingestCallbackMessage('画稿：灶王司命\n色序：2\n版片：红版\n印数：10\n来源：x')
  assert(rMismatch.status === 'error' && rMismatch.message.includes('对不上'), '色序与版片矛盾时报错')

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exitCode = failures === 0 ? 0 : 1
}

void main().catch((error) => { console.error(error); process.exit(1) })
