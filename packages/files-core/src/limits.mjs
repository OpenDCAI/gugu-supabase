// 限速:每个连接(一个 socket 上的一个文件)各一组令牌桶。

export class TokenBucket {
  /** @param {{ perSecond: number, burst: number }} rate @param {() => number} [now] */
  constructor({ perSecond, burst }, now = Date.now) {
    this.perSecond = perSecond
    this.burst = burst
    this.tokens = burst
    this.now = now
    this.at = now()
  }
  /** 拿得到 cost 个令牌就扣掉并返回 true;拿不到什么也不扣。 */
  take(cost = 1) {
    const t = this.now()
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) / 1000) * this.perSecond)
    this.at = t
    if (this.tokens < cost) return false
    this.tokens -= cost
    return true
  }
}

/**
 * @param {{ rateUpdates: import('./limits.mjs').Rate, rateBytes: import('./limits.mjs').Rate, rateAwareness: import('./limits.mjs').Rate }} config
 * @param {() => number} [now]
 */
export function connectionLimits(config, now = Date.now) {
  return {
    updates: new TokenBucket(config.rateUpdates, now),
    bytes: new TokenBucket(config.rateBytes, now),
    awareness: new TokenBucket(config.rateAwareness, now),
  }
}
