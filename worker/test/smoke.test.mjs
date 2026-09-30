import { webcrypto as crypto } from 'node:crypto'

const store = new Map()
const calls = []
let dataCounter = 0

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url
  const method = (init && init.method) || 'GET'
  calls.push(`${method} ${url}`)

  if (url.startsWith('https://api.github.com/repos/')) {
    const isIssues = url.endsWith('/issues')
    if (method === 'POST' && isIssues) {
      const body = JSON.parse(init.body)
      return jsonRes({ number: ++dataCounter, title: body.title, body: body.body })
    }
    if (!url.includes('/contents/')) throw new Error('unexpected github url: ' + url)
    const path = decodeURIComponent(url.split('/contents/')[1].split('?')[0])
    if (method === 'GET') {
      if (!store.has(path)) return jsonRes({ message: 'Not Found' }, 404)
      return jsonRes({ name: path.split('/').pop(), path, sha: 'sha-' + path, content: store.get(path) })
    }
    if (method === 'PUT') {
      const body = JSON.parse(init.body)
      store.set(path, body.content)
      return jsonRes({ content: { path, sha: 'sha-' + path } })
    }
    if (method === 'DELETE') {
      store.delete(path)
      return jsonRes({})
    }
  }
  if (url.startsWith('https://raw.githubusercontent.com/')) {
    const path = url.split('/main/')[1]
    if (!store.has(path)) return new Response('nope', { status: 404 })
    return new Response(Buffer.from(store.get(path), 'base64'), { status: 200 })
  }
  if (url.includes('api.day.app')) return jsonRes({ code: 200, message: 'success' })
  if (url.includes('pushplus')) return jsonRes({ code: 200, msg: 'ok' })
  if (url.includes('ftqq.com')) return jsonRes({ code: 0, message: 'ok' })
  if (url.includes('qyapi.weixin.qq.com')) return jsonRes({ errcode: 0, errmsg: 'ok' })
  if (url.includes('api.resend.com')) return jsonRes({ id: 'mail-1' })
  if (url.includes('hooks.example.com')) return jsonRes({ ok: true })
  throw new Error('unmocked fetch: ' + url)
}

const env = {
  GITHUB_OWNER: 'lianchuzhong',
  GITHUB_REPO: 'lss',
  GITHUB_BRANCH: 'main',
  GITHUB_TOKEN: 'test-token',
  SITE_URL: 'https://lianchuzhong.github.io/lss',
  GITHUB_NOTIFY: 'on',
  BARK_URL: 'https://api.day.app',
  BARK_KEY: 'BARKTESTKEY',
  PUSHPLUS_TOKEN: 'pp-token',
  SERVERCHAN_KEY: 'SCTxxx',
  WECOM_WEBHOOK: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x',
  RESEND_API_KEY: 're_test',
  MAIL_TO: 'me@example.com',
  WEBHOOK_URL: 'https://hooks.example.com/lss',
  ADMIN_TOKEN: 'admin-secret',
  RATE_MAX: '2',
  RATE_WINDOW_MIN: '10',
  MEDIA_MAX_BYTES: String(1024 * 1024),
}

const { default: worker } = await import('../src/index.js')
const call = (path, init) => worker.fetch(new Request('https://w.dev' + path, init), env)

let failures = 0
const check = (label, cond, extra) => {
  if (cond) console.log('  PASS  ' + label)
  else {
    failures++
    console.log('  FAIL  ' + label + (extra ? '  << ' + extra : ''))
  }
}

console.log('\n[1] health 报告通知通道')
const health = await (await call('/api/health')).json()
check('notifyReady = 7', health.notifyReady === 7, JSON.stringify(health.notify))
check('7 个通道全部就绪', Object.values(health.notify).every((v) => v.ready))
check('媒体上限透传', health.mediaMaxBytes === 1024 * 1024)

console.log('\n[2] 生成密钥对并端到端加密留言')
const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['wrapKey', 'unwrapKey'])
const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
const metaIv = crypto.getRandomValues(new Uint8Array(12))
const meta = { name: '老范', price: '500', contact: 'wx abc123', message: '这是加密测试留言', media: { name: 'demo.mp4', mime: 'video/mp4', size: 4 } }
const metaCt = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: metaIv }, aes, new TextEncoder().encode(JSON.stringify(meta)))
const fileIv = crypto.getRandomValues(new Uint8Array(12))
const fileCt = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fileIv }, aes, new TextEncoder().encode('FAKE-MP4-BYTES'))
const wrapped = await crypto.subtle.wrapKey('raw', aes, pair.publicKey, { name: 'RSA-OAEP', hash: 'SHA-256' })
const b64 = (u8) => Buffer.from(u8).toString('base64')
const envelope = {
  v: 1,
  id: 'm-test0001',
  createdAt: Date.now(),
  wrapped: b64(new Uint8Array(wrapped)),
  metaIv: b64(metaIv),
  metaCt: b64(new Uint8Array(metaCt)),
  mediaIv: b64(fileIv),
  mediaName: encodeURIComponent('demo.mp4'),
  mediaMime: encodeURIComponent('video/mp4'),
}

