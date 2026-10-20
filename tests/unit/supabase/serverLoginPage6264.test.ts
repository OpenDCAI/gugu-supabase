// #6264 咕咕 server「链接 + 短码」登录的确认页:三步(核对机器 → 邮箱验证 → 完成)、防钓鱼提示、转义、没带短码时让人输入。
import { describe, expect, it } from 'vitest'
import {
  codeEntryStep,
  emailStep,
  finalPage,
  machineCard,
  machineLimitMessage,
  normalizeUserCode,
  otpStep,
  requestState,
  type LoginView,
} from '../../../supabase/functions/server-login/page'

const view: LoginView = {
  machine: { hostname: 'gpu-01<script>', platform: 'linux', arch: 'x64', user: 'alice' },
  requester_ip: '203.0.113.7',
  status: 'pending',
  created_at: '2026-09-23T10:00:00.000Z',
  expires_at: '2026-09-23T10:15:00.000Z',
}

describe('server-login 确认页', () => {
  it('短码容忍大小写、空格、横线', () => {
    expect(normalizeUserCode(' abcd efgh ')).toBe('ABCD-EFGH')
    expect(normalizeUserCode('ABCD-EFG')).toBe('')
  })

  it('机器卡片把机器名、系统、用户、来源地址、时间、短码摆清楚,内容一律转义', () => {
    const card = machineCard(view, 'ABCD-EFGH')
    expect(card).toContain('gpu-01&lt;script&gt;')
    expect(card).not.toContain('<script>')
    expect(card).toContain('Linux · x64')
    expect(card).toContain('203.0.113.7')
    expect(card).toContain('datetime="2026-09-23T10:00:00.000Z"')
    expect(card).toContain('2026-09-23 10:00 UTC')
    expect(card).toContain('ABCD-EFGH')
  })

  it('第一步:进度在「核对机器」,防钓鱼提示在按钮之前,可以拒绝', () => {
    const html = emailStep(view, 'ABCD-EFGH')
    expect(html).toContain('aria-current="step"><span>1</span>核对机器')
    expect(html.indexOf('别人发给你的链接或短码，一律拒绝')).toBeLessThan(html.indexOf('发送验证码'))
    expect(html).toContain('不是我发起的，拒绝')
    expect(html).toContain('data-left')
  })

  it('第二步:允许按钮写明是哪台机器;能重新发送、换邮箱', () => {
    const html = otpStep(view, 'ABCD-EFGH', 'me@x.y', { resent: true })
    expect(html).toContain('aria-current="step"><span>2</span>邮箱验证')
    expect(html).toContain('允许 gpu-01&lt;script&gt; 登录')
    expect(html).toContain('已重新发送')
    expect(html).toContain('没收到？重新发送')
    expect(html).toContain('href="?code=ABCD-EFGH"')
    expect(html).toContain('autocomplete="one-time-code"')
  })

  it('没带短码 / 短码不对:让人把终端里的短码输进来', () => {
    const html = codeEntryStep('zzz"><b>', '没有找到这个短码。')
    expect(html).toContain('<form method="get">')
    expect(html).toContain('value="zzz&quot;&gt;&lt;b&gt;"')
    expect(html).toContain('没有找到这个短码。')
  })

  it('结局页:允许 / 拒绝 / 过期各说清下一步', () => {
    expect(finalPage('approved', 'gpu-01')).toContain('gpu-01 会在几秒内完成登录')
    expect(finalPage('approved', 'gpu-01')).toContain('aria-current="step"><span>3</span>完成')
    expect(finalPage('denied')).toContain('那台机器不会登上你的账号')
    expect(finalPage('expired')).toContain('<code>gugu-server login</code>')
  })

  it('机器上限:只在碰到时说,说清是哪条上限、用了几台、下一步去哪', () => {
    const tunnel = finalPage('machineLimit', 'gpu-01<b>', { limit: 'tunnel', used: 3, max: 3 })
    expect(tunnel).toContain('机器数到上限了')
    expect(tunnel).toContain('远程隧道')
    expect(tunnel).toContain('最多 3 台，你已经连了 3 台')
    expect(tunnel).toContain('远程 SSH 添加的机器不占这个名额')
    expect(tunnel).toContain('gpu-01&lt;b&gt; 这次没有登上你的账号')
    expect(tunnel).toContain('设置 → 设备')
    expect(tunnel).toContain('设置 → 会员与额度')
    expect(machineLimitMessage({ limit: 'total', used: 10, max: 10 })).toBe('你的账号最多连 10 台咕咕 server，已经连了 10 台。')
    // 重新打开链接时库里只剩 refused 这个状态:没有数字也要说清是上限。
    expect(finalPage('machineLimit')).toContain('已经到上限了')
  })

  it('机器卡片不展示 machine_id(只用来判上限)', () => {
    const card = machineCard({ ...view, machine: { ...view.machine, machine_id: 'abc123machine' } }, 'ABCD-EFGH')
    expect(card).not.toContain('abc123machine')
  })
})

describe('server-login 请求此刻在哪一步(确认页与咕咕 App 共用)', () => {
  const before = new Date('2026-09-23T10:05:00.000Z').getTime()
  const after = new Date('2026-09-23T10:20:00.000Z').getTime()

  it('pending 且没过期才能批;过期按时间判,不等库里改状态', () => {
    expect(requestState(view, before)).toBe('pending')
    expect(requestState(view, after)).toBe('expired')
  })

  it('已批准 / 已领取都算已批准;拒绝、超上限照库里的状态,与过没过期无关', () => {
    expect(requestState({ ...view, status: 'approved' }, after)).toBe('approved')
    expect(requestState({ ...view, status: 'consumed' }, before)).toBe('approved')
    expect(requestState({ ...view, status: 'denied' }, before)).toBe('denied')
    expect(requestState({ ...view, status: 'refused' }, after)).toBe('refused')
  })
})
