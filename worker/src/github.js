import { GITHUB_API, GITHUB_RAW, base64ToBytes, envStr, readBodyText } from './util.js'

export function ghHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'lss-board-worker',
  }
}

export function requireToken(env) {
  const token = envStr(env, 'GITHUB_TOKEN')
  if (!token) throw new Error('缺少 GITHUB_TOKEN secret')
  return token
}

function contentsUrl(env, path) {
  return `${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(env.GITHUB_BRANCH)}`
}

export async function ghMeta(env, path) {
  const res = await fetch(contentsUrl(env, path), { headers: ghHeaders(requireToken(env)) })
  if (res.status === 404) return null
  if (res.status === 401 || res.status === 403) throw new Error('GITHUB_TOKEN 无权访问仓库（需 contents:write）')
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
  return res.json()
}

export async function ghList(env, path) {
  const meta = await ghMeta(env, path)
  return Array.isArray(meta) ? meta : []
}

export async function ghJson(env, path) {
  const meta = await ghMeta(env, path)
  if (!meta || !meta.content) return null
  try {
    return JSON.parse(new TextDecoder().decode(base64ToBytes(meta.content)))
  } catch (_) {
    return null
  }
}

export async function ghPut(env, path, contentBase64, sha, commitMessage) {
  const body = {
    message: commitMessage || `update ${path}`,
    content: contentBase64,
    branch: env.GITHUB_BRANCH,
  }
  if (sha) body.sha = sha
  const res = await fetch(`${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: ghHeaders(requireToken(env)),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`PUT ${path} -> ${res.status} ${await readBodyText(res)}`)
  return res.json()
}

export async function ghDelete(env, path, sha, commitMessage) {
  const res = await fetch(contentsUrl(env, path), {
    method: 'DELETE',
    headers: ghHeaders(requireToken(env)),
    body: JSON.stringify({ message: commitMessage || `delete ${path}`, sha, branch: env.GITHUB_BRANCH }),
  })
  if (!res.ok) throw new Error(`DELETE ${path} -> ${res.status} ${await readBodyText(res)}`)
  return res.json()
}

export function rawUrl(env, path) {
  return `${GITHUB_RAW}/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/${path}`
}

export async function ghCreateIssue(env, title, body) {
  const res = await fetch(`${GITHUB_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: ghHeaders(requireToken(env)),
    body: JSON.stringify({ title, body }),
  })
  if (!res.ok) {
    const hint =
      res.status === 403
        ? 'token 缺少 issues:write 权限，或已触发 GitHub 发信/建仓频率限制'
        : await readBodyText(res)
    throw new Error(`GitHub Issue -> ${res.status} ${hint}`)
  }
  return res.json()
}
