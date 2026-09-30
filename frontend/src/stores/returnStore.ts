import { derived, writable } from 'svelte/store'
import type { Block } from '../types/block'
import type { CarvingReturn, IngestReturnResult, ReturnIssue } from '../types/carvingReturn'
import type { PrintBatch } from '../types/batch'
import type { ProcessStage } from '../types/node'
import { db } from '../utils/db'
import { locateBlock, locateDraft, normalizeStateText, parseCarvingReturn } from '../utils/carvingReturn'

const returnList = writable<CarvingReturn[]>([])

const returnsByBlock = derived(returnList, ($returns) => {
  const grouped: Record<string, CarvingReturn[]> = {}
  for (const item of [...$returns].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    grouped[item.blockId] = [...(grouped[item.blockId] ?? []), item]
  }
  return grouped
})

async function load(): Promise<void> {
  const records = await db.carvingReturns.toArray()
  records.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
  returnList.set(records)
}

function issueMessage(issues: ReturnIssue[]): string {
  return issues.map((issue) => issue.message).join(' ')
}

function autoBatchId(draftId: string): string {
  return `batch-auto-${draftId}`
}

interface AutoBatchAssessment {
  batch: PrintBatch | null
  pendingReason: string | null
}

async function assessAutoBatch(draftId: string, returns: CarvingReturn[]): Promise<AutoBatchAssessment> {
  const blocks = await db.blocks.where('draftId').equals(draftId).toArray()
  if (blocks.length === 0) return { batch: null, pendingReason: null }

  const appliedByBlock = new Map(returns.filter((item) => item.applied).map((item) => [item.blockId, item]))
  const missingBlocks = blocks.filter((block) => !appliedByBlock.has(block.id))
  if (missingBlocks.length > 0) {
    return { batch: null, pendingReason: null }
  }
  // 必须确为「雕完」结果（已刻成或已修版），在刻进度回传不生批次。
  const unfinished = blocks.filter((block) => block.state !== '已刻成' && block.state !== '已修版')
  if (unfinished.length > 0) {
    return { batch: null, pendingReason: `${unfinished.map((block) => block.blockName).join('、')} 仍在刻，按首条回执为准不再改写，请在编排台手动标刻成后登记印制批次` }
  }

  const appliedReturns = returns.filter((item) => item.draftId === draftId && item.applied)
  const withoutQty = appliedReturns.filter((item) => item.printQty === undefined)
  if (withoutQty.length > 0) {
    return { batch: null, pendingReason: `${withoutQty.length} 条回传未注明印数，补齐后即按各版最小数生成正式批次` }
  }
  const qty = Math.min(...appliedReturns.map((item) => item.printQty as number))

  const draft = await db.drafts.get(draftId)
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const batchNo = `${draft?.title ?? '画稿'}-外协-${day}-01`
  const sourceSummary = appliedReturns
    .map((item) => {
      const block = blocks.find((candidate) => candidate.id === item.blockId)
      return `${block?.blockName ?? item.blockId}据${item.source}回传（可印 ${item.printQty}）`
    })
    .join('；')

  return {
    pendingReason: null,
    batch: {
      id: autoBatchId(draftId),
      draftId,
      batchNo,
      printedAt: new Date().toISOString().slice(0, 10),
      paperBatch: '待登记',
      inkNote: '外协刻坊各色版回传齐备后由本坊自动生成，纸张与颜料待登记。',
      qty,
      pieceCount: blocks.length,
      qcNote: `印数取各色版最小数 ${qty}；${sourceSummary}`,
    },
  }
}

/**
 * 接收一条外协回传文本：
 * 同一版片仅首条回传落库（更新状态、崩口、工序节点），重复消息只留来源；
 * 各色版都回传且印数齐备时，自动生成正式印制批次，印数取各版最小数。
 */
