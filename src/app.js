const WORKER_BASE = 'https://lss-board.lssboard.workers.dev'

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

let selectedFile = null
let posting = false

function toast(msg) {
  const el = $('toast')
  if (!el) return
  el.textContent = msg
  el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), 2600)
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

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
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
  if (selectedFile) {
    if (!/^(image|video)\//.test(selectedFile.type)) {
      toast('仅支持图片或视频文件')
      return
    }
    if (selectedFile.size > 95 * 1024 * 1024) {
      toast('文件过大，单个最大 95MB')
      return
    }
  }

  posting = true
  submitBtn.disabled = true
  setStatus('正在上传并提交，请稍候…')
  try {
    const fd = new FormData()
    fd.append('name', nameEl.value.trim())
    fd.append('price', price)
    fd.append('contact', contact)
    fd.append('message', message)
    if (selectedFile) fd.append('file', selectedFile)

    const res = await fetch(WORKER_BASE + '/api/post', { method: 'POST', body: fd })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.error || '提交失败')
    }
    setStatus('提交成功，已保存到后台', 'ok')
    toast('提交成功！')
    selectedFile = null
    fileEl.value = ''
    priceEl.value = ''
    contactEl.value = ''
    msgEl.value = ''
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

function esc(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function fmtTime(t) {
  try {
    return new Date(t).toLocaleString('zh-CN', { hour12: false })
  } catch (_) {
    return ''
  }
}

function renderPosts(posts) {
  cntEl.textContent = String(posts.length)
  listEl.textContent = ''
  emptyEl.classList.toggle('hidden', posts.length > 0)
  if (!posts.length) return
  const frag = document.createDocumentFragment()
  for (const p of posts) {
    const card = document.createElement('div')
    card.className = 'post'
    const media = document.createElement('div')
    media.className = 'media'
    if (p.media) {
      if (p.media.type === 'video') {
        const v = document.createElement('video')
        v.src = p.media.url
        v.controls = true
        v.preload = 'metadata'
        media.appendChild(v)
        const tag = document.createElement('span')
        tag.className = 'tag'
        tag.textContent = '🎬 视频'
        media.appendChild(tag)
      } else {
        const img = document.createElement('img')
        img.src = p.media.url
        img.loading = 'lazy'
        img.alt = p.media.file || ''
        media.appendChild(img)
        const tag = document.createElement('span')
        tag.className = 'tag'
        tag.textContent = '🖼 图片'
        media.appendChild(tag)
      }
    } else {
      const tag = document.createElement('span')
      tag.className = 'tag'
      tag.textContent = '✏️ 文字'
      media.appendChild(tag)
    }
    card.appendChild(media)
    const body = document.createElement('div')
    body.className = 'body'
    if (p.price) {
      const price = document.createElement('div')
      price.className = 'price'
      price.textContent = '¥ ' + p.price
      body.appendChild(price)
    }
    if (p.contact) {
      const contact = document.createElement('div')
      contact.className = 'contact'
      contact.textContent = '📞 ' + p.contact
      body.appendChild(contact)
    }
    if (p.message) {
      const msg = document.createElement('div')
      msg.className = 'msg'
      msg.textContent = p.message
      body.appendChild(msg)
    }
    const meta = document.createElement('div')
    meta.className = 'meta'
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = p.name || '匿名'
    meta.appendChild(name)
    const time = document.createElement('span')
    time.textContent = fmtTime(p.createdAt)
    meta.appendChild(time)
    body.appendChild(meta)
    card.appendChild(body)
    frag.appendChild(card)
  }
  listEl.appendChild(frag)
}

async function loadPosts() {
  try {
    const res = await fetch(WORKER_BASE + '/api/posts')
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '加载失败')
    renderPosts(data.posts || [])
  } catch (err) {
    toast('加载留言失败，请检查后台服务')
    emptyEl.classList.remove('hidden')
    emptyEl.textContent = '加载失败：' + err.message + '（请确认 Worker 已部署并修改了 WORKER_BASE）'
  }
}

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

renderPreview()
loadPosts()