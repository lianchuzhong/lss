import mqtt from 'mqtt'

const OWNER_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3CxtqUliQkJkfmh31i0E
UGUihnthDqzOecJt/AuWQQXRRNVAgThSxpjUefS/mu5/ut5sWH0aXOp0BNrXoa0T
r/80PXsTdP5H3TEcx7ZdELl+LJ/goFa70OwJgkFkL4uEtMNMKsJZ2UHl/kpqawrd
VthNBylosjGRljkv2Pats0HZvG8y47zmvBbQLO8VYrTf/jSHnnoxiOE9PS+0+wnK
tpwoLuHoRsRxF0wwDbE0P1poNh29l8ZoPzibq15w0l33rJNmVA+qcjN7NyI4JA5K
2ZhIhNDCIQuaTQhkEpx/qLTiiBYSKff4ISLBcT1WMcv8Ym3Q05wrtqZj1WTXXuNh
3QIDAQAB
-----END PUBLIC KEY-----`

const DEFAULT_WORKER_BASE = ''

const BROKERS = [
  'wss://broker-cn.emqx.io:8084/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
]
const TOPIC_PREFIX = 'lss/board/'
const MQTT_PAYLOAD_MAX = 620 * 1024
const MQTT_MEDIA_MAX = 450 * 1024
const LS_WORKER = 'lss.workerBase'
const LS_KEY = 'lss.ownerPrivateKey'
const LS_ADMIN = 'lss.adminToken'
const POLL_MS = 45000

const el = (id) => document.getElementById(id)
const nameEl = el('name')
const fileEl = el('file')
const dropEl = el('drop')
const previewEl = el('preview')
const priceEl = el('price')
const contactEl = el('contact')
const msgEl = el('message')
const submitBtn = el('submit')
const statusEl = el('status')
const counterEl = el('msgCount')

let selectedFile = null
let posting = false
let client = null
let clientReady = false
let mediaMaxBytes = 45 * 1024 * 1024
let health = null
let privateKey = null
let panelUnlocked = false
let postsCache = []
let notifyPermission = typeof Notification !== 'undefined' ? Notification.permission : 'denied'
let installPrompt = null

const seenIds = new Set()
const order = new Map()

function bytesToBase64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function base64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function pemBody(pem) {
  return String(pem)
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '')
}

function derLen(n) {
  if (n < 0x80) return new Uint8Array([n])
  const bytes = []
  let x = n
  while (x > 0) {
    bytes.unshift(x & 0xff)
    x >>= 8
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes])
}

function der(tag, content) {
  return new Uint8Array([tag, ...derLen(content.length), ...content])
}

function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrs) {
    out.set(a, off)
    off += a.length
  }
  return out
}

function rsaPkcs1ToPkcs8(b64) {
  const pkcs1 = base64ToBytes(b64)
  const version = new Uint8Array([0x02, 0x01, 0x00])
  const oid = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01])
  const nul = new Uint8Array([0x05, 0x00])
  const algId = der(0x30, concatBytes(oid, nul))
  return der(0x30, concatBytes(version, algId, der(0x04, pkcs1)))
}

async function importPrivateKey(pem) {
  const text = String(pem || '').trim()
  if (!text.includes('PRIVATE KEY')) throw new Error('私钥内容无效：未找到 PRIVATE KEY 段')
  const isPkcs1 = text.includes('BEGIN RSA PRIVATE KEY')
  const der = isPkcs1 ? rsaPkcs1ToPkcs8(pemBody(text)) : base64ToBytes(pemBody(text))
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['unwrapKey'])
}

async function importOwnerPublicKey() {
  const der = base64ToBytes(pemBody(OWNER_PUBLIC_KEY_PEM))
  return crypto.subtle.importKey('spki', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['wrapKey'])
}

async function newAesKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

function toast(msg) {
  const node = el('toast')
  if (!node) return
  node.textContent = msg
  node.classList.add('show')
  setTimeout(() => node.classList.remove('show'), 3200)
}

function setStatus(text, cls) {
  if (!statusEl) return
  statusEl.textContent = text
  statusEl.className = 'status-bar' + (cls ? ' ' + cls : '')
}

function setOwnerStatus(text, cls) {
  const node = el('ownerStatus')
  if (!node) return
  node.textContent = text
  node.className = 'status-bar' + (cls ? ' ' + cls : '')
}

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

function fmtTime(ts) {
  const d = new Date(ts || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function workerBase() {
  const params = new URLSearchParams(location.search)
  const fromQuery = (params.get('worker') || '').trim()
  if (fromQuery) {
    try {
      localStorage.setItem(LS_WORKER, fromQuery)
    } catch (_) {}
    return fromQuery.replace(/\/+$/, '')
  }
  try {
    return (localStorage.getItem(LS_WORKER) || DEFAULT_WORKER_BASE).replace(/\/+$/, '')
  } catch (_) {
    return DEFAULT_WORKER_BASE
  }
}

function hasWorker() {
  return workerBase().length > 0
}

async function apiGet(path) {
  const base = workerBase()
  if (!base) throw new Error('未配置后端地址')
  const res = await fetch(base + path, { headers: { Accept: 'application/json' } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`)
  return data
}

