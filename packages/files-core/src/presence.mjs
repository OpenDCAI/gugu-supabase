// presence 的身份:章由服务(远端的文件服务、桌面的本地服务)按连接身份盖,页面 ❌ 自己算颜色(F9:两份真源会分叉)。

/** presence 的颜色:按 userId 确定性生成,同一个人在哪台机器上都是同一个颜色。 */
export function colorFor(/** @type {string} */ userId) {
  let h = 0x811c9dc5
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return hslToHex(h % 360, 65, 45)
}

/** @param {number} h @param {number} s @param {number} l */
function hslToHex(h, s, l) {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100)
  const f = (/** @type {number} */ n) => {
    const k = (n + h / 30) % 12
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/**
 * 连接身份的章:presence 盖章和发给页面的 `{"t":"self"}` 都只用这一份。
 * @param {{ actorId: string, actorName: string, color: string }} ctx
 */
export const stampOf = (ctx) => ({ id: ctx.actorId, name: ctx.actorName, color: ctx.color })
