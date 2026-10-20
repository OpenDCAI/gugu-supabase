// 文本文件的「一轮」(咕咕 G2;方案 gugu-base notes/2026-10-10-ppt-office/演示稿-设计说明.html §8,规则 144 10-11 02:23 定):
// 每一轮留一版历史,人手改和 agent 改在同一条历史里。只在两种时候切:
//   · agent 那一轮的边界:agent 开始改、改完了(换成了人),或者换了另一个 agent —— AI 的每一轮单独成一版,能对比、能回滚;
//   · 任何人停了 idleMs(30 s)再改。
// 人和人之间换手不切:几个人一起打字时,按停顿分版。谁是 agent 由写入带的 as-agent 身份定(调用方传 writer.agent)。
//
// 一轮结束时记下「这一轮改完的样子」,作者是这一轮最后改的那一位:在下一轮的第一笔改动落地之前(before),
// 那时文件就是上一轮改完的样子 —— 正文在这一刻同步读出。还没结束的那一轮就是文件现在的样子,不在历史里。
// 卸载不是一轮的边界:agent 的每次 HTTP edit 改完就卸载,一轮里改五笔也还是一轮。所以一轮的状态按文件记在服务内存里,
// 跨过卸载、重新加载;删了的文件(forget)才丢。
// 内存里只留还没停够的轮:谁都停了 idleMs 的那一轮已经结束(同一条「停够就切」),下一笔改动(任何文件的)进来时把它
// 从内存里拿掉,当场记成一版 —— 作者就是这一轮最后改的那位,正文由 read() 读出(开着的文件读内存,没开的读库里存的正文;
// 停了这么久,存盘早就落了)。之后这个文件再有人改,走「服务起来后第一笔」那条路,正文和刚记的那版相同,库里不再记。
// 这样 Map 的大小只跟最近 idleMs 里改过的文件数有关,不随服务活得久而涨。
// 服务正常停下(files.mjs 的 close)时 flush:内存里的每一轮都这样当场记下,作者不丢;崩溃才走下面那条 null 的路。
// 服务起来以后某个文件的第一笔改动之前也记一次(作者不明 = null):这样从没有历史的旧文件改起,改之前的样子也在。
// 记不记、编号、只留最近 50 版、与上一版相同就不记,都在库里那一个函数(chat.files_record_version)判。
//
// 写库不在消息处理的路上:正文当场读出来,写入排进按文件串行的队列,不等它;写失败只进日志(onError),不拖慢打字。
// 「改动」要真的改了内容:一个人打开文件时页面发来的同步帧(它手里那份状态)不算 —— 只在可能换轮时才问 changes(),
// 那一问要在副本上试一次,不便宜。

/**
 * @param {{
 *   idleMs: number,
 *   now?: () => number,
 *   record: (itemId: string, text: string, madeBy: string | null) => Promise<void>,
 *   read: (itemId: string) => string | null | Promise<string | null>,
 *   onError?: (itemId: string, error: unknown) => void,
 * }} options
 */
export function createRounds({ idleMs, now = Date.now, record, read, onError = () => {} }) {
  /** @type {Map<string, { key: string, by: string, last: number }>} */
  const rounds = new Map()
  /** @type {Map<string, Promise<void>>} */
  const queues = new Map()
  let swept = now()

  /**
   * 排进这个文件的写入队列;不等它,失败只报出去。正文为 null(文件已经没了)就不记。
   * @param {string} itemId @param {string | Promise<string | null>} text @param {string | null} madeBy
   */
  const enqueue = (itemId, text, madeBy) => {
    const tail = (queues.get(itemId) ?? Promise.resolve())
      .then(async () => {
        const t = await text
        if (t !== null) await record(itemId, t, madeBy)
      })
      .catch((error) => onError(itemId, error))
    queues.set(itemId, tail)
    void tail.then(() => {
      if (queues.get(itemId) === tail) queues.delete(itemId)
    })
  }

  /** 一轮到此为止:拿出内存,按 read() 此刻的正文记成一版,作者是这一轮最后改的那位。 @param {string} itemId @param {string} by */
  const end = (itemId, by) => {
    rounds.delete(itemId)
    // 正文在这一刻开始读(不排到队列里再读):排队等的时候文件可能又被人改了。
    /** @type {Promise<string | null>} */
    let text
    try {
      text = Promise.resolve(read(itemId))
    } catch (error) {
      text = Promise.reject(error)
    }
    text.catch(() => {}) // 由队列里的 await 报出去
    enqueue(itemId, text, by)
  }

  /** 停够了的轮(除了 except 这个文件,它在 before 里照常切)当场记下。每 idleMs 最多扫一遍。 @param {number} at @param {string} except */
  const sweep = (at, except) => {
    if (at - swept < idleMs) return
    swept = at
    for (const [itemId, round] of rounds) {
      if (itemId !== except && at - round.last >= idleMs) end(itemId, round.by)
    }
  }

  return {
    /**
     * 一笔改动就要落地(writer 改的),此刻的正文由 text() 读出;changes() 说它会不会真的改内容。同步返回。
     * @param {string} itemId @param {{ id: string, agent: boolean }} writer @param {() => string} text @param {() => boolean} [changes]
     */
    before(itemId, writer, text, changes = () => true) {
      const at = now()
      sweep(at, itemId)
      const key = writer.agent ? `agent:${writer.id}` : 'people'
      const round = rounds.get(itemId)
      if (round && round.key === key && at - round.last < idleMs) {
        round.last = at
        round.by = writer.id
        return
      }
      if (!changes()) return
      const snapshot = text()
      rounds.set(itemId, { key, by: writer.id, last: at })
      enqueue(itemId, snapshot, round ? round.by : null)
    },

    /** 文件删了:不再记。 @param {string} itemId */
    forget(itemId) {
      rounds.delete(itemId)
    },

    /** 服务要停了:内存里的每一轮都当场记下(作者照旧),等它们都写完 —— 正常重启时作者不丢。 */
    async flush() {
      for (const [itemId, round] of [...rounds]) end(itemId, round.by)
      await Promise.all([...queues.values()])
    },

    /** 内存里还留着几个文件的轮。 */
    size() {
      return rounds.size
    },

    /** 这个文件排着的写入都写完(测试与收尾用)。 @param {string} itemId */
    settled(itemId) {
      return queues.get(itemId) ?? Promise.resolve()
    },
  }
}
