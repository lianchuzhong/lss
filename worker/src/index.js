import { base64ToBytes, bytesToBase64, clientIp, corsHeaders, envStr, fmtTime, isAdmin, json } from './util.js'
import { ghDelete, ghJson, ghList, ghMeta, ghPut, rawUrl, requireToken } from './github.js'
import { channelStatus, notifyAll } from './notify.js'

const RATE_DEFAULT = { max: 5, windowMs: 10 * 60 * 1000 }
const MEDIA_DEFAULT_MAX = 45 * 1024 * 1024
const ENC_MAX = 20000
const buckets = new Map()

function rateConfig(env) {
  return {
    max: Number(envStr(env, 'RATE_MAX')) || RATE_DEFAULT.max,
    windowMs: (Number(envStr(env, 'RATE_WINDOW_MIN')) || RATE_DEFAULT.windowMs / 60000) * 60000,
  }
}

function hitRate(ip, env) {
  const { max, windowMs } = rateConfig(env)
  const now = Date.now()
  const list = (buckets.get(ip) || []).filter((t) => now - t < windowMs)
  const allowed = list.length < max
  if (allowed) list.push(now)
  buckets.set(ip, list)
  if (buckets.size > 5000) buckets.clear()
  return { allowed, count: list.length, max, windowMs }
}

