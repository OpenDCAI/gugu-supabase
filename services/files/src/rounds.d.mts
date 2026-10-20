export interface Writer {
  /** Who writes: the person, or the agent a connection acts as. */
  id: string
  /** Whether it is an agent (the write carried an as-agent identity). */
  agent: boolean
}

export interface Rounds {
  /** 一笔改动就要落地:agent 那一轮的边界,或停够了,上一轮排进队列记成一版。同步返回,不等写库。 */
  before(itemId: string, writer: Writer, text: () => string, changes?: () => boolean): void
  /** 文件删了:不再记。 */
  forget(itemId: string): void
  /** 服务要停了:内存里的每一轮都当场记成一版(作者照旧),等写完。 */
  flush(): Promise<void>
  /** 内存里还留着几个文件的轮(停够 idleMs 的会在下一笔改动时拿掉)。 */
  size(): number
  /** 这个文件排着的写入都写完。 */
  settled(itemId: string): Promise<void>
}

export function createRounds(options: {
  idleMs: number
  now?: () => number
  record: (itemId: string, text: string, madeBy: string | null) => Promise<void>
  /** 一轮停够了被拿出内存时,读这个文件此刻的正文;文件没了回 null。 */
  read: (itemId: string) => string | null | Promise<string | null>
  onError?: (itemId: string, error: unknown) => void
}): Rounds
