/** 外协刻坊回传的版片雕完结果 */
export interface CarvingCallback {
  id: string
  draftId: string
  blockId: string
  /** 外协消息自带的批次/来源标识，同版片重复回传据此去重 */
  sourceKey: string
  sourceText: string
  receivedAt: string
  /** 首条回传已据此更新版片状态、崩口与工序节点 */
  applied: boolean
  /** 本次外协实际完成印数（版片可承载的印制数量） */
  printQty: number
  note: string
}
