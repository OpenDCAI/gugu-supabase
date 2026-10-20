// 结构化日志:一行一个 JSON,写 stdout(容器日志)。❌ 往字段里放令牌、口令、正文。

/** @typedef {'debug' | 'info' | 'warn' | 'error'} Level */

const ORDER = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * @param {{ level?: Level, write?: (line: string) => void }} [options]
 */
export function createLogger({ level = 'info', write = (line) => process.stdout.write(line + '\n') } = {}) {
  const min = ORDER[level] ?? ORDER.info
  /** @param {Level} lvl @param {string} msg @param {Record<string, unknown>} [fields] */
  const emit = (lvl, msg, fields) => {
    if (ORDER[lvl] < min) return
    write(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...fields }))
  }
  return {
    /** @param {string} msg @param {Record<string, unknown>} [fields] */
    debug: (msg, fields) => emit('debug', msg, fields),
    /** @param {string} msg @param {Record<string, unknown>} [fields] */
    info: (msg, fields) => emit('info', msg, fields),
    /** @param {string} msg @param {Record<string, unknown>} [fields] */
    warn: (msg, fields) => emit('warn', msg, fields),
    /** @param {string} msg @param {Record<string, unknown>} [fields] */
    error: (msg, fields) => emit('error', msg, fields),
  }
}

/** @typedef {ReturnType<typeof createLogger>} Logger */

/** 错误只记名字和消息;pg 的错误对象里可能带着参数。 */
export function errorFields(/** @type {unknown} */ error) {
  if (error instanceof Error) return { error: error.name, message: error.message, code: /** @type {any} */ (error).code }
  return { error: String(error) }
}