async function apiPost(path, body, headers) {
  const base = workerBase()
  if (!base) throw new Error('未配置后端地址')
  const res = await fetch(base + path, { method: 'POST', body, headers: headers || {} })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `提交失败 ${res.status}`)
  return data
}

function renderPreview() {
  if (!previewEl) return
  previewEl.textContent = ''
  if (!selectedFile) return
  const wrap = document.createElement('div')
  wrap.className = 'file'
  const mime = selectedFile.type
  if (/^image\//.test(mime)) {
    const img = document.createElement('img')
    img.src = URL.createObjectURL(selectedFile)
    wrap.appendChild(img)
  } else if (/^video\//.test(mime)) {
    const v = document.createElement('video')
    v.src = URL.createObjectURL(selectedFile)
    v.controls = true
    v.muted = true
    v.preload = 'metadata'
    wrap.appendChild(v)
  }
  const name = document.createElement('div')
  name.className = 'name'
  name.textContent = `${selectedFile.name}  ${fmtSize(selectedFile.size)}`
  wrap.appendChild(name)
  const x = document.createElement('button')
  x.className = 'x'
  x.textContent = '✕'
  x.onclick = () => {
    selectedFile = null
    fileEl.value = ''
    renderPreview()
  }
  wrap.appendChild(x)
  previewEl.appendChild(wrap)
}

async function shrinkImage(file) {
  const img = await new Promise((resolve, reject) => {
    const u = URL.createObjectURL(file)
    const im = new Image()
    im.onload = () => {
      URL.revokeObjectURL(u)
      resolve(im)
    }
    im.onerror = () => reject(new Error('图片解码失败'))
    im.src = u
  })
  let { naturalWidth: w, naturalHeight: h } = img
  const MAX = 1400
  if (w > MAX || h > MAX) {
    const r = Math.min(1, MAX / Math.max(w, h))
    w = Math.round(w * r)
    h = Math.round(h * r)
  }
  let bytes = null
  for (const q of [0.88, 0.75, 0.6, 0.45, 0.3]) {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    c.getContext('2d').drawImage(img, 0, 0, w, h)
    bytes = await new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', q))
    if (bytes && bytes.size <= mediaMaxBytes) break
  }
  return bytes
}

function newIdSeen(id, createdAt) {
  if (seenIds.has(id)) return false
  seenIds.add(id)
  order.set(id, createdAt || Date.now())
  return true
}

function ordinalOf(id) {
  const sorted = [...order.entries()].sort((a, b) => a[1] - b[1])
  const idx = sorted.findIndex(([k]) => k === id)
  return idx >= 0 ? idx + 1 : sorted.length
}

function renderCount() {
  if (!counterEl) return
  counterEl.style.display = 'inline-block'
  const n = seenIds.size
  const backend = hasWorker() ? (health && health.ok ? '已连接后端' : '后端未连通') : '未配置后端（仅实时模式）'
  const rt = clientReady ? '实时已连接' : '实时未连接'
  counterEl.textContent = `已收到留言 ${n} 条 · ${backend} · ${rt}`
}

