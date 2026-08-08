const GITHUB_HOST = 'https://api.github.com'
const RAW_HOST = 'https://raw.githubusercontent.com'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const method = request.method

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    try {
      if (method === 'GET' && url.pathname === '/api/posts') {
        return await apiListPosts(env)
      }
      if (method === 'POST' && url.pathname === '/api/post') {
        return await apiCreatePost(request, env)
      }
      if (method === 'GET' && url.pathname === '/api/media') {
        return await apiProxyMedia(env, url.searchParams.get('path'))
      }
      return json({ error: 'Not Found' }, 404)
    } catch (err) {
      console.error('worker error', err)
      return json({ error: (err && err.message) || 'Internal Error' }, 500)
    }
  },
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  })
}

function ghHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'lss-board-worker',
  }
}

function rawUrl(env, path) {
  return `${RAW_HOST}/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/${path}`
}

async function ghGet(env, path) {
  const url = `${GITHUB_HOST}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`
  const res = await fetch(url, { headers: ghHeaders(env.GITHUB_TOKEN) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
  return res.json()
}

async function ghPut(env, path, contentBase64, sha, commitMessage) {
  const body = { message: commitMessage || 'update ' + path, content: contentBase64, branch: env.GITHUB_BRANCH }
  if (sha) body.sha = sha
  const res = await fetch(`${GITHUB_HOST}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: ghHeaders(env.GITHUB_TOKEN),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`PUT ${path} -> ${res.status} ${text.slice(0, 300)}`)
  }
  return res.json()
}

function bytesToBase64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

async function apiListPosts(env) {
  const dir = await ghGet(env, 'data/posts')
  const posts = []
  if (Array.isArray(dir)) {
    for (const item of dir) {
      if (item.type !== 'file' || !item.name.endsWith('.json')) continue
      try {
        const meta = await ghGet(env, item.path)
        if (meta && meta.content) {
          const p = JSON.parse(atob(meta.content))
          posts.push(p)
        }
      } catch (_) {}
    }
  }
  posts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return json({ posts })
}

async function apiCreatePost(request, env) {
  const form = await request.formData()
  const encRaw = String(form.get('enc') || '').trim()
  const file = form.get('file')

  if (!encRaw) {
    return json({ error: '缺少加密负载' }, 400)
  }
  if (encRaw.length > 20000) {
    return json({ error: '加密数据过大' }, 400)
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  const createdAt = Date.now()

  let media = null
  if (file && file.size) {
    if (file.size > 95 * 1024 * 1024) {
      return json({ error: '文件过大，单个文件最大 95MB' }, 400)
    }
    const mediaPath = `uploads/${id}.bin`
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    await ghPut(env, mediaPath, bytesToBase64(bytes), null, 'add upload ' + id)
    media = {
      file: 'media.bin',
      size: file.size,
      type: 'enc',
      path: mediaPath,
    }
  }

  const post = { id, enc: encRaw, media, createdAt }
  await ghPut(env, `data/posts/${id}.json`, bytesToBase64(new TextEncoder().encode(JSON.stringify(post))), null, 'add post ' + id)
  return json({ ok: true, id })
}

async function apiProxyMedia(env, path) {
  if (!path || !/^uploads\/[a-zA-Z0-9._-]+\.bin$/.test(path)) {
    return json({ error: 'invalid path' }, 400)
  }
  const res = await fetch(rawUrl(env, path), {
    headers: { 'User-Agent': 'lss-board-worker' },
  })
  if (!res.ok) {
    return json({ error: 'media not found' }, 404)
  }
  const buf = await res.arrayBuffer()
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'no-store',
    },
  })
}