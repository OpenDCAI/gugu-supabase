// #6264 咕咕 server「链接 + 短码」登录的确认页(behavior/gugu-server.md 第 2 条)—— 只管渲染 HTML,不碰 Deno / 数据库,
// 单测直接测(tests/unit/supabase/serverLoginPage6264.test.ts)。视觉沿用咕咕别的网页(pay-return)同一套:
// 浅/深两套底色、14px 圆角卡片、药丸按钮、系统字体;❌ 另起一套视觉。
//
// 页面要让一个非工程师在手机上三步走完:核对机器 → 邮箱验证码 → 完成;每一步都说清「这是哪台机器、我在允许什么」,
// 并防钓鱼:机器信息摆在「允许」按钮正上方,写明只有自己刚在那台机器上执行了登录才点允许。

export type MachineInfo = {
  hostname?: string
  platform?: string
  arch?: string
  user?: string
  version?: string
  /** #6264 与设备行同一个机器标识;只用来判机器上限,❌ 展示。 */
  machine_id?: string
}

/** #6264 登录因机器上限被拒时库给的原因(迁移 *_machine_limits_6264 的 gugu_machine_limit_refusal)。 */
export type MachineLimitRefusal = { limit: 'total' | 'tunnel'; used: number; max: number; plan?: string }

/**
 * 机器上限的那句人话:哪条上限、已经用了几台。平时不披露上限,只在碰到时说(owner 2026-09-24)。
 * 与客户端 packages/core/src/cloud/machineLimit.ts 同一套措辞。
 */
export function machineLimitMessage(refusal: MachineLimitRefusal | null | undefined): string {
  if (refusal?.limit === 'tunnel') {
    return `经咕咕云连接（远程隧道）的咕咕 server 最多 ${refusal.max} 台，你已经连了 ${refusal.used} 台。从咕咕桌面用远程 SSH 添加的机器不占这个名额。`
  }
  if (refusal?.limit === 'total') {
    return `你的账号最多连 ${refusal.max} 台咕咕 server，已经连了 ${refusal.used} 台。`
  }
  return '你的账号连的咕咕 server 已经到上限了。'
}
export type LoginView = { machine: MachineInfo; requester_ip: string | null; status: string; created_at: string; expires_at: string }

/** 一条请求此刻在哪一步。网页的结局页与咕咕 App 的批准页按同一个判断分,❌ 各判各的。 */
export type RequestState = 'pending' | 'approved' | 'denied' | 'refused' | 'expired'