function flashTitle(text) {
  document.title = text
  setTimeout(() => {
    document.title = '世界专利产品供应链'
  }, 8000)
}

function notifyNew(id, createdAt) {
  const no = ordinalOf(id)
  if (notifyPermission === 'granted' && typeof Notification !== 'undefined') {
    try {
      const n = new Notification(`新留言 #${no}`, {
        body: `${fmtTime(createdAt)}\n点击打开后台查看（内容为密文，需私钥解密）`,
        tag: 'lss-' + id,
        icon: './icon-192.png',
        badge: './icon-192.png',
        requireInteraction: false,
      })
      n.onclick = () => {
        window.focus()
        openOwnerPanel()
        n.close()
      }
    } catch (_) {}
  }
  flashTitle(`(${seenIds.size}) 新留言！`)
}

function onBoardMessage(topic, payload) {
  if (topic.indexOf(TOPIC_PREFIX) !== 0) return
  let m = null
  try {
    m = JSON.parse(payload.toString())
  } catch (_) {}
  if (!m || !m.id) return
  if (!newIdSeen(m.id, m.createdAt)) return
  renderCount()
  notifyNew(m.id, m.createdAt)
  if (panelUnlocked) loadPosts()
}

function connectOne(url) {
  return new Promise((resolve, reject) => {
    let settled = false
    const probe = mqtt.connect(url, {
      clientId: 'lssb-' + Math.random().toString(36).slice(2, 12),
      reconnectPeriod: 0,
      connectTimeout: 10000,
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        probe.end(true)
      } catch (_) {}
      reject(new Error('连接超时'))
    }, 12000)
    const done = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(arg)
    }
    probe.on('connect', () => done(resolve, probe))
    probe.on('error', () => {})
    probe.on('close', () => done(reject, new Error('连接失败')))
  })
}

async function ensureClient() {
  if (client && clientReady) return
  let lastErr = null
  for (const url of BROKERS) {
    try {
      const c = await connectOne(url)
      c.options.reconnectPeriod = 3000
      c.on('connect', () => {
        clientReady = true
        renderCount()
        try {
          c.subscribe(TOPIC_PREFIX + '#')
        } catch (_) {}
      })
      c.on('message', onBoardMessage)
      c.on('offline', () => {
        clientReady = false
        renderCount()
      })
      c.on('close', () => {
        clientReady = false
        renderCount()
      })
      c.on('error', () => {})
      client = c
      clientReady = true
      try {
        c.subscribe(TOPIC_PREFIX + '#')
      } catch (_) {}
      renderCount()
      return
    } catch (err) {
      lastErr = err
    }
  }
  client = null
  clientReady = false
  renderCount()
  throw new Error((lastErr && lastErr.message) || '无法连接消息服务器')
}

async function publishNotice(id, createdAt) {
  await ensureClient()
  const payload = JSON.stringify({ v: 1, id, createdAt, notice: true })
  await new Promise((resolve, reject) => {
    client.publish(TOPIC_PREFIX + id, payload, { qos: 1, retain: false }, (err) => (err ? reject(err) : resolve()))
  })
}

async function refreshHealth() {
  const box = el('healthBox')
  if (!hasWorker()) {
    if (box) box.innerHTML = '<div class="hint warn">未配置后端地址：留言仅通过公共 MQTT 实时广播，不会落库、也不会触发任何通知。</div>'
    updateDropHint()
    return
  }
  try {
    health = await apiGet('/api/health')
    mediaMaxBytes = health.mediaMaxBytes || mediaMaxBytes
    updateDropHint()
    const rows = Object.entries(health.notify || {})
      .map(([k, v]) => `<li><span>${channelLabel(k)}</span><b class="${v.ready ? 'ok' : 'off'}">${v.ready ? '已就绪' : v.reason}</b></li>`)
      .join('')
    if (box) {
      box.innerHTML = `<div class="hint ok">后端已连接：${health.repo}<br>通知通道就绪 ${health.notifyReady} 个 · 限流 ${health.rate.max} 条/${health.rate.windowMs / 60000} 分钟 · 附件上限 ${fmtSize(mediaMaxBytes)}</div><ul class="chan-list">${rows}</ul>`
    }
  } catch (err) {
    health = null
    if (box) box.innerHTML = `<div class="hint err">后端连接失败：${err.message}</div>`
  }
  renderCount()
}

