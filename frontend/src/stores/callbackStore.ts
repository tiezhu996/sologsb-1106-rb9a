import { derived, writable } from 'svelte/store'
import type { CarvingCallback } from '../types/callback'
import { db } from '../utils/db'

const callbackList = writable<CarvingCallback[]>([])

/** 按版片汇总的回传来源，首条在前；旧版片无记录即视为本坊自刻 */
const byBlock = derived(callbackList, ($callbacks) => {
  const grouped: Record<string, CarvingCallback[]> = {}
  for (const record of $callbacks) {
    const bucket = grouped[record.blockId] ?? []
    bucket.push(record)
    grouped[record.blockId] = bucket
  }
  for (const blockId of Object.keys(grouped)) {
    grouped[blockId].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt, 'zh-CN'))
  }
  return grouped
})

async function load(): Promise<void> {
  const records = await db.callbacks.toArray()
  records.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt, 'zh-CN'))
  callbackList.set(records)
}

export const callbacksByBlock = byBlock

export const callbackStore = {
  subscribe: callbackList.subscribe,
  byBlock,
  load,
}
