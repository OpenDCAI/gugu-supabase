import type { Pool } from 'pg'
import type { Hocuspocus } from '@hocuspocus/server'
import type { FilesConfig } from './config.mjs'
import type { Logger } from './log.mjs'

export interface FilesStats {
  startedAt: string
  loads: number
  builtFromText: number
  loadMismatch: number
  stores: number
  storeBytes: number
  storeErrors: number
  storeLost: number
  unloads: number
  compactions: number
  hotCompactions: number
  compactAborted: number
  rejects: Record<string, number>
  edits: { ok: number; rejected: number }
  reads: number
  kicks: { removed: number; deleted: number }
  rateLimited: number
  tooLarge: number
  presenceCoalesced: number
  presenceFlushed: number
  concurrentMerges: { create: number; lateWrite: number }
  listenerReconnects: number
  versions: { recorded: number; errors: number; storeWaitTimeouts: number }
}

export interface FileService {
  readonly stats: FilesStats
  readonly pool: Pool
  readonly hocuspocus: Hocuspocus
  listen(): Promise<{ port: number; adminPort: number }>
  close(): Promise<void>
}

export function parseDocName(name: string): { itemId: string; epoch: number } | null
/** An HTTP edit on the generation there is now (F71): frozen `tries` times running ⇒ `Denied('compacting', 503)`. */
export function onLiveGeneration<T>(steps: {
  tries: number
  open: () => Promise<{ name: string; write: () => Promise<T>; close: () => Promise<unknown> }>
  frozen: (name: string) => boolean
  settled: (name: string) => Promise<unknown>
}): Promise<T>
export function createFileService(config: FilesConfig, deps: { log: Logger; pool?: Pool }): FileService
