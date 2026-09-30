import type { Block } from '../types/block'
import type { Draft } from '../types/draft'
import type { CarvingCallback } from '../types/callback'
import { db } from './db'
import { parseCallbackText, type ParsedCallback } from './callback'

export type IngestStatus = 'applied' | 'duplicate' | 'batch' | 'error'

export interface CallbackIngestResult {
  status: IngestStatus
  raw: string
  message: string
  draftId?: string
  blockId?: string
}

/** 节点备注带此前缀，重跑同一条回传时不会重复登记工序节点 */
const NODE_NOTE_PREFIX = '外协刻坊回传'

function locateDraft(drafts: Draft[], ref: string): Draft | undefined {
  const exact = drafts.find((draft) => draft.id === ref || draft.title === ref)
  if (exact) return exact
  const fuzzy = drafts.filter((draft) => draft.title.includes(ref) || ref.includes(draft.title))
  return fuzzy.length === 1 ? fuzzy[0] : undefined
}

function locateBlock(blocks: Block[], parsed: ParsedCallback): { block?: Block; error?: string } {
  let matched: Block | undefined
  if (parsed.colorNo !== null) {
    matched = blocks.find((block) => block.colorNo === parsed.colorNo)
  }
  if (parsed.blockName) {
    const byName = blocks.find((block) => block.blockName === parsed.blockName)
    if (!matched) matched = byName
    else if (byName && byName.id !== matched.id) {
      return { error: `色序 ${parsed.colorNo} 与版片「${parsed.blockName}」对不上` }
    }
  }
  if (!matched) return { error: '该画稿下找不到对应色序/版片' }
  return { block: matched }
}

function todayCompact(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '')
}

/**
 * 接收一条外协回传文本并落库：
 * 同一版片仅首条回传更新状态、崩口与工序节点；
 * 之后的重复消息只追加来源记录，不重复计入进度。
 * 全部色版都回传后自动生成正式印制批次，印数取各版最小值。
 */
