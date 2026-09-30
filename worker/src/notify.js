import {
  BARK_DEFAULT_URL,
  PUSHPLUS_URL,
  RESEND_URL,
  SERVERCHAN_URL,
  envStr,
  fetchWithTimeout,
  fmtTime,
  readBodyText,
} from './util.js'
import { ghCreateIssue } from './github.js'

const BARK_LEVEL_TIME_SENSITIVE = 'timeSensitive'

function siteLink(env) {
  const custom = envStr(env, 'SITE_URL')
  if (custom) return custom.replace(/\/+$/, '')
  return `https://${env.GITHUB_OWNER}.github.io/${env.GITHUB_REPO}`
}

function title(env, p) {
  if (p.kind === 'test') return '【测试】留言板通知通道自检'
  return `新留言 #${p.id}`
}

function plainBody(env, p) {
  const link = siteLink(env)
  if (p.kind === 'test') {
    return `这是一条来自留言板 Worker 的测试通知。\n时间：${p.timeText}\n后台：${link}`
  }
  return [
    `收到一条新留言（内容为端到端加密密文，需在后台用私钥查看）。`,
    `留言编号：#${p.id}`,
    `提交时间：${p.timeText}`,
    p.hasMedia ? '附件：有（视频/图片，密文）' : '附件：无',
    `查看后台：${link}`,
  ].join('\n')
}

function markdownBody(env, p) {
  const link = siteLink(env)
  if (p.kind === 'test') return `**通知通道自检**\n\n时间：${p.timeText}\n[打开后台](${link})`
  return [
    '## 新留言通知',
    '',
    `- 留言编号：\`#${p.id}\``,
    `- 提交时间：${p.timeText}`,
    `- 附件：${p.hasMedia ? '有（密文）' : '无'}`,
    '',
    `> 内容为端到端加密密文，请登录后台用私钥解密查看。`,
    '',
    `[打开留言板后台](${link})`,
  ].join('\n')
}

function emailHtml(env, p) {
  const link = siteLink(env)
  const titleText = title(env, p)
  const rows = (p.kind === 'test' ? [['类型', '通道自检']] : [
    ['留言编号', `#${p.id}`],
    ['提交时间', p.timeText],
    ['附件', p.hasMedia ? '有（密文）' : '无'],
  ])
    .map(([k, v]) => `<tr><td style="padding:6px 14px 6px 0;color:#8a93a6">${k}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`)
    .join('')
  return `<div style="font-family:-apple-system,Segoe UI,Microsoft YaHei,sans-serif;background:#f4f6fb;padding:24px">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:24px">
    <h2 style="margin:0 0 16px;font-size:19px;color:#1f2430">${titleText}</h2>
    <table style="border-collapse:collapse;font-size:14px">${rows}</table>
    <p style="font-size:13px;color:#8a93a6;line-height:1.7;margin:18px 0">
      留言正文与附件均为 AES-256-GCM 密文，服务器与仓库只保存密文，请登录后台用站长私钥解密查看。
    </p>
    <a href="${link}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-size:14px;font-weight:600">打开留言板后台</a>
  </div>
</div>`
}

