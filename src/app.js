const WORKER_BASE = 'https://lss-board.lssboard.workers.dev'
const LS_KEY = 'lss_owner_priv'

const OWNER_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3CxtqUliQkJkfmh31i0E
UGUihnthDqzOecJt/AuWQQXRRNVAgThSxpjUefS/mu5/ut5sWH0aXOp0BNrXoa0T
r/80PXsTdP5H3TEcx7ZdELl+LJ/goFa70OwJgkFkL4uEtMNMKsJZ2UHl/kpqawrd
VthNBylosjGRljkv2Pats0HZvG8y47zmvBbQLO8VYrTf/jSHnnoxiOE9PS+0+wnK
tpwoLuHoRsRxF0wwDbE0P1poNh29l8ZoPzibq15w0l33rJNmVA+qcjN7NyI4JA5K
2ZhIhNDCIQuaTQhkEpx/qLTiiBYSKff4ISLBcT1WMcv8Ym3Q05wrtqZj1WTXXuNh
3QIDAQAB
-----END PUBLIC KEY-----`

const $ = (id) => document.getElementById(id)

const nameEl = $('name')
const fileEl = $('file')
const dropEl = $('drop')
const previewEl = $('preview')
const priceEl = $('price')
const contactEl = $('contact')
const msgEl = $('message')
const submitBtn = $('submit')
const statusEl = $('status')
const refreshBtn = $('refresh')
const cntEl = $('cnt')
const emptyEl = $('empty')
const listEl = $('list')
const ownerBtn = $('owner-btn')
const ownerlockBadge = $('ownerlock-badge')

let selectedFile = null
let posting = false
let ownerKey = null
let posts = []

// ---------------- crypto helpers ----------------

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

async function importOwnerPrivateKey(pem) {
  const body = pem
    .replace(/-----BEGIN .*?-----/, '')
    .replace(/-----END .*?-----/, '')
    .replace(/\s+/g, '')
  const der = base64ToBytes(body)
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt', 'unwrapKey'])
}

async function newAesKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

// encrypt a post: text meta + optional file; returns {enc, fileBlob}
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

async function decryptPost(post) {
  const enc = JSON.parse(new TextDecoder().decode(base64ToBytes(post.enc)))
  const aes = await crypto.subtle.unwrapKey(
    'raw',
    base64ToBytes(enc.wrapped),
    ownerKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  )
  const metaRaw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(enc.meta.iv) },
    aes,
    base64ToBytes(enc.meta.ct),
  )
  const meta = JSON.parse(new TextDecoder().decode(metaRaw))

  let media = null
  if (enc.media && post.media && post.media.path) {
    try {
      const res = await fetch(WORKER_BASE + '/api/media?path=' + encodeURIComponent(post.media.path))
      if (res.ok) {
        const buf = await res.arrayBuffer()
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: base64ToBytes(enc.media.iv) },
          aes,
          buf,
        )
        media = {
          kind: (meta.media && (meta.media.mime || '').startsWith('video')) ? 'video' : 'image',
          mime: meta.media && meta.media.mime,
          blob: new Blob([plain], { type: meta.media && meta.media.mime ? meta.media.mime : 'application/octet-stream' }),
        }
        media.url = URL.createObjectURL(media.blob)
      }
    } catch (_) {
      media = null
    }
  }
  return { meta, media }
}

function toast(msg) {
  const el = $('toast')
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

function fmtTime(t) {
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch (_) {
    return ''
  }
}

function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
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

function setStatus(text, cls) {
  statusEl.textContent = text
  statusEl.className = 'status-bar' + (cls ? ' ' + cls : '')
}

async function postMessage() {
  if (posting) return
  const message = msgEl.value.trim()
  const price = priceEl.value.trim()
  const contact = contactEl.value.trim()
  if (!selectedFile && !message && !price && !contact) {
    toast('请选择文件或填写留言')
    return
  }
  if (selectedFile && selectedFile.size > 95 * 1024 * 1024) {
    toast('文件过大，单个文件最大 95MB')
    return
  }

  posting = true
  submitBtn.disabled = true
  setStatus('正在本地加密并上传，请稍候…')
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
    setStatus('已加密保存成功', 'ok')
    toast('提交成功（内容已加密）')
    selectedFile = null
    fileEl.value = ''
    priceEl.value = ''
    contactEl.value = ''
    msgEl.value = ''
    nameEl.value = ''
    renderPreview()
    loadPosts()
  } catch (err) {
    setStatus('提交失败：' + err.message, 'err')
    toast('提交失败：' + err.message)
  } finally {
    posting = false
    submitBtn.disabled = false
  }
}

// ---------------- owner view ----------------

function showOwnerPanel() {
  const modal = document.createElement('div')
  modal.className = 'owner-modal'
  const card = document.createElement('div')
  card.className = 'owner-card'
  card.innerHTML = `
    <h3>🔑 站长解密查看</h3>
    <p class="owner-tip">粘贴你的 <b>站长私钥</b>（PEM 文本），或选择私钥文件。私钥仅保存在本机浏览器，不会上传。</p>
    <textarea id="owner-pem" rows="8" placeholder="-----BEGIN PRIVATE KEY-----