export function requestState(view: LoginView, now = Date.now()): RequestState {
  if (view.status === 'approved' || view.status === 'consumed') return 'approved'
  if (view.status === 'denied') return 'denied'
  if (view.status === 'refused') return 'refused'
  if (new Date(view.expires_at).getTime() <= now) return 'expired'
  return 'pending'
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** 人手敲的短码:大小写、空格、横线都容忍;8 位 → `ABCD-EFGH`,否则空串。 */
export function normalizeUserCode(value: string | null | undefined): string {
  const raw = (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : ''
}

const PLATFORM_LABEL: Record<string, string> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' }

/** 服务端先写一个 UTC 的兜底,浏览器里的小脚本再换成看的人自己的时区与「几分钟前」。 */
function timeTag(iso: string, kind: 'ago' | 'left'): string {
  const date = new Date(iso)
  const fallback = Number.isNaN(date.getTime()) ? '' : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
  return `<time datetime="${escapeHtml(iso)}" data-${kind}>${escapeHtml(fallback)}</time>`
}

export function machineCard(view: LoginView, userCode: string): string {
  const m = view.machine ?? {}
  const rows: Array<[string, string | undefined, boolean?]> = [
    ['机器名', m.hostname ? escapeHtml(m.hostname) : undefined],
    ['系统', [PLATFORM_LABEL[m.platform ?? ''] ?? m.platform, m.arch].filter(Boolean).map((v) => escapeHtml(v!)).join(' · ') || undefined],
    ['系统用户', m.user ? escapeHtml(m.user) : undefined],
    ['从这个地址发起', view.requester_ip ? escapeHtml(view.requester_ip) : undefined],
    ['发起时间', timeTag(view.created_at, 'ago')],
    ['短码', `<span class="code">${escapeHtml(userCode)}</span>`],
  ]
  return `<dl class="machine">${rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('')}</dl>`
}

const STEPS = ['核对机器', '邮箱验证', '完成']

function stepper(current: 1 | 2 | 3): string {
  return `<ol class="steps" aria-label="进度">${STEPS.map(
    (label, i) =>
      `<li class="${i + 1 < current ? 'done' : i + 1 === current ? 'now' : ''}"${i + 1 === current ? ' aria-current="step"' : ''}><span>${i + 1}</span>${label}</li>`,
  ).join('')}</ol>`
}

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  background:#fafafa;color:#18181b;padding:24px 16px}
.wrap{max-width:420px;width:100%}
.brand{font-size:13px;font-weight:600;opacity:.55;margin:0 0 10px 4px;letter-spacing:.02em}
.card{background:#fff;border-radius:14px;padding:28px 24px;
  box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06)}
h1{font-size:19px;margin:0 0 12px;line-height:1.4}
h1.ok{color:#16a34a}h1.bad{color:#dc2626}h1.warn{color:#d97706}
p{margin:0 0 12px;opacity:.85}
.steps{display:flex;gap:6px;list-style:none;margin:0 0 18px;padding:0;font-size:13px}
.steps li{flex:1;display:flex;align-items:center;gap:6px;opacity:.45}
.steps li span{display:inline-flex;width:18px;height:18px;border-radius:50%;align-items:center;justify-content:center;
  background:#e4e4e7;font-weight:600;font-size:11px;flex-shrink:0}
.steps li.now,.steps li.done{opacity:1}
.steps li.now span{background:#18181b;color:#fff}
.steps li.done span{background:#16a34a;color:#fff}
.machine{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:14px 0 16px;padding:14px;border-radius:10px;
  background:#f4f4f5;font-size:14px}
.machine dt{opacity:.6}.machine dd{margin:0;font-weight:500;word-break:break-all}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;padding:1px 5px;border-radius:5px;background:#f4f4f5}
.warn{font-size:13px;padding:10px 12px;border-radius:8px;background:#fff7e6;color:#8a5a00;margin-bottom:16px}
.note{font-size:13px;opacity:.65;margin:10px 0 0}
label{display:block;font-size:13px;opacity:.7;margin:8px 0 4px}
input{width:100%;font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #d4d4d8;background:transparent;color:inherit}
input:focus{outline:none;border-color:#18181b;box-shadow:0 0 0 3px rgba(24,24,27,.12)}
input.code{text-transform:uppercase;font-size:18px;text-align:center}
input.otp{font-size:20px;letter-spacing:.3em;text-align:center}
button,.btn{font:inherit;font-weight:500;min-height:44px;padding:0 18px;border-radius:999px;border:0;cursor:pointer;
  margin-top:14px;display:inline-flex;align-items:center;justify-content:center;text-decoration:none}
button[disabled]{opacity:.6;cursor:default}
.primary{background:#18181b;color:#fff;width:100%}
.ghost{background:transparent;color:inherit;opacity:.7;width:100%;margin-top:6px}
.links{display:flex;justify-content:space-between;gap:12px;margin-top:10px;font-size:13px}
.links a,.links button{color:inherit;opacity:.7;background:none;border:0;padding:0;margin:0;min-height:0;font-size:13px;text-decoration:underline}
.err{color:#b91c1c;font-size:14px;margin-bottom:10px}
.ok-note{color:#15803d;font-size:14px;margin-bottom:10px}
@media (prefers-color-scheme:dark){body{background:#18181b;color:#fafafa}.card{background:#27272a}
  .machine,code{background:#3f3f46}.warn{background:#3b2f14;color:#f5c26b}.primary{background:#fafafa;color:#18181b}
  .steps li span{background:#3f3f46}.steps li.now span{background:#fafafa;color:#18181b}
  input{border-color:#52525b}input:focus{border-color:#fafafa;box-shadow:0 0 0 3px rgba(250,250,250,.15)}
  .err{color:#f87171}.ok-note{color:#4ade80}}
`

// 两件小事交给浏览器:把时间换成看的人自己的时区(「3 分钟前」「还剩 12 分钟」),提交后按钮变灰防止连点。
const SCRIPT = `
(function(){
  var now=Date.now();
  document.querySelectorAll('time[data-ago]').forEach(function(t){
    var d=new Date(t.getAttribute('datetime'));if(isNaN(d))return;
    var m=Math.max(0,Math.round((now-d)/60000));
    t.textContent=d.toLocaleString(undefined,{hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})+(m<1?' · 刚刚':' · '+m+' 分钟前');
  });
  document.querySelectorAll('[data-left]').forEach(function(t){
    var d=new Date(t.getAttribute('datetime'));if(isNaN(d))return;
    var m=Math.ceil((d-now)/60000);t.textContent=m>0?'还剩 '+m+' 分钟':'已过期';
  });
  document.querySelectorAll('form').forEach(function(f){
    f.addEventListener('submit',function(e){
      var b=e.submitter||f.querySelector('button[type=submit]');
      if(b&&b.dataset.busy){setTimeout(function(){b.disabled=true;b.textContent=b.dataset.busy},0)}
    });
  });
})();
`

export function page(title: string, inner: string, step?: 1 | 2 | 3): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · 咕咕</title><style>${STYLE}</style></head>
<body><main class="wrap"><div class="brand">咕咕 · 服务器登录</div><div class="card">${step ? stepper(step) : ''}${inner}</div></main>
<script>${SCRIPT}</script></body></html>`
}

function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`
}

function denyForm(userCode: string): string {
  return `<form method="post">${hidden('action', 'deny')}${hidden('code', userCode)}
<button class="ghost" type="submit" data-busy="正在拒绝…">不是我发起的，拒绝</button></form>`
}

const WARNING = `<div class="warn">只有当你自己<b>刚刚</b>在这台机器上执行了咕咕 server 的安装或 <code>gugu-server login</code>，才点「允许」。
别人发给你的链接或短码，一律拒绝 —— 允许之后，这台机器就能以你的身份运行智能体、使用你的额度。</div>`

/** 没带短码、或短码不对:让人把终端里的短码敲进来。 */
export function codeEntryStep(input = '', error?: string): string {
  return page('输入短码', `<h1>输入终端里的短码</h1>
<p>在服务器上安装咕咕 server（或执行 <code>gugu-server login</code>）后，终端里会打出一串短码，形如 <span class="code">ABCD-EFGH</span>。</p>
${error ? `<div class="err" role="alert">${escapeHtml(error)}</div>` : ''}
<form method="get">
<label for="code">短码</label>
<input id="code" class="code" name="code" value="${escapeHtml(input)}" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" required autofocus placeholder="ABCD-EFGH">
<button class="primary" type="submit">下一步</button></form>`)
}

export function emailStep(view: LoginView, userCode: string, error?: string): string {
  return page('允许一台服务器登录', `<h1>一台服务器请求登录你的咕咕账号</h1>
${machineCard(view, userCode)}${WARNING}${error ? `<div class="err" role="alert">${escapeHtml(error)}</div>` : ''}
<form method="post">${hidden('action', 'send-code')}${hidden('code', userCode)}
<label for="email">你的咕咕登录邮箱</label>
<input id="email" name="email" type="email" autocomplete="email" inputmode="email" required autofocus>
<button class="primary" type="submit" data-busy="正在发送…">发送验证码</button></form>${denyForm(userCode)}
<p class="note">短码有效期：<time datetime="${escapeHtml(view.expires_at)}" data-left>15 分钟</time>。</p>`, 1)
}

export function otpStep(view: LoginView, userCode: string, email: string, options: { error?: string; resent?: boolean } = {}): string {
  const host = view.machine?.hostname ?? '这台机器'
  return page('允许一台服务器登录', `<h1>输入邮箱里的验证码</h1>
<p>验证码已发到 <b>${escapeHtml(email)}</b>。</p>
${options.resent ? '<div class="ok-note" role="status">已重新发送，请查收最新的那封邮件。</div>' : ''}
${options.error ? `<div class="err" role="alert">${escapeHtml(options.error)}</div>` : ''}
${machineCard(view, userCode)}
<form method="post">${hidden('action', 'approve')}${hidden('code', userCode)}${hidden('email', email)}
<label for="otp">验证码</label>
<input id="otp" class="otp" name="otp" inputmode="numeric" pattern="[0-9]*" maxlength="10" autocomplete="one-time-code" required autofocus>
<button class="primary" type="submit" data-busy="正在确认…">允许 ${escapeHtml(host)} 登录</button></form>
<div class="links"><form method="post">${hidden('action', 'send-code')}${hidden('code', userCode)}${hidden('email', email)}${hidden('resend', '1')}
<button type="submit">没收到？重新发送</button></form><a href="?code=${encodeURIComponent(userCode)}">换一个邮箱</a></div>
${denyForm(userCode)}`, 2)
}

export type FinalKind = 'approved' | 'alreadyApproved' | 'denied' | 'expired' | 'failed' | 'error' | 'machineLimit'

export function finalPage(kind: FinalKind, hostname?: string, refusal?: MachineLimitRefusal | null): string {
  const host = escapeHtml(hostname || '这台服务器')
  const content: Record<FinalKind, { title: string; tone: 'ok' | 'bad' | 'warn'; body: string; step?: 3 }> = {
    approved: {
      title: '已允许',
      tone: 'ok',
      body: `${host} 会在几秒内完成登录，之后出现在咕咕的设备列表和「在哪跑」里。可以关掉这个页面，回到服务器终端看结果。`,
      step: 3,
    },
    alreadyApproved: { title: '已经允许过了', tone: 'ok', body: '这台服务器已经完成登录，可以关掉这个页面。', step: 3 },
    denied: { title: '已拒绝', tone: 'bad', body: '这次登录请求已被拒绝，那台机器不会登上你的账号。' },
    expired: {
      title: '短码已过期',
      tone: 'warn',
      body: '短码 15 分钟内有效。回到服务器，重新执行 <code>gugu-server login</code>，用新打出来的链接再来一次。',
    },
    failed: {
      title: '没能完成',
      tone: 'warn',
      body: '这次请求已经失效。回到服务器，重新执行 <code>gugu-server login</code>，用新打出来的链接再来一次。',
    },
    error: { title: '出错了', tone: 'bad', body: '暂时没法处理这次请求，请稍后刷新重试。' },
    machineLimit: {
      title: '机器数到上限了',
      tone: 'warn',
      body:
        `${escapeHtml(machineLimitMessage(refusal))}${host} 这次没有登上你的账号。` +
        '在咕咕桌面「设置 → 设备」里移除一台不用的机器，或在「设置 → 会员与额度」升级会员，' +
        '然后回到服务器重新执行 <code>gugu-server login</code>。',
    },
  }
  const c = content[kind]
  return page(c.title, `<h1 class="${c.tone}">${c.title}</h1><p>${c.body}</p>`, c.step)
}
