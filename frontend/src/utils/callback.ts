import type { BlockName } from '../types/block'

/** 单条外协回传解析结果 */
export interface ParsedCallback {
  draftRef: string
  colorNo: number | null
  blockName: BlockName | null
  printQty: number | null
  sourceKey: string
  defectNote: string
  receivedAt: string | null
  errors: string[]
}

/** 多条消息之间用三横线（或等号、井号）分隔，例如外部系统分次推送时 */
const MESSAGE_SPLIT = /^\s*(?:-{3,}|={3,}|#{3,})\s*$/m

const FIELD_ALIASES: Record<string, 'draftRef' | 'colorNo' | 'blockName' | 'printQty' | 'sourceKey' | 'defectNote' | 'receivedAt'> = {
  画稿: 'draftRef',
  画稿名: 'draftRef',
  画稿名称: 'draftRef',
  稿名: 'draftRef',
  色序: 'colorNo',
  序号: 'colorNo',
  色号: 'colorNo',
  版片: 'blockName',
  版名: 'blockName',
  版别: 'blockName',
  印数: 'printQty',
  印量: 'printQty',
  数量: 'printQty',
  来源: 'sourceKey',
  来源标识: 'sourceKey',
  消息号: 'sourceKey',
  批次号: 'sourceKey',
  崩口: 'defectNote',
  崩口说明: 'defectNote',
  缺陷: 'defectNote',
  修补: 'defectNote',
  回传时间: 'receivedAt',
  时间: 'receivedAt',
}

export function splitCallbackMessages(input: string): string[] {
  return input
    .split(MESSAGE_SPLIT)
    .map((message) => message.trim())
    .filter(Boolean)
}

function normalizeBlockName(value: string): BlockName | null {
  const text = value.trim()
  if (text === '墨线版' || text === '黄版' || text === '红版' || text === '绿版') return text
  if (text.includes('墨线')) return '墨线版'
  if (text.includes('黄')) return '黄版'
  if (text.includes('红')) return '红版'
  if (text.includes('绿')) return '绿版'
  return null
}

/**
 * 解析外协刻坊回传文本。每行按「字段：内容」识别，
 * 同一行内也可用中文分号串联多个字段。
 */
export function parseCallbackText(raw: string): ParsedCallback {
  const parsed: ParsedCallback = {
    draftRef: '',
    colorNo: null,
    blockName: null,
    printQty: null,
    sourceKey: '',
    defectNote: '',
    receivedAt: null,
    errors: [],
  }

  const segments = raw
    .split(/\r?\n/)
    .flatMap((line) => line.split(/[；;]/))
    .map((segment) => segment.trim())
    .filter(Boolean)

  for (const segment of segments) {
    const match = segment.match(/^([^:：]+)[：:]\s*(.*)$/)
    if (!match) continue
    const field = FIELD_ALIASES[match[1].trim()]
    const value = match[2].trim()
    if (!field || !value) continue

    if (field === 'draftRef') {
      parsed.draftRef = value
    } else if (field === 'colorNo') {
      const numberValue = Number(value.replace(/[^\d]/g, ''))
      parsed.colorNo = Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null
    } else if (field === 'blockName') {
      parsed.blockName = normalizeBlockName(value)
    } else if (field === 'printQty') {
      const numberValue = Number(value.replace(/[^\d]/g, ''))
      parsed.printQty = Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null
    } else if (field === 'sourceKey') {
      parsed.sourceKey = value
    } else if (field === 'defectNote') {
      parsed.defectNote = value
    } else {
      parsed.receivedAt = value
    }
  }

  if (!parsed.draftRef) parsed.errors.push('缺少画稿名称（如「画稿：秦琼敬德」）')
  if (parsed.colorNo === null && !parsed.blockName) parsed.errors.push('缺少可识别的色序或版片名')
  if (parsed.printQty === null) parsed.errors.push('缺少本版印数（如「印数：300」）')
  if (!parsed.sourceKey) parsed.errors.push('来源标识缺失或未识别（如「来源：外协-2603-02」）')

  return parsed
}
