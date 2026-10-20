export interface Rate {
  perSecond: number
  burst: number
}

export class TokenBucket {
  constructor(rate: Rate, now?: () => number)
  take(cost?: number): boolean
}
export function connectionLimits(
  config: { rateUpdates: Rate; rateBytes: Rate; rateAwareness: Rate },
  now?: () => number,
): { updates: TokenBucket; bytes: TokenBucket; awareness: TokenBucket }