function updateDropHint() {
  const hint = el('dropHint')
  if (!hint) return
  hint.textContent = hasWorker()
    ? `点击选择或拖入 1 个视频或图片（单个最大 ${fmtSize(mediaMaxBytes)}，图片自动压缩）`
    : '点击选择或拖入 1 个视频或图片（未配置后端时最大 450KB）'
}

function channelLabel(name) {
  return (
    {
      github: 'GitHub Issue（触发 GitHub 邮件）',
      bark: 'Bark 手机推送',
      pushplus: 'PushPlus 微信推送',
      serverchan: 'Server酱 微信推送',
      wecom: '企业微信群机器人',
      email: '邮件（Resend）',
      webhook: '自定义 Webhook',
    }[name] || name
  )
}

async function pollBackend() {
  if (!hasWorker()) return
  try {
    const data = await apiGet('/api/posts')
    postsCache = data.posts || []
    let fresh = 0
    for (const p of postsCache) {
      if (newIdSeen(p.id, p.createdAt)) {
        fresh++
        notifyNew(p.id, p.createdAt)
      }
    }
    if (fresh) {
      renderCount()
      if (panelUnlocked) loadPosts()
    }
  } catch (_) {}
}

async function postMessage() {
  if (posting) return
  const message = msgEl.value.trim()
  const price = priceEl.value.trim()
  const contact = contactEl.value.trim()
  if (!selectedFile && !message && !price && !contact) {
    toast('请填写留言内容或选择文件')
    return
  }
  if (selectedFile && selectedFile.size > mediaMaxBytes) {
    toast(`文件过大，单个上限 ${fmtSize(mediaMaxBytes)}`)
    return
  }

  posting = true
  submitBtn.disabled = true
  setStatus('正在加密留言…')
  try {
    const pubKey = await importOwnerPublicKey()
    const aes = await newAesKey()

    let mediaBytes = null
    let mediaName = ''
    let mediaMime = ''
    if (selectedFile) {
      mediaName = selectedFile.name
      mediaMime = selectedFile.type || 'application/octet-stream'
      if (/^image\//.test(mediaMime)) {
        mediaBytes = await shrinkImage(selectedFile)
        if (!mediaBytes || mediaBytes.size > mediaMaxBytes) throw new Error('图片压缩后仍超过大小上限')
      } else {
        mediaBytes = selectedFile
        if (mediaBytes.size > mediaMaxBytes) throw new Error(`文件超过 ${fmtSize(mediaMaxBytes)} 上限，请压缩后再提交`)
      }
    }

    const metaRaw = JSON.stringify({
      name: nameEl.value.trim() || '匿名',
      price,
      contact,
      message,
      media: mediaBytes ? { name: mediaName, mime: mediaMime, size: mediaBytes.size } : null,
    })
    const metaIv = crypto.getRandomValues(new Uint8Array(12))
    const metaCt = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: metaIv }, aes, new TextEncoder().encode(metaRaw))

    let mediaIvB64 = null
    let mediaCipherBlob = null
    if (mediaBytes) {
      const buf = mediaBytes instanceof ArrayBuffer ? new Uint8Array(mediaBytes) : new Uint8Array(await mediaBytes.arrayBuffer())
      const fileIv = crypto.getRandomValues(new Uint8Array(12))
      const fileCt = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fileIv }, aes, buf)
      mediaIvB64 = bytesToBase64(fileIv)
      mediaCipherBlob = new Blob([fileCt], { type: 'application/octet-stream' })
    }

    const wrapped = await crypto.subtle.wrapKey('raw', aes, pubKey, { name: 'RSA-OAEP', hash: 'SHA-256' })

    const envelope = {
      v: 1,
      id: uid(),
      createdAt: Date.now(),
      wrapped: bytesToBase64(new Uint8Array(wrapped)),
      metaIv: bytesToBase64(metaIv),
      metaCt: bytesToBase64(new Uint8Array(metaCt)),
      mediaIv: mediaIvB64,
      mediaName: mediaName ? encodeURIComponent(mediaName) : null,
      mediaMime: mediaMime ? encodeURIComponent(mediaMime) : null,
    }

    const payloadRaw = JSON.stringify(envelope)
    if (new TextEncoder().encode(payloadRaw).length > MQTT_PAYLOAD_MAX) {
      throw new Error('留言内容过长，请精简后再提交')
    }

    let ordinal = 0
    let delivered = ''

    if (hasWorker()) {
      setStatus('正在加密上传到后端…')
      const form = new FormData()
      form.set('enc', payloadRaw)
      if (mediaCipherBlob) form.set('file', mediaCipherBlob, (mediaName || 'media') + '.enc')
      const res = await apiPost('/api/post', form)
      delivered = '已入库'
      ordinal = res.count || (postsCache.length + 1)
    } else {
      setStatus('未配置后端，正在通过实时通道投递…')
      if (mediaCipherBlob && mediaCipherBlob.size > MQTT_MEDIA_MAX) {
        throw new Error(`未配置后端时附件上限仅 ${fmtSize(MQTT_MEDIA_MAX)}，请配置后端地址或压缩文件`)
      }
      envelope.mediaCipher = mediaCipherBlob ? bytesToBase64(new Uint8Array(await mediaCipherBlob.arrayBuffer())) : null
      envelope.mediaSize = mediaCipherBlob ? mediaCipherBlob.size : 0
      const wire = JSON.stringify(envelope)
      if (new TextEncoder().encode(wire).length > MQTT_PAYLOAD_MAX) throw new Error('留言内容过长，请精简后再提交')
      await ensureClient()
      await new Promise((resolve, reject) => {
        client.publish(TOPIC_PREFIX + envelope.id, wire, { qos: 1, retain: true }, (err) => (err ? reject(err) : resolve()))
      })
      delivered = '仅实时广播（未落库，不会触发通知）'
    }

    try {
      await publishNotice(envelope.id, envelope.createdAt)
    } catch (_) {}

    newIdSeen(envelope.id, envelope.createdAt)
    renderCount()
    if (!ordinal) ordinal = ordinalOf(envelope.id)

    setStatus(`提交成功，编号 #${ordinal} · ${delivered}`, 'ok')
    toast('提交成功')
    showSuccessModal(ordinal)
    selectedFile = null
    fileEl.value = ''
    priceEl.value = ''
    contactEl.value = ''
    msgEl.value = ''
    nameEl.value = ''
    renderPreview()
    if (hasWorker()) pollBackend()
  } catch (err) {
    setStatus('提交失败：' + err.message, 'err')
    toast('提交失败：' + err.message)
  } finally {
    posting = false
    submitBtn.disabled = false
  }
}

