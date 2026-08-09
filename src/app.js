const WORKER_BASE = 'https://lss-board.lssboard.workers.dev'
const MAX_FILE_MB = 90

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

async function buildEncrypted(pubKey, payload, file) {
  const aes = await newAesKey()
  const metaIv = crypto.getRandomValues(new Uint8Array(12))
  const metaCt = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: metaIv },
    aes,
    new TextEncoder().encode(JSON.stringify(payload))
  )

  let media = null
  let fileBlob = null
  if (file && file.size) {
    const buf = await file.arrayBuffer()
    const fileIv = crypto.getRandomValues(new Uint8Array(12))
    const fileCt = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fileIv }, aes, buf)
    fileBlob = new Blob([fileCt], { type: 'application/octet-stream' })
    media = { iv: bytesToBase64(fileIv), size: file.size }
  }

  const wrapped = await crypto.subtle.wrapKey('raw', aes, pubKey, { name: 'RSA-OAEP', hash: 'SHA-256' })

  const enc = {
    v: 1,
    alg: 'RSA-OAEP-256/AES-256-GCM',
    wrapped: bytesToBase64(new Uint8Array(wrapped)),
    meta: { iv: bytesToBase64(metaIv), ct: bytesToBase64(new Uint8Array(metaCt)) },
    media,
  }
  return { enc: bytesToBase64(new TextEncoder().encode(JSON.stringify(enc))), fileBlob }
}

function toast(msg) {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = msg
  el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), 2600)
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

function setStatus(text) {
  statusEl.textContent = text
  statusEl.className = 'status-bar'
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
    toast('文件过大，单个文件最大 90MB')
    return
  }

  posting = true
  submitBtn.disabled = true
  setStatus('正在加密并提交，请稍候…')
  try {
    const pubKey = await importOwnerPublicKey()
    const payload = {
      name: nameEl.value.trim() || '匿名',
      price,
      contact,
      message,
      media: selectedFile ? { name: selectedFile.name, mime: selectedFile.type, size: selectedFile.size } : null,
    }
    const { enc, fileBlob } = await buildEncrypted(pubKey, payload, selectedFile)

    const fd = new FormData()
    fd.append('enc', enc)
    if (fileBlob) fd.append('file', fileBlob, 'media.bin')

    const res = await fetch(WORKER_BASE + '/api/post', { method: 'POST', body: fd })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '提交失败')
    setStatus('提交成功，感谢留言！')
    toast('提交成功')
    selectedFile = null
    fileEl.value = ''
    priceEl.value = ''
    contactEl.value = ''
    msgEl.value = ''
    nameEl.value = ''
    renderPreview()
  } catch (err) {
    setStatus('提交失败：' + err.message)
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