const form = new FormData()
form.set('enc', JSON.stringify(envelope))
form.set('file', new Blob([fileCt], { type: 'application/octet-stream' }), 'demo.mp4.enc')
const created = await (await call('/api/post', { method: 'POST', body: form })).json()
check('提交成功返回 ok', created.ok === true, JSON.stringify(created))
check('返回留言编号', !!created.id, JSON.stringify(created.id))
check('通知扇出 7 成功 0 失败', created.notify.sent === 7 && created.notify.failed === 0, JSON.stringify(created.notify.channels))

console.log('\n[3] 各通知通道确实被调用')
const hit = (needle) => calls.some((c) => c.includes(needle))
check('GitHub Issue 已创建', hit('/issues'))
check('Bark 已推送', hit('api.day.app/BARKTESTKEY'))
check('PushPlus 已推送', hit('pushplus.plus'))
check('Server酱 已推送', hit('ftqq.com'))
check('企业微信 已推送', hit('qyapi.weixin.qq.com'))
check('Resend 邮件已发送', hit('api.resend.com'))
check('自定义 Webhook 已调用', hit('hooks.example.com'))
const mediaPut = calls.filter((c) => c.includes('/contents/uploads/'))
check('密文附件已入库 uploads/', mediaPut.length === 1, String(mediaPut.length))

console.log('\n[4] 列表与解密')
const list = await (await call('/api/posts')).json()
check('列表 count = 1', list.count === 1, JSON.stringify(list))
check('列表含 hasMedia', list.posts[0] && list.posts[0].hasMedia === true)
const full = await (await call('/api/posts?full=1')).json()
check('full=1 返回密文', full.posts[0] && !!full.posts[0].enc)

const got = JSON.parse(full.posts[0].enc)
const rawAes = await crypto.subtle.unwrapKey('raw', Buffer.from(got.wrapped, 'base64'), pair.privateKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, { name: 'AES-GCM' }, false, ['decrypt'])
const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(got.metaIv, 'base64') }, rawAes, Buffer.from(got.metaCt, 'base64'))
const decoded = JSON.parse(Buffer.from(plain).toString())
check('私钥可解密留言正文', decoded.message === meta.message && decoded.contact === meta.contact, JSON.stringify(decoded))

const mediaRes = await call('/api/media?path=' + full.posts[0].media.path)
const mediaBuf = await mediaRes.arrayBuffer()
const mediaPlain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(got.mediaIv, 'base64') }, rawAes, mediaBuf)
check('密文附件可解密还原', Buffer.from(mediaPlain).toString() === 'FAKE-MP4-BYTES')
check('非法 media 路径被拒', (await call('/api/media?path=../../etc/passwd')).status === 400)

console.log('\n[5] 限流')
const empty = () => {
  const f = new FormData()
  f.set('enc', JSON.stringify({ ...envelope, id: 'x' + Math.random().toString(36).slice(2, 8) }))
  return call('/api/post', { method: 'POST', body: f })
}
await empty()
const r3 = await empty()
check('超过 RATE_MAX 后 429', r3.status === 429, String(r3.status))
check('429 带中文提示', (await r3.json()).error.includes('频繁'))

console.log('\n[6] 通知自测与鉴权')
check('无 token 自测被拒 401', (await call('/api/notify-test', { method: 'POST' })).status === 401)
const test = await (await call('/api/notify-test', { method: 'POST', headers: { 'X-Admin-Token': 'admin-secret' } })).json()
check('自测 7 通道全通', test.sent === 7 && test.failed === 0, JSON.stringify(test.channels))

console.log('\n[7] 清理与错误处理')
const prune = await (await call('/api/prune?max=0', { method: 'POST', headers: { 'X-Admin-Token': 'admin-secret' } })).json()
check('max=0 被拒', prune.error === '缺少 max 参数', JSON.stringify(prune))
check('缺 enc 报 400', (await call('/api/post', { method: 'POST', body: new FormData(), headers: { 'CF-Connecting-IP': '203.0.113.9' } })).status === 400)
check('未知路由 404', (await call('/api/nope')).status === 404)
check('CORS 预检 204', (await call('/api/post', { method: 'OPTIONS' })).status === 204)

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'))
process.exit(failures === 0 ? 0 : 1)
