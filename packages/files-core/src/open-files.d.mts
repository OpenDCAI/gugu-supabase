import type * as Y from 'yjs'

import type { Rate } from './limits.mjs'

export function readHead(bytes: Uint8Array): { type: number; syncType: number; payloadLength: number; payloadAt: number }
export function closeWith(code: number, reason: string): Error & { code: number; reason: string }

export interface OpenFilesStats {
  rateLimited: number
  tooLarge: number
  presenceCoalesced: number
  presenceFlushed: number
  concurrentMerges: { create: number; lateWrite: number }
  /** 热压缩(F71):压成的、作废的(排空超时 / 存储写不进)。 */
  hotCompactions?: number
  compactAborted?: number
}

export type DocInfo<Extra> = Extra & {
  bytes: number
  pending: number
  dirty: boolean
  /** 热压缩换代完成:这一代的文档不再存盘、不再冷压缩,连接都已关掉。 */
  compacted: boolean
  hotAt: number
  hot: unknown
}

export interface Compaction {
  /** ystate > max(ratio × 正文字节, minBytes) 才压。 */
  ratio: number
  minBytes: number
  /** 同一个文件两次尝试之间至少隔多久。 */
  cooldownMs: number
  /** 等所有连接回 drained 最多多久,超时就作废这一轮。 */
  drainMs: number
}

export interface OpenFiles<Extra extends { contentType: string }> {
  readonly docs: Map<string, DocInfo<Extra>>
  attach(document: Y.Doc, name: string, extra: Extra): string
  snapshot(name: string, document: Y.Doc): { state: Uint8Array; text: string; bytes: number; pendingAt: number }
  stored(name: string, snap: { bytes: number; pendingAt: number }): void
  compactWhenDue(
    name: string,
    document: any,
    size: { stateBytes: number; textBytes: number },
    persist: (fresh: Y.Doc) => Promise<number>,
  ): boolean
  /** Drain existing providers and replace a typed copy as a new generation; failure resumes them. */
  swapGeneration(name: string, document: any, persist: (fresh: Y.Doc) => Promise<number>): Promise<number>
  frozen(name: string): boolean
  settled(name: string): Promise<void>
  readonly hooks: {
    beforeHandleMessage(data: { connection: any; document: any; update: Uint8Array }): Promise<void>
    beforeHandleAwareness(data: { connection?: any; document: any; states: Map<number, any> }): Promise<void>
    connected(data: { connection: any; context: any; documentName: string }): Promise<void>
    onStateless(data: { connection: any; documentName: string; payload: string }): Promise<void>
    onDisconnect(data: { documentName: string }): Promise<void>
    onChange(data: { documentName: string }): Promise<void>
  }
}

export function createOpenFiles<Extra extends { contentType: string }>(options: {
  maxBytes: number
  limits: { rateUpdates: Rate; rateBytes: Rate; rateAwareness: Rate }
  log: { warn: (msg: string, fields?: object) => void; info?: (msg: string, fields?: object) => void }
  stats: OpenFilesStats
  /** 不给 = 不做热压缩。 */
  compaction?: Compaction
}): OpenFiles<Extra>