async function decryptEnvelope(enc, priv) {
  const env = JSON.parse(enc)
  const aes = await crypto.subtle.unwrapKey(
    'raw',
    base64ToBytes(env.wrapped),
    priv,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  )
  const metaBytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(env.metaIv) }, aes, base64ToBytes(env.metaCt))
  const meta = JSON.parse(new TextDecoder().decode(metaBytes))
  return { env, meta }
}

async function loadMediaBlob(post, env) {
  if (!post.media || !post.media.path || !env.mediaIv) return null
  const base = workerBase()
  const res = await fetch(`${base}/api/media?path=${encodeURIComponent(post.media.path)}`)
  if (!res.ok) throw new Error('附件下载失败')
  const buf = await res.arrayBuffer()
  const aes = await crypto.subtle.unwrapKey(
    'raw',
    base64ToBytes(env.wrapped),
    privateKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  )
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(env.mediaIv) }, aes, buf)
  const mime = (env.mediaMime && decodeURIComponent(env.mediaMime)) || 'application/octet-stream'
  return new Blob([plain], { type: mime })
}

function clearGrid() {
  for (const node of document.querySelectorAll('#postGrid .post')) {
    const media = node.querySelector('video,img')
    if (media && media.src && media.src.startsWith('blob:')) URL.revokeObjectURL(media.src)
  }
  const grid = el('postGrid')
  if (grid) grid.textContent = ''
}

