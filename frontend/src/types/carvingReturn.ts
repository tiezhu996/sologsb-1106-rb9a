import type { ProcessStage } from './node'

/** 外协刻坊回传的一条版片雕完结果。 */
export interface CarvingReturn {
  id: string
  draftId: string
  blockId: string
  source: string
  payloadText: string
  receivedAt: string
  /** 首条通过落库的回传才会更新版片，重复消息仅保留来源。 */
  applied: boolean
  stage?: ProcessStage
  printQty?: number
  defectNote?: string
}

/** 回传文本中的工序节点，仅首条回传携带时登记。 */
export interface CarvingReturnNodeInput {
  stage: ProcessStage
  operator: string
  startedAt: string
  durationMin: number
  note: string
}

export interface ParsedCarvingReturn {
  draftRef: string
  blockRef: string
  stateText: string
  source: string
  defectNote: string
  printQty: number | null
  nodes: CarvingReturnNodeInput[]
}

export type ReturnIssueLevel = 'error' | 'warning'

export interface ReturnIssue {
  level: ReturnIssueLevel
  message: string
}

export interface IngestReturnResult {
  ok: boolean
  message: string
  issues: ReturnIssue[]
  createdReturnId: string | null
  applied: boolean
  /** 全部色版齐备时由本坊生成的正式印制批次号。 */
  batchNo: string | null
}
