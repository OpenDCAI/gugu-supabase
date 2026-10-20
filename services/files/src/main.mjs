// 容器入口:读配置、起服务;SIGTERM / SIGINT 时先关连接、存完没存的,再退出。

import { loadConfig } from './config.mjs'
import { createLogger, errorFields } from './log.mjs'
import { createFileService } from './files.mjs'

const config = loadConfig()
const log = createLogger({ level: config.logLevel })
const service = createFileService(config, { log })

let stopping = false
async function stop(/** @type {string} */ signal) {
  if (stopping) return
  stopping = true
  log.info('stopping', { signal })
  // 存盘失败的文档会留在内存里等重试,destroy 会一直等它;给个上限,超时就记一笔退出(库回来之前留着也存不进去)。
  const deadline = setTimeout(() => {
    log.error('shutdown timed out with unsaved documents', { documents: service.hocuspocus.getDocumentsCount() })
    process.exit(1)
  }, 20_000)
  try {
    await service.close()
    clearTimeout(deadline)
    process.exit(0)
  } catch (error) {
    log.error('shutdown failed', errorFields(error))
    process.exit(1)
  }
}
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
process.on('unhandledRejection', (error) => log.error('unhandled rejection', errorFields(error)))

try {
  await service.listen()
} catch (error) {
  log.error('failed to start', errorFields(error))
  process.exit(1)
}