function renderPosts(items) {
  const grid = el('postGrid')
  const empty = el('postEmpty')
  if (!grid) return
  clearGrid()
  if (!items.length) {
    grid.style.display = 'none'
    if (empty) empty.style.display = 'block'
    return
  }
  if (empty) empty.style.display = 'none'
  grid.style.display = 'grid'
  for (const it of items) {
    const card = document.createElement('article')
    card.className = 'post'

    if (it.url) {
      const box = document.createElement('div')
      box.className = 'media'
      if (/^video\//.test(it.mime)) {
        const v = document.createElement('video')
        v.src = it.url
        v.controls = true
        v.preload = 'metadata'
        box.appendChild(v)
      } else {
        const img = document.createElement('img')
        img.src = it.url
        img.loading = 'lazy'
        box.appendChild(img)
      }
      const tag = document.createElement('span')
      tag.className = 'tag'
      tag.textContent = it.name || '附件'
      box.appendChild(tag)
      card.appendChild(box)
    }

    const body = document.createElement('div')
    body.className = 'body'
    if (it.price) {
      const p = document.createElement('div')
      p.className = 'price'
      p.textContent = '￥' + it.price
      body.appendChild(p)
    }
    if (it.contact) {
      const c = document.createElement('div')
      c.className = 'contact'
      c.textContent = it.contact
      body.appendChild(c)
    }
    if (it.message) {
      const m = document.createElement('div')
      m.className = 'msg'
      m.textContent = it.message
      body.appendChild(m)
    }
    const meta = document.createElement('div')
    meta.className = 'meta'
    const who = document.createElement('span')
    who.className = 'name'
    who.textContent = it.name || '匿名'
    meta.appendChild(who)
    const time = document.createElement('span')
    time.textContent = `${it.no ? '#' + it.no + ' · ' : ''}${fmtTime(it.createdAt)}`
    meta.appendChild(time)
    body.appendChild(meta)
    if (it.error) {
      const e = document.createElement('div')
      e.className = 'post-err'
      e.textContent = it.error
      body.appendChild(e)
    }
    card.appendChild(body)
    grid.appendChild(card)
  }
}

async function loadPosts() {
  if (!panelUnlocked || !privateKey) return
  if (!hasWorker()) {
    setOwnerStatus('未配置后端地址，无法读取历史留言。请在下方填写 Worker 地址后保存。', 'err')
    return
  }
  setOwnerStatus('正在拉取并解密留言…')
  try {
    const data = await apiGet('/api/posts?full=1')
    const posts = data.posts || []
    postsCache = posts.map((p) => ({ id: p.id, createdAt: p.createdAt, hasMedia: !!p.media }))
    const items = []
    for (const p of posts) {
      const no = ordinalOf(p.id)
      try {
        const { env, meta } = await decryptEnvelope(p.enc, privateKey)
        const item = {
          no,
          name: meta.name,
          price: meta.price,
          contact: meta.contact,
          message: meta.message,
          createdAt: p.createdAt,
          mime: meta.media ? meta.media.mime : '',
          name2: meta.media ? meta.media.name : '',
        }
        if (p.media && p.media.path) {
          try {
            const blob = await loadMediaBlob(p, env)
            if (blob) {
              item.url = URL.createObjectURL(blob)
              item.mime = meta.media.mime
              item.name = meta.name
              item.name2 = meta.media.name
            }
          } catch (err) {
            item.error = '附件解密失败：' + err.message
          }
        }
        items.push(item)
      } catch (err) {
        items.push({ no, createdAt: p.createdAt, error: '解密失败（私钥不匹配？）：' + err.message, name: '', message: '' })
      }
    }
    renderPosts(items)
    const cnt = el('postCnt')
    if (cnt) cnt.textContent = String(items.length)
    const okCount = items.filter((i) => !i.error).length
    setOwnerStatus(`已解密 ${okCount}/${items.length} 条留言 · 私钥仅保存在本机浏览器`, 'ok')
  } catch (err) {
    setOwnerStatus('拉取失败：' + err.message, 'err')
  }
}

