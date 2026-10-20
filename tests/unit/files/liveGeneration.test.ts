import { describe, expect, it } from 'vitest'

import { Denied } from '../../../services/files/src/auth.mjs'
import { onLiveGeneration } from '../../../services/files/src/files.mjs'

/**
 * F71 的 HTTP edit(L3 评审 #77):只写进「此刻活着的那一代」。换代中或已换走的一代(frozen)的内容已经进了下一代、存盘也跳过,
 * 写进去会回 200 而改动不见。等换代结束、在新代号上重开;连着 tries 代都冻结就 503 compacting,一处都不写。
 * 对照(变异):把「到次数就拒」改回旧循环的「到次数就照写」,第一格变红。
 */
function generations(frozenRuns: number) {
  const log: string[] = []
  let opened = 0
  return {
    log,
    steps: {
      tries: 4,
      open: async () => {
        const name = `item@${opened}`
        opened += 1
        log.push(`open ${name}`)
        return {
          name,
          write: async () => {
            log.push(`write ${name}`)
            return { status: 200, name }
          },
          close: async () => {
            log.push(`close ${name}`)
          },
        }
      },
      frozen: (name: string) => Number(name.slice(name.indexOf('@') + 1)) < frozenRuns,
      settled: async (name: string) => {
        log.push(`settled ${name}`)
      },
    },
  }
}

describe('F71 HTTP edit:只写活着的那一代', () => {
  it('连着 4 代都在换代 ⇒ 503 compacting,哪一代都没写,每一代都关了', async () => {
    const { log, steps } = generations(Number.POSITIVE_INFINITY)
    const refused = await onLiveGeneration(steps).then(
      () => null,
      (error: unknown) => error,
    )
    expect(refused).toBeInstanceOf(Denied)
    expect(refused).toMatchObject({ reason: 'compacting', status: 503 })
    expect(log.filter((line) => line.startsWith('write'))).toEqual([])
    expect(log.filter((line) => line.startsWith('open'))).toHaveLength(4)
    expect(log.filter((line) => line.startsWith('close'))).toHaveLength(4)
  })

  it('冻结两代、第三代活着 ⇒ 等每一轮换代结束,写在第三代上,恰好一次', async () => {
    const { log, steps } = generations(2)
    expect(await onLiveGeneration(steps)).toEqual({ status: 200, name: 'item@2' })
    expect(log).toEqual([
      'open item@0',
      'close item@0',
      'settled item@0',
      'open item@1',
      'close item@1',
      'settled item@1',
      'open item@2',
      'write item@2',
      'close item@2',
    ])
  })

  it('写的时候出错:照样关掉,错误原样抛出', async () => {
    const { log, steps } = generations(0)
    const open = steps.open
    steps.open = async () => ({
      ...(await open()),
      write: async () => {
        throw new Error('boom')
      },
    })
    await expect(onLiveGeneration(steps)).rejects.toThrow('boom')
    expect(log).toEqual(['open item@0', 'close item@0'])
  })
})