…"></textarea>
    <div class="owner-btns">
      <label class="btn ghost small" style="cursor:pointer">选择文件<input type="file" id="owner-file" accept=".pem,.key,.txt" style="display:none"></label>
      <button class="btn primary" id="owner-unlock">解锁并查看</button>
      <button class="btn danger" id="owner-lock" style="display:none">锁定</button>
      <button class="btn ghost" id="owner-close">关闭</button>
    </div>
    <div class="status-bar" id="owner-status"></div>
  </div>`
  const off = document.createElement('div')
  off.className = 'owner-mask'
  off.onclick = () => modal.remove()
  modal.appendChild(off)
  modal.appendChild(card)
  document.body.appendChild(modal)

  $('owner-close').onclick = () => modal.remove()
  $('owner-file').onchange = (e) => {
    const f = e.target.files[0]
    if (!f) return
    const r = new FileReader()
    r.onload = () => { $('owner-pem').value = String(r.result) }
    r.readAsText(f)
  }
  $('owner-unlock').onclick = async () => {
    const pem = $('owner-pem').value.trim()
    const st = $('owner-status')
    if (!pem) { st.textContent = '请先粘贴私钥'; st.className = 'status-bar err'; return }
    try {
      ownerKey = await importOwnerPrivateKey(pem)
      localStorage.setItem(LS_KEY, pem)
      st.textContent = '✅ 已解锁，正在解密…'
      st.className = 'status-bar ok'
      ownerlockBadge.classList.remove('hidden')
      $('owner-unlock').style.display = 'none'
      $('owner-lock').style.display = ''
      renderPosts()
    } catch (err) {
      st.textContent = '私钥无效：' + err.message
      st.className = 'status-bar err'
    }
  }
  $('owner-lock').onclick = () => {
    ownerKey = null
    localStorage.removeItem(LS_KEY)
    $('owner-pem').value = ''
    $('owner-status').textContent = '已锁定'
    $('owner-unlock').style.display = ''
    $('owner-lock').style.display = 'none'
    ownerlockBadge.classList.add('hidden')
    renderPosts()
  }
}

// ---------------- render ----------------

async function renderPosts() {
  if (!posts.length) {
    cntEl.textContent = '0'
    emptyEl.classList.remove('hidden')
    listEl.textContent = ''
    return
  }
  emptyEl.classList.add('hidden')
  const frag = document.createDocumentFragment()
  for (const p of posts) {
    if (p.enc && ownerKey) {
      try {
        const r = await decryptPost(p)
        frag.appendChild(renderCard(r.meta, r.media, p))
        continue
      } catch (_) {
        frag.appendChild(renderLocked(p, true))
        continue
      }
    }
    frag.appendChild(renderLocked(p))
  }
  listEl.textContent = ''
  cntEl.textContent = String(posts.length)
  listEl.appendChild(frag)
}

function renderLocked(p) {
  const card = document.createElement('div')
  card.className = 'post'
  const media = document.createElement('div')
  media.className = 'media'
  const tag = document.createElement('span')
  tag.className = 'tag'
  tag.textContent = '🔒 已加密'
  media.appendChild(tag)
  card.appendChild(media)
  const body = document.createElement('div')
  body.className = 'body'
  const lock = document.createElement('div')
  lock.className = 'lock-hint'
  lock.textContent = ownerKey ? '解密失败' : '内容已端到端加密，仅站长可查看'
  body.appendChild(lock)
  const meta = document.createElement('div')
  meta.className = 'meta'
  const time = document.createElement('span')
  time.textContent = fmtTime(p.createdAt)
  meta.appendChild(time)
  body.appendChild(meta)
  card.appendChild(body)
  return card
}

function renderCard(meta, media, p) {
  const card = document.createElement('div')
  card.className = 'post'
  const m = document.createElement('div')
  m.className = 'media'
  if (media) {
    if (media.kind === 'video') {
      const v = document.createElement('video')
      v.src = media.url
      v.controls = true
      v.preload = 'metadata'
      m.appendChild(v)
    } else {
      const img = document.createElement('img')
      img.src = media.url
      img.loading = 'lazy'
      m.appendChild(img)
    }
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = media.kind === 'video' ? '🎬 视频' : '🖼 图片'
    m.appendChild(tag)
  } else {
    const tag = document.createElement('span')
    tag.className = 'tag'
    tag.textContent = '✏️ 文字'
    m.appendChild(tag)
  }
  card.appendChild(m)
  const body = document.createElement('div')
  body.className = 'body'
  if (meta.price) {
    const price = document.createElement('div')
    price.className = 'price'
    price.textContent = '¥ ' + meta.price
    body.appendChild(price)
  }
  if (meta.contact) {
    const contact = document.createElement('div')
    contact.className = 'contact'
    contact.textContent = '📞 ' + meta.contact
    body.appendChild(contact)
  }
  if (media) {
    const dl = document.createElement('a')
    dl.className = 'contact'
    dl.href = media.url
    dl.download = (meta.media && meta.media.name) || 'media'
    dl.textContent = '⬇️ 下载 ' + ((meta.media && meta.media.name) || '')
    body.appendChild(dl)
  }
  if (meta.message) {
    const msg = document.createElement('div')
    msg.className = 'msg'
    msg.textContent = meta.message
    body.appendChild(msg)
  }
  const metaRow = document.createElement('div')
  metaRow.className = 'meta'
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = meta.name || p.name || '匿名'
  metaRow.appendChild(name)
  const time = document.createElement('span')
  time.textContent = fmtTime(p.createdAt)
  metaRow.appendChild(time)
  body.appendChild(metaRow)
  card.appendChild(body)
  return card
}

async function loadPosts() {
  try {
    const res = await fetch(WORKER_BASE + '/api/posts')
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '加载失败')
    posts = data.posts || []
    cntEl.textContent = String(posts.length)
    renderPosts()
  } catch (err) {
    toast('加载留言失败，请检查后台服务')
    emptyEl.classList.remove('hidden')
    emptyEl.textContent = '加载失败：' + err.message + '（请确认 Worker 已部署并修改了 WORKER_BASE）'
  }
}

// ---------------- events ----------------

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
refreshBtn.addEventListener('click', loadPosts)
ownerBtn.addEventListener('click', showOwnerPanel)

const savedPem = localStorage.getItem(LS_KEY)
if (savedPem) {
  importOwnerPrivateKey(savedPem).then((k) => {
    ownerKey = k
  }).catch(() => localStorage.removeItem(LS_KEY))
}

renderPreview()
loadPosts()