function openOwnerPanel() {
  const modal = el('ownerModal')
  if (modal) modal.classList.remove('hidden')
  const input = el('keyInput')
  if (input && !input.value) {
    try {
      input.value = localStorage.getItem(LS_KEY) || ''
    } catch (_) {}
  }
  const workerInput = el('workerInput')
  if (workerInput) workerInput.value = workerBase()
  const adminInput = el('adminInput')
  if (adminInput && !adminInput.value) {
    try {
      adminInput.value = localStorage.getItem(LS_ADMIN) || ''
    } catch (_) {}
  }
  refreshHealth()
}

function closeOwnerPanel() {
  const modal = el('ownerModal')
  if (modal) modal.classList.add('hidden')
}

function showSuccessModal(no) {
  const modal = el('successModal')
  const noEl = el('succNo')
  if (!modal || !noEl) return
  noEl.textContent = '#' + no
  modal.classList.remove('hidden')
}

function hideSuccessModal() {
  const modal = el('successModal')
  if (modal) modal.classList.add('hidden')
}

async function unlock() {
  const input = el('keyInput')
  const pem = input ? input.value.trim() : ''
  if (!pem) {
    setOwnerStatus('请先粘贴站长私钥（PEM），或选择 .pem 文件。', 'err')
    return
  }
  setOwnerStatus('正在导入私钥…')
  try {
    privateKey = await importPrivateKey(pem)
    try {
      localStorage.setItem(LS_KEY, pem)
    } catch (_) {}
    panelUnlocked = true
    const lockBtn = el('btnLock')
    if (lockBtn) lockBtn.style.display = 'inline-flex'
    const section = el('postSection')
    if (section) section.style.display = 'block'
    setOwnerStatus('私钥导入成功，正在拉取留言…', 'ok')
    await loadPosts()
  } catch (err) {
    privateKey = null
    panelUnlocked = false
    setOwnerStatus('私钥导入失败：' + err.message, 'err')
  }
}

function lockPanel() {
  privateKey = null
  panelUnlocked = false
  const input = el('keyInput')
  if (input) input.value = ''
  const lockBtn = el('btnLock')
  if (lockBtn) lockBtn.style.display = 'none'
  const section = el('postSection')
  if (section) section.style.display = 'none'
  renderPosts([])
  setOwnerStatus('已锁定，私钥已从内存清除。')
}

async function saveWorkerBase() {
  const input = el('workerInput')
  const value = (input ? input.value : '').trim().replace(/\/+$/, '')
  try {
    if (value) localStorage.setItem(LS_WORKER, value)
    else localStorage.removeItem(LS_WORKER)
  } catch (_) {}
  setOwnerStatus(value ? '已保存后端地址：' + value : '已清除后端地址（退回纯实时模式）')
  await refreshHealth()
  await pollBackend()
}

async function testNotify() {
  const input = el('adminInput')
  const token = (input ? input.value : '').trim()
  if (!token) {
    setOwnerStatus('请先填写 ADMIN_TOKEN（与 Worker secret 一致）', 'err')
    return
  }
  try {
    localStorage.setItem(LS_ADMIN, token)
  } catch (_) {}
  setOwnerStatus('正在向各通知通道发送测试消息…')
  try {
    const res = await apiPost('/api/notify-test', '', { 'X-Admin-Token': token })
    const lines = (res.channels || []).map((c) => `${c.ok ? '✅' : '❌'} ${c.channel}：${c.detail}`)
    const skipped = (res.skipped || []).map((s) => `➖ ${s}：未配置`)
    setOwnerStatus(`发送成功 ${res.sent} 个 / 失败 ${res.failed} 个\n${lines.concat(skipped).join('\n')}`, res.failed ? 'err' : 'ok')
    toast(`通知自测完成：成功 ${res.sent}，失败 ${res.failed}`)
  } catch (err) {
    setOwnerStatus('自测失败：' + err.message, 'err')
  }
}

