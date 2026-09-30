export interface PrintBatch {
  id: string
  draftId: string
  batchNo: string
  printedAt: string
  paperBatch: string
  inkNote: string
  qty: number
  pieceCount: number
  qcNote: string
  /** 本坊手工登记为 undefined；外协各色版回传齐全后自动汇总的批次为「外协回传」 */
  source?: '外协回传'
}
