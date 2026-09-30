import type { Block } from '../types/block'
import type { Draft } from '../types/draft'
import type { CarvingReturnNodeInput, ParsedCarvingReturn, ReturnIssue } from '../types/carvingReturn'
import type { ProcessStage } from '../types/node'

const STAGES: ProcessStage[] = ['起稿', '勾描', '上样', '刻版', '修版', '调色', '套印', '晾晒']

const STATE_ALIASES: Record<string, string> = {
  已刻: '已刻成',
  刻成: '已刻成',
  刻完: '已刻成',
  雕完: '已刻成',
  雕成: '已刻成',
  完工: '已刻成',
  已刻成: '已刻成',
  已刻完成: '已刻成',
  在刻: '在刻',
  雕刻中: '在刻',
  待刻: '待刻',
  已修: '已修版',
  修版完成: '已修版',
  已修版: '已修版',
}

function normalizeValue(value: string): string {
  return value.trim().replace(/^[：:]+|[：:]+$/g, '').trim()
}

/** 支持多行「字段：值」或单行「字段=值；字段=值」两种回传文本。 */
export function parseCarvingReturn(rawText: string): { parsed: ParsedCarvingReturn | null; issues: ReturnIssue[] } {
  const issues: ReturnIssue[] = []
  const text = rawText.trim()
  if (!text) {
    return { parsed: null, issues: [{ level: 'error', message: '回传文本为空，无法接收。' }] }
  }

  const lines = text
    .split(/\r?\n|；|;/)
    .map((line) => line.trim())
    .filter(Boolean)

  const fields: Record<string, string> = {}
  for (const line of lines) {
    const match = line.match(/^([^：:=]+)[：:=](.+)$/)
    if (!match) {
      issues.push({ level: 'warning', message: `未能识别的一行已忽略：${line}` })
      continue
    }
    const key = match[1]?.trim() ?? ''
    const value = match[2]?.trim() ?? ''
    if (key) fields[key] = value
  }

  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      if (fields[key] !== undefined) return normalizeValue(fields[key] ?? '')
    }
    return ''
  }

  const draftRef = pick('画稿', '画稿名称', '画题', '画稿编号', 'draft')
  const blockRef = pick('版片', '版片名称', '色版', '色序', '版片编号', 'block')
  if (!draftRef) issues.push({ level: 'error', message: '缺少「画稿」字段，无法按画稿定位。' })
  if (!blockRef) issues.push({ level: 'error', message: '缺少「版片」或「色序」字段，无法按版片定位。' })

  const stateText = pick('状态', '刻制状态', '雕刻状态', 'result')
  const source = pick('来源', '回执来源', '回传来源', '外协', 'source', '消息编号', '批次号')
  if (!source) issues.push({ level: 'warning', message: '未注明来源或消息编号，已按「未具名回执」留档。' })

  const defectNote = pick('崩口', '崩口说明', '修补', '修补说明', '缺陷', 'defect')
  const qtyText = pick('印数', '可印数', '建议印数', '数量', 'qty')
  let printQty: number | null = null
  if (qtyText) {
    const qty = Number(qtyText.replace(/[^0-9]/g, ''))
    if (Number.isFinite(qty) && qty > 0) {
      printQty = qty
    } else {
      issues.push({ level: 'warning', message: `印数「${qtyText}」无法识别，已忽略。` })
    }
  }

  const nodes: CarvingReturnNodeInput[] = []
  const nodeSection = pick('工序节点', '工序', '节点', 'nodes')
  if (nodeSection) {
    const parts = nodeSection
      .split(/[,，、/]+/)
      .map((part) => part.trim())
      .filter(Boolean)
    for (const part of parts) {
      const stage = STAGES.find((item) => part.includes(item))
      if (!stage) {
        issues.push({ level: 'warning', message: `工序节点「${part}」不在既有工序中，已忽略。` })
        continue
      }
      nodes.push({
        stage,
        operator: source || '外协刻坊',
        startedAt: new Date().toISOString().slice(0, 16),
        durationMin: 0,
        note: `外协回传：${part}`,
      })
    }
  }

  const hasBlockingError = issues.some((issue) => issue.level === 'error')
  if (hasBlockingError) return { parsed: null, issues }

  return {
    parsed: {
      draftRef,
      blockRef,
      stateText,
      source: source || '未具名回执',
      defectNote,
      printQty,
      nodes,
    },
    issues,
  }
}

export function normalizeStateText(stateText: string): Block['state'] | null {
  const normalized = stateText.trim()
  if (!normalized) return null
  if (STATE_ALIASES[normalized]) return STATE_ALIASES[normalized] as Block['state']
  const hit = Object.keys(STATE_ALIASES).find((alias) => normalized.includes(alias))
  return hit ? (STATE_ALIASES[hit] as Block['state']) : null
}

export function locateDraft(drafts: Draft[], ref: string): Draft | null {
  const keyword = ref.trim()
  return (
    drafts.find((draft) => draft.id === keyword || draft.title === keyword) ??
    drafts.find((draft) => draft.title.includes(keyword) || keyword.includes(draft.title)) ??
    null
  )
}

const BLOCK_NAME_KEYWORDS: Record<string, Block['blockName']> = {
  墨线: '墨线版',
  黄版: '黄版',
  黄: '黄版',
  红版: '红版',
  红: '红版',
  绿版: '绿版',
  绿: '绿版',
}

export function locateBlock(blocks: Block[], draftId: string, ref: string): Block | null {
  const keyword = ref.trim()
  const inDraft = blocks.filter((block) => block.draftId === draftId)
  const byId = inDraft.find((block) => block.id === keyword)
  if (byId) return byId

  const colorNo = Number(keyword.replace(/[^0-9]/g, ''))
  if (Number.isFinite(colorNo) && colorNo > 0) {
    const byColorNo = inDraft.find((block) => block.colorNo === colorNo)
    if (byColorNo) return byColorNo
  }

  for (const [token, blockName] of Object.entries(BLOCK_NAME_KEYWORDS)) {
    if (keyword.includes(token)) {
      const byName = inDraft.find((block) => block.blockName === blockName)
      if (byName) return byName
    }
  }
  const byExactName = inDraft.find((block) => block.blockName === keyword)
  return byExactName ?? null
}

/** 回传示例，供编排台粘贴试用。 */
export const SAMPLE_RETURN_TEXT = `画稿：秦琼敬德
版片：红版
状态：已刻成
崩口：冠缨根部浅崩一处，已嵌补平顺
印数：360
工序节点：刻版、修版
来源：西关刻坊-回执0312`