async function askNotifyPermission() {
  if (typeof Notification === 'undefined') {
    toast('当前浏览器不支持通知，请使用手机 PWA 或改用 Bark 推送')
    return
  }
  const perm = await Notification.requestPermission()
  notifyPermission = perm
  const btn = el('btnNotify')
  if (btn) btn.textContent = perm === 'granted' ? '通知已开启' : '开启通知'
  if (perm === 'granted') {
    new Notification('留言板通知已开启', { body: '有新留言时会在这里提醒你', icon: './icon-192.png' })
    toast('浏览器通知已开启')
  } else {
    toast('通知权限被拒绝，可改用 Bark 手机推送')
  }
}

function bindEvents() {
  if (dropEl) {
    dropEl.addEventListener('click', () => fileEl.click())
  }
  fileEl.addEventListener('change', (e) => {
    selectedFile = e.target.files[0] || null
    renderPreview()
  })
  for (const evt of ['dragover', 'dragenter']) {
    dropEl.addEventListener(evt, (e) => {
      e.preventDefault()
      e.stopPropagation()
    })
  }
  dropEl.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      selectedFile = e.dataTransfer.files[0]
      fileEl.value = e.dataTransfer.files[0]
      renderPreview()
    }
  })
  submitBtn.addEventListener('click', postMessage)

  const succOkBtn = el('succOk')
  if (succOkBtn) {
    succOkBtn.addEventListener('click', hideSuccessModal)
    document.querySelectorAll('#successModal [data-close], #successModal .modal-mask').forEach((node) => {
      node.addEventListener('click', hideSuccessModal)
    })
  }

  const ownerBtn = el('btnOwner')
  if (ownerBtn) ownerBtn.addEventListener('click', openOwnerPanel)
  const ownerClose = el('ownerClose')
  if (ownerClose) ownerClose.addEventListener('click', closeOwnerPanel)
  const ownerMask = document.querySelector('#ownerModal .owner-mask')
  if (ownerMask) ownerMask.addEventListener('click', closeOwnerPanel)

  const keyFile = el('keyFile')
  if (keyFile) {
    keyFile.addEventListener('change', async (e) => {
      const f = e.target.files[0]
      if (!f) return
      const text = await f.text()
      const input = el('keyInput')
      if (input) input.value = text
      unlock()
    })
  }
  const unlockBtn = el('btnUnlock')
  if (unlockBtn) unlockBtn.addEventListener('click', unlock)
  const lockBtn = el('btnLock')
  if (lockBtn) lockBtn.addEventListener('click', lockPanel)
  const refreshBtn = el('btnRefresh')
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadPosts())
  const saveWorkerBtn = el('btnSaveWorker')
  if (saveWorkerBtn) saveWorkerBtn.addEventListener('click', saveWorkerBase)
  const testBtn = el('btnTestNotify')
  if (testBtn) testBtn.addEventListener('click', testNotify)
  const notifyBtn = el('btnNotify')
  if (notifyBtn) {
    notifyBtn.textContent = notifyPermission === 'granted' ? '通知已开启' : '开启通知'
    notifyBtn.addEventListener('click', askNotifyPermission)
  }
  const installBtn = el('btnInstall')
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (!installPrompt) {
        toast('iPhone 请用 Safari「分享 → 添加到主屏幕」；安卓请用浏览器菜单「安装应用」')
        return
      }
      installPrompt.prompt()
      const res = await installPrompt.userChoice
      if (res && res.outcome === 'accepted') toast('已添加到桌面')
      installPrompt = null
      installBtn.style.display = 'none'
    })
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    hideSuccessModal()
    closeOwnerPanel()
  })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollBackend()
  })
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    installPrompt = e
    const btn = el('btnInstall')
    if (btn) btn.style.display = 'inline-flex'
  })
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('./sw.js').catch(() => {})
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'lss-open-owner') openOwnerPanel()
  })
}

function start() {
  bindEvents()
  registerServiceWorker()
  renderCount()
  ensureClient().catch(() => {})
  refreshHealth()
  pollBackend()
  setInterval(pollBackend, POLL_MS)
  setInterval(renderCount, 5000)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start)
} else {
  start()
}