function mediaMax(env) {
  return Number(envStr(env, 'MEDIA_MAX_BYTES')) || MEDIA_DEFAULT_MAX
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

async function readIndex(env) {
  const idx = await ghJson(env, 'data/index.json')
  if (idx && Array.isArray(idx.posts)) return idx
  const items = await ghList(env, 'data/posts')
  const posts = []
  for (const item of items) {
    if (item.type !== 'file' || !item.name.endsWith('.json')) continue
    const p = await ghJson(env, `data/posts/${item.name}`)
    if (p && p.id) posts.push({ id: p.id, createdAt: p.createdAt, hasMedia: !!(p.media && p.media.path) })
  }
  posts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return { posts, count: posts.length }
}

async function writeIndex(env, posts) {
  await ghPut(
    env,
    'data/index.json',
    bytesToBase64(new TextEncoder().encode(JSON.stringify({ posts, count: posts.length, updatedAt: Date.now() }))),
    null,
    'update index'
  )
}

async function apiHealth(env) {
  const status = channelStatus(env)
  return json({
    ok: true,
    repo: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}@${env.GITHUB_BRANCH}`,
    time: fmtTime(Date.now()),
    mediaMaxBytes: mediaMax(env),
    rate: rateConfig(env),
    notify: status,
    notifyReady: Object.values(status).filter((s) => s.ready).length,
    adminProtected: !!envStr(env, 'ADMIN_TOKEN'),
  })
}

async function apiListPosts(request, env) {
  const url = new URL(request.url)
  const full = url.searchParams.get('full') === '1'
  const idx = await readIndex(env)
  if (!full) return json({ ok: true, count: idx.count, posts: idx.posts })

  const out = []
  for (const meta of idx.posts) {
    const p = await ghJson(env, `data/posts/${meta.id}.json`)
    if (p && p.enc) out.push({ id: p.id, enc: p.enc, media: p.media || null, createdAt: p.createdAt })
  }
  return json({ ok: true, count: out.length, posts: out })
}

async function apiCreatePost(request, env) {
  const ip = clientIp(request)
  const rate = hitRate(ip, env)
  if (!rate.allowed) {
    return json(
      { error: `提交过于频繁，请 ${Math.ceil(rate.windowMs / 60000)} 分钟后再试（单 IP 上限 ${rate.max} 条）` },
      429,
      { 'Retry-After': String(Math.ceil(rate.windowMs / 1000)) }
    )
  }

  const form = await request.formData()
  const encRaw = String(form.get('enc') || '').trim()
  const file = form.get('file')

  if (!encRaw) return json({ error: '缺少加密负载 enc' }, 400)
  if (encRaw.length > ENC_MAX) return json({ error: '加密数据过大' }, 400)
  requireToken(env)

  const limit = mediaMax(env)
  if (file && file.size && file.size > limit) {
    return json({ error: `附件过大，单个文件上限 ${Math.round(limit / 1024 / 1024)}MB` }, 413)
  }

  const id = newId()
  const createdAt = Date.now()
  let media = null

  if (file && file.size) {
    const mediaPath = `uploads/${id}.bin`
    const bytes = new Uint8Array(await file.arrayBuffer())
    await ghPut(env, mediaPath, bytesToBase64(bytes), null, `add upload ${id}`)
    media = { path: mediaPath, size: file.size }
  }

  const post = { id, enc: encRaw, media, createdAt }
  await ghPut(env, `data/posts/${id}.json`, bytesToBase64(new TextEncoder().encode(JSON.stringify(post))), null, `add post ${id}`)

  const idx = await readIndex(env)
  idx.posts.unshift({ id, createdAt, hasMedia: !!media })
  await writeIndex(env, idx.posts.slice(0, 5000))

  const notified = await notifyAll(env, { kind: 'post', id, createdAt, hasMedia: !!media })

  return json({ ok: true, id, count: idx.count + 1, notify: notified })
}

async function apiProxyMedia(request, env, pathParam) {
  const path = pathParam
  if (!path || !/^uploads\/[a-zA-Z0-9._-]+\.bin$/.test(path)) return json({ error: 'invalid path' }, 400)
  const res = await fetch(rawUrl(env, path), { headers: { 'User-Agent': 'lss-board-worker' } })
  if (res.status === 404) return json({ error: 'media not found' }, 404)
  if (!res.ok) return json({ error: 'media fetch failed' }, 502)
  const buf = await res.arrayBuffer()
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(buf.byteLength),
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...corsHeaders(),
    },
  })
}

async function apiNotifyTest(request, env) {
  if (!isAdmin(request, env)) return json({ error: '需要正确的 X-Admin-Token' }, 401)
  const result = await notifyAll(env, { kind: 'test' })
  return json({ ok: true, ...result })
}

async function apiPrune(request, env) {
  if (!isAdmin(request, env)) return json({ error: '需要正确的 X-Admin-Token' }, 401)
  const max = Number(new URL(request.url).searchParams.get('max')) || 0
  if (max < 1) return json({ error: '缺少 max 参数' }, 400)
  const idx = await readIndex(env)
  const stale = idx.posts.slice(max)
  for (const meta of stale) {
    try {
      const p = await ghJson(env, `data/posts/${meta.id}.json`)
      const postFile = await ghMeta(env, `data/posts/${meta.id}.json`)
      if (postFile && postFile.sha) await ghDelete(env, `data/posts/${meta.id}.json`, postFile.sha, `prune ${meta.id}`)
      if (p && p.media && p.media.path) {
        const uploadFile = await ghMeta(env, p.media.path)
        if (uploadFile && uploadFile.sha) await ghDelete(env, p.media.path, uploadFile.sha, `prune ${meta.id}`)
      }
    } catch (err) {
      console.log('[prune] fail', meta.id, err.message)
    }
  }
  await writeIndex(env, idx.posts.slice(0, max))
  return json({ ok: true, removed: stale.length, kept: Math.min(max, idx.posts.length) })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const method = request.method

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() })

    try {
      if (method === 'GET' && url.pathname === '/api/health') return await apiHealth(env)
      if (method === 'GET' && url.pathname === '/api/posts') return await apiListPosts(request, env)
      if (method === 'GET' && url.pathname === '/api/post') {
        const id = url.searchParams.get('id') || ''
        if (!/^[a-z0-9-]{4,40}$/i.test(id)) return json({ error: 'invalid id' }, 400)
        const p = await ghJson(env, `data/posts/${id}.json`)
        if (!p) return json({ error: 'not found' }, 404)
        return json({ ok: true, post: p })
      }
      if (method === 'POST' && url.pathname === '/api/post') return await apiCreatePost(request, env)
      if (method === 'GET' && url.pathname === '/api/media') return await apiProxyMedia(request, env, url.searchParams.get('path'))
      if (method === 'POST' && url.pathname === '/api/notify-test') return await apiNotifyTest(request, env)
      if (method === 'POST' && url.pathname === '/api/prune') return await apiPrune(request, env)
      if (method === 'GET' && url.pathname === '/') {
        return json({ ok: true, service: 'lss-board-worker', endpoints: ['/api/health', '/api/posts', '/api/post', '/api/media', '/api/notify-test', '/api/prune'] })
      }
      return json({ error: 'Not Found' }, 404)
    } catch (err) {
      console.error('worker error', err)
      return json({ error: (err && err.message) || 'Internal Error' }, 500)
    }
  },
}