async function ingest(rawText: string): Promise<IngestReturnResult> {
  const { parsed, issues } = parseCarvingReturn(rawText)
  if (!parsed) {
    return {
      ok: false,
      message: issueMessage(issues) || '回传文本无法解析，请修订后重试。',
      issues,
      createdReturnId: null,
      applied: false,
      batchNo: null,
    }
  }

  const [drafts, blocks] = await Promise.all([db.drafts.toArray(), db.blocks.toArray()])
  const draft = locateDraft(drafts, parsed.draftRef)
  if (!draft) {
    return {
      ok: false,
      message: `找不到画稿「${parsed.draftRef}」，无法定位，请核对名称后重试。`,
      issues,
      createdReturnId: null,
      applied: false,
      batchNo: null,
    }
  }
  const block = locateBlock(blocks, draft.id, parsed.blockRef)
  if (!block) {
    return {
      ok: false,
      message: `画稿「${draft.title}」下找不到版片「${parsed.blockRef}」，请核对色序或版名后重试。`,
      issues,
      createdReturnId: null,
      applied: false,
      batchNo: null,
    }
  }

  const state = normalizeStateText(parsed.stateText)
  if (!state) {
    return {
      ok: false,
      message: `状态「${parsed.stateText || '空'}」无法识别（如：已刻成、在刻、已修版），请修订后重试。`,
      issues,
      createdReturnId: null,
      applied: false,
      batchNo: null,
    }
  }

  const returnId = `return-${crypto.randomUUID()}`
  const txResult: { batch: PrintBatch | null; pendingReason: string | null; duplicateId: string | null } = {
    batch: null,
    pendingReason: null,
    duplicateId: null,
  }

  const stageFromState = (value: Block['state']): ProcessStage | undefined => {
    if (value === '已刻成' || value === '在刻') return '刻版'
    if (value === '已修版') return '修版'
    return undefined
  }

  try {
    await db.transaction(
      'rw',
      [db.carvingReturns, db.blocks, db.nodes, db.carvers, db.drafts, db.batches],
      async () => {
        // 事务内复查：同一版片只允许首条回执生效，重复消息仅留来源。
        const alreadyApplied = await db.carvingReturns
          .where('blockId')
          .equals(block.id)
          .filter((item) => item.applied)
          .count()
        if (alreadyApplied > 0) {
          await db.carvingReturns.add({
            id: returnId,
            draftId: draft.id,
            blockId: block.id,
            source: parsed.source,
            payloadText: '',
            receivedAt: new Date().toISOString(),
            applied: false,
          })
          txResult.duplicateId = returnId
          return
        }

        await db.carvingReturns.add({
          id: returnId,
          draftId: draft.id,
          blockId: block.id,
          source: parsed.source,
          payloadText: rawText,
          receivedAt: new Date().toISOString(),
          applied: true,
          stage: stageFromState(state),
          printQty: parsed.printQty ?? undefined,
          defectNote: parsed.defectNote || undefined,
        })

        const blockChanges: Partial<Block> = { state, sourceMode: 'outsource' }
        if (parsed.defectNote) blockChanges.defectNote = parsed.defectNote
        await db.blocks.update(block.id, blockChanges)

        const existingNodes = await db.nodes.where('blockId').equals(block.id).toArray()
        const stagedNodes = new Set(existingNodes.map((node) => node.stage))
        let nextSeq = existingNodes.reduce((max, node) => Math.max(max, node.seq), 0)
        for (const nodeInput of parsed.nodes) {
          if (stagedNodes.has(nodeInput.stage)) continue
          nextSeq += 1
          await db.nodes.add({
            id: `node-${crypto.randomUUID()}`,
            blockId: block.id,
            stage: nodeInput.stage,
            seq: nextSeq,
            operator: nodeInput.operator,
            startedAt: nodeInput.startedAt,
            durationMin: nodeInput.durationMin,
            note: nodeInput.note,
          })
          stagedNodes.add(nodeInput.stage)
        }

        if (state === '已刻成' || state === '已修版') {
          const carvers = await db.carvers.toArray()
          for (const carver of carvers) {
            if (!carver.activeBlockIds.includes(block.id)) continue
            await db.carvers.update(carver.id, {
              activeBlockIds: carver.activeBlockIds.filter((id) => id !== block.id),
            })
          }
        }

        const draftBlocks = await db.blocks.where('draftId').equals(draft.id).toArray()
        const allDone = draftBlocks.every((item) => item.state === '已刻成' || item.state === '已修版')
        if (allDone) {
          await db.drafts.update(draft.id, { status: '可印' })
        } else if (draft.status !== '可印') {
          await db.drafts.update(draft.id, { status: '刻版中' })
        }

        const appliedReturns = await db.carvingReturns.where('draftId').equals(draft.id).toArray()
        const assessment = await assessAutoBatch(draft.id, appliedReturns)
        const existingAutoBatch = await db.batches.get(autoBatchId(draft.id))
        if (assessment.batch && !existingAutoBatch) {
          await db.batches.add(assessment.batch)
          txResult.batch = assessment.batch
        } else if (assessment.pendingReason) {
          txResult.pendingReason = assessment.pendingReason
        }
      },
    )
  } catch (error) {
    // 本事务整体回滚：本条回传未落库，可直接重试；此前已通过的回传不受影响。
    await load()
    return {
      ok: false,
      message: `写入失败（${error instanceof Error ? error.message : '本地档案库异常'}），已通过的回传仍保留，请重试。`,
      issues,
      createdReturnId: null,
      applied: false,
      batchNo: null,
    }
  }

  await load()

  if (txResult.duplicateId) {
    return {
      ok: true,
      message: `${block.blockName}已有首条生效回传，本条重复消息仅登记来源「${parsed.source}」，状态、崩口与工序节点均不再改写，进度不重复计算。`,
      issues,
      createdReturnId: txResult.duplicateId,
      applied: false,
      batchNo: null,
    }
  }

  const warnings = issues.filter((issue) => issue.level === 'warning')
  const generatedBatch = txResult.batch
  let message = `${draft.title} · ${block.blockName}回传已落库：状态更新为${state}`
  if (parsed.defectNote) message += '，崩口已登记'
  if (parsed.nodes.length > 0) message += `，工序节点 ${parsed.nodes.map((node) => node.stage).join('、')} 已补登`
  if (generatedBatch) {
    message += `；各色版均已回传，本坊已生成正式批次「${generatedBatch.batchNo}」，印数 ${generatedBatch.qty}（取各版最小数）`
  } else if (txResult.pendingReason) {
    message += `；${txResult.pendingReason}`
  } else if (warnings.length > 0) {
    message += `；${issueMessage(warnings)}`
  }

  return {
    ok: true,
    message,
    issues,
    createdReturnId: returnId,
    applied: true,
    batchNo: generatedBatch?.batchNo ?? null,
  }
}

export const returnStore = {
  subscribe: returnList.subscribe,
  returnsByBlock,
  load,
  ingest,
}