export async function ingestCallbackMessage(raw: string): Promise<CallbackIngestResult> {
  const parsed = parseCallbackText(raw)
  if (parsed.errors.length > 0) {
    return { status: 'error', raw, message: parsed.errors.join('；') }
  }

  try {
    let outcome: CallbackIngestResult = { status: 'applied', raw, message: '' }
    let matchedDraft: Draft | undefined
    let matchedBlock: Block | undefined

    await db.transaction(
      'rw',
      [db.drafts, db.blocks, db.carvers, db.batches, db.nodes, db.callbacks],
      async () => {
        const drafts = await db.drafts.toArray()
        const draft = locateDraft(drafts, parsed.draftRef)
        if (!draft) {
          outcome = { status: 'error', raw, message: `找不到画稿「${parsed.draftRef}」` }
          return
        }
        matchedDraft = draft

        const draftBlocks = await db.blocks.where('draftId').equals(draft.id).toArray()
        const located = locateBlock(draftBlocks, parsed)
        if (!located.block) {
          outcome = { status: 'error', raw, message: located.error ?? '版片定位失败' }
          return
        }
        const block = located.block
        matchedBlock = block

        // 同一版片 + 同一来源标识视为重复消息，只确认来源，不再写任何进度
        const sameSource = await db.callbacks
          .where('blockId')
          .equals(block.id)
          .filter((record) => record.sourceKey === parsed.sourceKey)
          .first()
        if (sameSource) {
          outcome = {
            status: 'duplicate',
            raw,
            message: `${draft.title} ${block.blockName} 的重复回传（${parsed.sourceKey}），仅核对来源，进度未重算`,
          }
          return
        }

        const alreadyApplied = await db.callbacks.where('blockId').equals(block.id).filter((record) => record.applied).first()
        const applied = !alreadyApplied

        const callbackRecord: CarvingCallback = {
          id: `callback-${crypto.randomUUID()}`,
          draftId: draft.id,
          blockId: block.id,
          sourceKey: parsed.sourceKey,
          sourceText: raw,
          receivedAt: parsed.receivedAt ?? new Date().toISOString().slice(0, 16),
          applied,
          printQty: parsed.printQty ?? 0,
          note: parsed.defectNote,
        }
        await db.callbacks.add(callbackRecord)

        if (!applied) {
          outcome = {
            status: 'duplicate',
            raw,
            message: `${draft.title} ${block.blockName} 已有首条回传，本次消息（${parsed.sourceKey}）仅留存来源`,
          }
          return
        }

        const changes: Partial<Pick<Block, 'state' | 'defectNote'>> = {
          state: block.state === '已修版' ? '已修版' : '已刻成',
        }
        if (parsed.defectNote) changes.defectNote = parsed.defectNote
        await db.blocks.update(block.id, changes)

        // 外协刻成后释放本坊刻工的在刻占用
        const carvers = await db.carvers.toArray()
        for (const carver of carvers) {
          if (!carver.activeBlockIds.includes(block.id)) continue
          await db.carvers.update(carver.id, {
            activeBlockIds: carver.activeBlockIds.filter((id) => id !== block.id),
          })
        }

        const existingNodes = await db.nodes.where('blockId').equals(block.id).toArray()
        const nodeNote = `${NODE_NOTE_PREFIX}：${parsed.sourceKey}`
        if (!existingNodes.some((node) => node.note === nodeNote)) {
          await db.nodes.add({
            id: `node-${crypto.randomUUID()}`,
            blockId: block.id,
            stage: '刻版',
            seq: Math.max(0, ...existingNodes.map((node) => node.seq)) + 1,
            operator: '外协刻坊',
            startedAt: new Date().toISOString().slice(0, 16),
            durationMin: 0,
            note: nodeNote,
          })
        }

        const allCallbacks = await db.callbacks.where('draftId').equals(draft.id).toArray()
        const appliedByBlock = new Map<string, CarvingCallback>()
        for (const record of allCallbacks) {
          if (record.applied && !appliedByBlock.has(record.blockId)) appliedByBlock.set(record.blockId, record)
        }

        const everyBlockReturned = draftBlocks.every((item) => appliedByBlock.has(item.id))
        if (!everyBlockReturned) {
          const returnedCount = draftBlocks.filter((item) => appliedByBlock.has(item.id)).length
          if (draft.status === '起稿' || draft.status === '分版中') {
            await db.drafts.update(draft.id, { status: '刻版中' })
          }
          outcome = {
            status: 'applied',
            raw,
            message: `${draft.title} ${block.blockName} 已按首条回传刻成（${returnedCount}/${draftBlocks.length} 色版回传）`,
          }
          return
        }

        // 各色版均已回传：由本坊生成正式印制批次，印数取各版最小数
        const existingBatch = await db.batches
          .where('draftId')
          .equals(draft.id)
          .filter((batch) => batch.source === '外协回传')
          .first()
        if (existingBatch) {
          await db.drafts.update(draft.id, { status: '可印' })
          outcome = {
            status: 'applied',
            raw,
            message: `${draft.title} ${block.blockName} 已刻成；正式批次 ${existingBatch.batchNo} 此前已生成`,
          }
          return
        }

        const minQty = Math.min(...[...appliedByBlock.values()].map((record) => record.printQty))
        const batchIndex = await db.batches.where('draftId').equals(draft.id).count()
        const batchNo = `${draft.title}-外协-${todayCompact()}-${String(batchIndex + 1).padStart(2, '0')}`
        await db.batches.add({
          id: `batch-${crypto.randomUUID()}`,
          draftId: draft.id,
          batchNo,
          printedAt: new Date().toISOString().slice(0, 10),
          paperBatch: '按外协回传汇总，纸张批次待补登',
          inkNote: '各色版外协刻成，颜料配比按套色序号待调色',
          qty: minQty,
          pieceCount: draftBlocks.length,
          qcNote: `外协各色版回传齐全，印数取各版最小值 ${minQty}。`,
          source: '外协回传',
        })
        await db.drafts.update(draft.id, { status: '可印' })

        outcome = {
          status: 'batch',
          raw,
          message: `${draft.title} 四色版均已回传，已生成正式批次 ${batchNo}，印数 ${minQty}（取各版最小数）`,
        }
      },
    )

    if (outcome.status !== 'error') {
      outcome.draftId = matchedDraft?.id
      outcome.blockId = matchedBlock?.id
    }
    return outcome
  } catch (error) {
    return {
      status: 'error',
      raw,
      message: `写入失败：${error instanceof Error ? error.message : '档案库暂不可用'}，可点「重试」重发本条`,
    }
  }
}