const channels = {
  async github(env, p) {
    if (envStr(env, 'GITHUB_NOTIFY') === 'off') return { skipped: true, detail: 'GITHUB_NOTIFY=off' }
    const issue = await ghCreateIssue(env, title(env, p), markdownBody(env, p))
    return { detail: `issue #${issue.number}（GitHub 会按账号设置邮件通知）` }
  },

  async bark(env, p) {
    const key = envStr(env, 'BARK_KEY')
    const base = (envStr(env, 'BARK_URL') || BARK_DEFAULT_URL).replace(/\/+$/, '')
    const body = {
      title: title(env, p),
      body: plainBody(env, p),
      group: envStr(env, 'BARK_GROUP') || 'lss-board',
      isArchive: 1,
      level: p.kind === 'test' ? 'active' : BARK_LEVEL_TIME_SENSITIVE,
      sound: envStr(env, 'BARK_SOUND') || 'minuet.caf',
      url: siteLink(env),
    }
    const res = await fetchWithTimeout(`${base}/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 8000)
    if (!res.ok) throw new Error(`Bark -> ${res.status} ${await readBodyText(res)}`)
    const data = await res.json().catch(() => ({}))
    if (data.code && data.code !== 200) throw new Error(`Bark -> code ${data.code} ${data.message || ''}`)
    return { detail: `已推送到 ${base}` }
  },

  async pushplus(env, p) {
    const token = envStr(env, 'PUSHPLUS_TOKEN')
    const res = await fetchWithTimeout(PUSHPLUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        title: title(env, p),
        content: markdownBody(env, p),
        topic: envStr(env, 'PUSHPLUS_TOPIC') || undefined,
        template: 'markdown',
      }),
    }, 8000)
    if (!res.ok) throw new Error(`PushPlus -> ${res.status} ${await readBodyText(res)}`)
    const data = await res.json().catch(() => ({}))
    if (data.code && data.code !== 200) throw new Error(`PushPlus -> code ${data.code} ${data.msg || ''}`)
    return { detail: '已通过微信服务号推送' }
  },

  async serverchan(env, p) {
    const key = envStr(env, 'SERVERCHAN_KEY')
    const res = await fetchWithTimeout(`${SERVERCHAN_URL}/${encodeURIComponent(key)}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: title(env, p), desp: markdownBody(env, p) }).toString(),
    }, 8000)
    if (!res.ok) throw new Error(`Server酱 -> ${res.status} ${await readBodyText(res)}`)
    const data = await res.json().catch(() => ({}))
    const code = data.code || data.data
    if (code && Number(code) !== 0) throw new Error(`Server酱 -> code ${code} ${data.message || ''}`)
    return { detail: '已通过 Server酱 微信推送' }
  },

  async wecom(env, p) {
    const hook = envStr(env, 'WECOM_WEBHOOK')
    const res = await fetchWithTimeout(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: markdownBody(env, p) } }),
    }, 8000)
    if (!res.ok) throw new Error(`企业微信 -> ${res.status} ${await readBodyText(res)}`)
    const data = await res.json().catch(() => ({}))
    if (data.errcode && data.errcode !== 0) throw new Error(`企业微信 -> errcode ${data.errcode} ${data.errmsg || ''}`)
    return { detail: '已推送到企业微信群' }
  },

  async email(env, p) {
    const key = envStr(env, 'RESEND_API_KEY')
    const to = envStr(env, 'MAIL_TO')
    const res = await fetchWithTimeout(RESEND_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: envStr(env, 'MAIL_FROM') || '留言板 <onboarding@resend.dev>',
        to: to.split(',').map((s) => s.trim()).filter(Boolean),
        subject: title(env, p),
        html: emailHtml(env, p),
      }),
    }, 10000)
    if (!res.ok) throw new Error(`邮件 -> ${res.status} ${await readBodyText(res)}`)
    const data = await res.json().catch(() => ({}))
    return { detail: `已发邮件至 ${to}（id ${data.id || '-'}）` }
  },

  async webhook(env, p) {
    const url = envStr(env, 'WEBHOOK_URL')
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(envStr(env, 'WEBHOOK_SECRET') ? { 'X-Lss-Secret': envStr(env, 'WEBHOOK_SECRET') } : {}) },
      body: JSON.stringify({
        event: p.kind === 'test' ? 'lss.test' : 'lss.post',
        id: p.id,
        createdAt: p.createdAt,
        time: p.timeText,
        hasMedia: p.hasMedia,
        site: siteLink(env),
      }),
    }, 8000)
    if (!res.ok) throw new Error(`Webhook -> ${res.status} ${await readBodyText(res)}`)
    return { detail: `已调用 ${new URL(url).host}` }
  },
}

export const channelNames = Object.keys(channels)

export function channelStatus(env) {
  const need = {
    github: () => !envStr(env, 'GITHUB_TOKEN') ? '缺少 GITHUB_TOKEN' : envStr(env, 'GITHUB_NOTIFY') === 'off' ? '已关闭' : null,
    bark: () => (envStr(env, 'BARK_KEY') ? null : '缺少 BARK_KEY'),
    pushplus: () => (envStr(env, 'PUSHPLUS_TOKEN') ? null : '缺少 PUSHPLUS_TOKEN'),
    serverchan: () => (envStr(env, 'SERVERCHAN_KEY') ? null : '缺少 SERVERCHAN_KEY'),
    wecom: () => (envStr(env, 'WECOM_WEBHOOK') ? null : '缺少 WECOM_WEBHOOK'),
    email: () => (!envStr(env, 'RESEND_API_KEY') ? '缺少 RESEND_API_KEY' : !envStr(env, 'MAIL_TO') ? '缺少 MAIL_TO' : null),
    webhook: () => (envStr(env, 'WEBHOOK_URL') ? null : '缺少 WEBHOOK_URL'),
  }
  const out = {}
  for (const name of channelNames) {
    const missing = need[name] ? need[name]() : '未配置'
    out[name] = missing ? { ready: false, reason: missing } : { ready: true, reason: null }
  }
  return out
}

export async function notifyAll(env, payload) {
  const status = channelStatus(env)
  const targets = channelNames.filter((n) => status[n].ready)
  const p = {
    kind: payload.kind || 'post',
    id: payload.id || 'test',
    createdAt: payload.createdAt || Date.now(),
    hasMedia: !!payload.hasMedia,
  }
  p.timeText = fmtTime(p.createdAt)

  const settled = await Promise.all(
    targets.map(async (name) => {
      try {
        const r = await channels[name](env, p)
        return { channel: name, ok: true, detail: (r && r.detail) || 'ok' }
      } catch (err) {
        return { channel: name, ok: false, detail: (err && err.message) || 'unknown error' }
      }
    })
  )

  for (const r of settled) {
    console.log(`[notify:${r.channel}] ${r.ok ? 'OK' : 'FAIL'} ${r.detail}`)
  }
  return {
    sent: settled.filter((r) => r.ok).length,
    failed: settled.filter((r) => !r.ok).length,
    channels: settled,
    skipped: channelNames.filter((n) => !status[n].ready),
  }
}
