export const GITHUB_API = 'https://api.github.com'
export const GITHUB_RAW = 'https://raw.githubusercontent.com'
export const BARK_DEFAULT_URL = 'https://api.day.app'
export const PUSHPLUS_URL = 'https://www.pushplus.plus/send'
export const SERVERCHAN_URL = 'https://sctapi.ftqq.com'
export const RESEND_URL = 'https://api.resend.com/emails'

export function corsHeaders(extra) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Access-Control-Max-Age': '86400',
    ...(extra || {}),
  }
}

export function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(extraHeaders),
    },
  })
}

export function bytesToBase64(bytes) {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

export function base64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function envStr(env, key) {
  const v = env[key]
  return typeof v === 'string' ? v.trim() : ''
}

export function fmtTime(ts) {
  const d = new Date(ts || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`
}

export function clip(text, max) {
  const s = String(text == null ? '' : text)
  return s.length > max ? s.slice(0, max) + '…' : s
}

export async function fetchWithTimeout(url, init, ms) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms || 8000)
  try {
    return await fetch(url, { ...(init || {}), signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function readBodyText(res) {
  try {
    return clip(await res.text(), 300)
  } catch (_) {
    return ''
  }
}

export function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    'unknown'
  )
}

export function isAdmin(request, env) {
  const token = envStr(env, 'ADMIN_TOKEN')
  if (!token) return false
  const given = request.headers.get('X-Admin-Token') || ''
  return given.length > 0 && given === token
}
