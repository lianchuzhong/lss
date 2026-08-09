import mqtt from 'mqtt'

const BROKERS = [
  'wss://broker-cn.emqx.io:8084/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
]
const TOPIC_PREFIX = 'lss/board/'
const MAX_MEDIA_BYTES = 450 * 1024
const MAX_PAYLOAD_BYTES = 620 * 1024

const seenIds = new Set()
let counterEl = null

const OWNER_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3CxtqUliQkJkfmh31i0E
UGUihnthDqzOecJt/AuWQQXRRNVAgThSxpjUefS/mu5/ut5sWH0aXOp0BNrXoa0T
r/80PXsTdP5H3TEcx7ZdELl+LJ/goFa70OwJgkFkL4uEtMNMKsJZ2UHl/kpqawrd
VthNBylosjGRljkv2Pats0HZvG8y47zmvBbQLO8VYrTf/jSHnnoxiOE9PS+0+wnK
tpwoLuHoRsRxF0wwDbE0P1poNh29l8ZoPzibq15w0l33rJNmVA+qcjN7NyI4JA5K
2ZhIhNDCIQuaTQhkEpx/qLTiiBYSKff4ISLBcT1WMcv8Ym3Q05wrtqZj1WTXXuNh
3QIDAQAB
-----END PUBLIC KEY-----`

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

async function importOwnerPublicKey() {
  const body = OWNER_PUBLIC_KEY_PEM
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '')
  const der = base64ToBytes(body)
  return crypto.subtle.importKey('spki', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt', 'wrapKey'])
}

async function newAesKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

function toast(msg) {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = msg
  el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), 3200)
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function renderPreview() {
  previewEl.textContent = ''
  if (!selectedFile) return
  previewEl.classList.remove('hidden')
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
  name.textContent = selectedFile.name + '  ' + fmtSize(selectedFile.size)
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
    im.onload = () => { URL.revokeObjectURL(u); resolve(im) }
    im.onerror = reject
    im.src = u
  })
  let { naturalWidth: w, naturalHeight: h } = img
  const MAX = 1200
  if (w > MAX || h > MAX) {
    const r = Math.min(1, MAX / Math.max(w, h))
    w = Math.round(w * r); h = Math.round(h * r)
  }
  let bytes = null
  for (const q of [0.85, 0.7, 0.55, 0.4]) {
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    c.getContext('2d').drawImage(img, 0, 0, w, h)
    bytes = await new Promise((resolve) => {
      c.toBlob((b) => resolve(b), 'image/jpeg', q)
    })
    if (bytes && bytes.size <= MAX_MEDIA_BYTES) break
  }
  return { bytes, finalSize: bytes ? bytes.size : 0 }
}

function setStatus(text, cls) {
  statusEl.textContent = text
  statusEl.className = 'status-bar' + (cls ? ' ' + cls : '')
}

function onBoardMessage(topic, payload) {
  if (topic.indexOf(TOPIC_PREFIX) !== 0) return
  let m = null
  try { m = JSON.parse(payload.toString()) } catch (_) {}
  if (!m || !m.id) return
  const before = seenIds.size
  seenIds.add(m.id)
  if (seenIds.size !== before) renderCount()
}

function renderCount() {
  if (!counterEl) {
    counterEl = document.getElementById('msgCount')
    if (counterEl) counterEl.style.display = 'inline-block'
  }
  if (counterEl) counterEl.textContent = '已收到留言 ' + seenIds.size + ' 条（实时更新）'
}

function showSuccessModal(no) {
  const el = document.getElementById('successModal')
  const noEl = document.getElementById('succNo')
  if (!el || !noEl) return
  noEl.textContent = '#' + no
  el.classList.remove('hidden')
}

function hideSuccessModal() {
  const el = document.getElementById('successModal')
  if (el) el.classList.add('hidden')
}

let client = null
let clientReady = false

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
      try { probe.end(true) } catch (_) {}
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
  if (client) {
    await new Promise((res, rej) => {
      const inter = setInterval(() => {
        if (clientReady) { clearInterval(inter); res() }
      }, 200)
      setTimeout(() => {
        clearInterval(inter)
        try { client.end(true) } catch (_) {}
        client = null
        rej(new Error('连接恢复超时，请重试'))
      }, 18000)
    })
    return
  }
  let lastErr = null
  for (const url of BROKERS) {
    try {
      const c = await connectOne(url)
      c.options.reconnectPeriod = 3000
      c.on('connect', () => {
        clientReady = true
        try { c.subscribe(TOPIC_PREFIX + '#') } catch (_) {}
      })
      c.on('message', onBoardMessage)
      c.on('offline', () => { clientReady = false })
      c.on('close', () => { clientReady = false })
      c.on('error', () => {})
      client = c
      clientReady = true
      try { c.subscribe(TOPIC_PREFIX + '#') } catch (_) {}
      renderCount()
      return
    } catch (err) {
      lastErr = err
    }
  }
  client = null
  throw new Error((lastErr && lastErr.message) || '无法连接消息服务器')
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
  if (selectedFile && selectedFile.size > 90 * 1024 * 1024) {
    toast('文件过大，请先压缩后再上传')
    return
  }

  let mediaBytes = null
  let mediaName = ''
  let mediaMime = ''
  let mediaUnderLimit = true
  if (selectedFile) {
    mediaName = selectedFile.name
    mediaMime = selectedFile.type || 'application/octet-stream'
    if (/^image\//.test(mediaMime)) {
      const r = await shrinkImage(selectedFile)
      mediaBytes = r.bytes
      mediaUnderLimit = r.finalSize > 0
    } else {
      mediaBytes = selectedFile
      mediaUnderLimit = selectedFile.size <= MAX_MEDIA_BYTES
    }
    if (!mediaUnderLimit) {
      toast('图片/视频超过上限（约 500KB），请压缩后再提交')
      return
    }
  }

  posting = true
  submitBtn.disabled = true
  setStatus('正在加密并投递留言，请稍候…')
  try {
    const pubKey = await importOwnerPublicKey()
    const aes = await newAesKey()

    const metaRaw = JSON.stringify({
      name: nameEl.value.trim() || '匿名',
      price,
      contact,
      message,
      media: selectedFile ? { name: mediaName, mime: mediaMime, size: selectedFile.size } : null,
    })
    const metaIv = crypto.getRandomValues(new Uint8Array(12))
    const metaCt = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: metaIv },
      aes,
      new TextEncoder().encode(metaRaw)
    )

    let mediaIvB64 = null
    let mediaCipher = null
    let mediaSize = 0
    if (selectedFile && mediaBytes) {
      const buf = mediaBytes instanceof ArrayBuffer ? new Uint8Array(mediaBytes) : new Uint8Array(await mediaBytes.arrayBuffer())
      mediaSize = buf.length
      const fileIv = crypto.getRandomValues(new Uint8Array(12))
      const fileCt = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fileIv }, aes, buf)
      mediaIvB64 = bytesToBase64(fileIv)
      mediaCipher = bytesToBase64(new Uint8Array(fileCt))
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
      mediaSize,
      mediaCipher,
      mediaName: mediaName ? encodeURIComponent(mediaName) : null,
      mediaMime: mediaMime ? encodeURIComponent(mediaMime) : null,
    }
    const payloadRaw = JSON.stringify(envelope)
    if (new TextEncoder().encode(payloadRaw).length > MAX_PAYLOAD_BYTES) {
      throw new Error('内容超过大小上限，请精简留言内容')
    }

const topic = TOPIC_PREFIX + envelope.id
    let lastErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) client = null
      try {
        await ensureClient()
        await new Promise((resolve, reject) => {
          client.publish(topic, payloadRaw, { qos: 1, retain: true }, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        clientReady = false
        client = null
      }
    }
    if (lastErr) {
      const msg = /network|fetch/i.test((lastErr && lastErr.message) || '')
        ? '网络连接失败，请检查网络后重试'
        : (lastErr && lastErr.message) || '发送失败，请重试'
      throw new Error(msg)
    }

seenIds.add(envelope.id)
    renderCount()
    const ordinal = Math.max(1, seenIds.size)
    setStatus('提交成功，您是第 ' + ordinal + ' 位成功留言的访客，编号 #' + ordinal, 'ok')
    toast('提交成功')
    showSuccessModal(ordinal)
    selectedFile = null
    fileEl.value = ''
    priceEl.value = ''
    contactEl.value = ''
    msgEl.value = ''
    nameEl.value = ''
    renderPreview()
  } catch (err) {
    setStatus('提交失败：' + err.message, 'err')
    toast('提交失败：' + err.message)
  } finally {
    posting = false
    submitBtn.disabled = false
  }
}

const nameEl = document.getElementById('name')
const fileEl = document.getElementById('file')
const dropEl = document.getElementById('drop')
const previewEl = document.getElementById('preview')
const priceEl = document.getElementById('price')
const contactEl = document.getElementById('contact')
const msgEl = document.getElementById('message')
const submitBtn = document.getElementById('submit')
const statusEl = document.getElementById('status')

let selectedFile = null
let posting = false

dropEl.addEventListener('click', () => fileEl.click())
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
    fileEl.files = e.dataTransfer.files
    renderPreview()
  }
})
submitBtn.addEventListener('click', postMessage)

const succOkBtn = document.getElementById('succOk')
if (succOkBtn) {
  succOkBtn.addEventListener('click', hideSuccessModal)
  document.querySelectorAll('#successModal [data-close], #successModal .modal-mask').forEach((el) => {
    el.addEventListener('click', hideSuccessModal)
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideSuccessModal()
  })
}

ensureClient().then(renderCount).catch(() => {})