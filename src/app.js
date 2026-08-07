import mqtt from 'mqtt'

const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
]
const PREFIX = 'lss/'
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
]
const HEARTBEAT_MS = 8000
const STALE_MS = 25000

const $ = (id) => document.getElementById(id)

const entryEl = $('entry')
const studioEl = $('studio')
const watchEl = $('watch')
const roomInput = $('room')
const broadcastBtn = $('broadcast-btn')
const watchBtn = $('watch-btn')

const sDot = $('s-dot')
const sRoom = $('s-room')
const sStatus = $('s-status')
const sViewers = $('s-viewers')
const startBtn = $('start-btn')
const stopBtn = $('stop-btn')
const sLeave = $('s-leave')
const localVideo = $('local-video')
const sPlaceholder = $('s-placeholder')
const sViewerList = $('s-viewer-list')
const sChat = $('s-chat')
const sMsg = $('s-msg')
const sSend = $('s-send')

const wDot = $('w-dot')
const wRoom = $('w-room')
const wStatus = $('w-status')
const wLeave = $('w-leave')
const remoteVideo = $('remote-video')
const wPlaceholder = $('w-placeholder')
const wChat = $('w-chat')
const wMsg = $('w-msg')
const wSend = $('w-send')

let client = null
let room = null
let role = null
let myId = uid()
let myName = '观众-' + Math.random().toString(36).slice(2, 6)
let localStream = null
let pcs = new Map()
let pc = null
let hostId = null
let hostOnline = false
let chatKey = null
let viewers = new Map()
let lastSeen = new Map()
let heartbeatTimer = null
let cleanupTimer = null
let retryTimer = null
let messages = []
let sysLog = []
let seenIds = new Set()

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

function sanitizeRoom(raw) {
  return (raw || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 40) || 'default'
}

function topicTo(id) { return PREFIX + room + '/to/' + id }
function chatTopic() { return PREFIX + room + '/chat' }
function hostTopic() { return PREFIX + room + '/host' }
function viewerTopic(id) { return PREFIX + room + '/viewer/' + id }

function b64(buf) {
  let bin = ''
  for (const b of buf) bin += String.fromCharCode(b)
  return btoa(bin)
}
function unb64(s) {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function deriveChatKey(roomName) {
  const enc = new TextEncoder()
  const base = await crypto.subtle.importKey('raw', enc.encode(roomName), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('lss-chat/' + roomName), iterations: 60000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function encryptChat(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, chatKey, new TextEncoder().encode(text))
  return { iv: b64(iv), data: b64(new Uint8Array(ct)) }
}

async function decryptChat(m) {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(m.iv) }, chatKey, unb64(m.data))
    return new TextDecoder().decode(pt)
  } catch (_) { return null }
}

function sendTo(id, obj) {
  if (client) client.publish(topicTo(id), JSON.stringify(obj), { qos: 1 })
}

function toCandidateObj(c) {
  if (c.toJSON) return c.toJSON()
  return { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex }
}

function enter(mode) {
  const r = sanitizeRoom(roomInput.value)
  room = r
  role = mode
  chatKey = null
  deriveChatKey(r).then((k) => { chatKey = k })

  entryEl.classList.add('hidden')
  if (mode === 'host') {
    studioEl.classList.remove('hidden')
    sRoom.textContent = r
    setStudioStatus('连接中…', false)
  } else {
    watchEl.classList.remove('hidden')
    wRoom.textContent = r
    showWatchPlaceholder('等待主播开播…')
    setWatchStatus('连接中…', false)
  }

  client = mqtt.connect(BROKERS[0], {
    clientId: 'lss-' + myId,
    reconnectPeriod: 2000,
    connectTimeout: 15000,
    will: role === 'host'
      ? { topic: hostTopic(), payload: JSON.stringify({ id: myId, online: false, t: Date.now() }), qos: 1, retain: true }
      : { topic: viewerTopic(myId), payload: JSON.stringify({ online: false, t: Date.now() }), qos: 1, retain: true },
  })

  client.on('connect', onConnect)
  client.on('close', () => {
    if (role === 'host') setStudioStatus('连接断开，重连中…', false)
    else setWatchStatus('连接断开，重连中…', false)
  })
  client.on('error', () => {})
  client.on('message', onMessage)
}

function onConnect() {
  client.subscribe(topicTo(myId), { qos: 1 })
  client.subscribe(chatTopic())
  if (role === 'host') {
    client.subscribe(PREFIX + room + '/viewer/+')
    publishHostPresence()
    heartbeatTimer = setInterval(publishHostPresence, HEARTBEAT_MS)
    cleanupTimer = setInterval(cleanupStale, 5000)
    if (localStream) setStudioStatus('直播中', true)
  } else {
    client.subscribe(hostTopic())
    publishViewerPresence()
    heartbeatTimer = setInterval(publishViewerPresence, HEARTBEAT_MS)
  }
}

function publishHostPresence() {
  client.publish(hostTopic(), JSON.stringify({ id: myId, name: '主播', t: Date.now(), online: true }), { qos: 1, retain: true })
}

function publishViewerPresence() {
  client.publish(viewerTopic(myId), JSON.stringify({ name: myName, t: Date.now(), online: true }), { qos: 1, retain: true })
}

function onMessage(topic, payload) {
  const str = payload.toString()
  if (topic.indexOf('/to/') !== -1) {
    let p
    try { p = JSON.parse(str) } catch (_) { return }
    handleSignal(p)
    return
  }
  if (topic === chatTopic()) { handleChat(str); return }
  if (topic === hostTopic()) { handleHostPresence(str); return }
  if (topic.indexOf('/viewer/') !== -1) { handleViewerPresence(topic, str); return }
}

// ---- presence ----

function handleHostPresence(str) {
  let p
  try { p = JSON.parse(str) } catch (_) { return }
  if (!p || typeof p.online !== 'boolean') return
  if (p.online) {
    hostId = p.id
    hostOnline = true
    setWatchStatus('直播中', true)
    wPlaceholder.classList.add('hidden')
    remoteVideo.classList.remove('hidden')
    requestStream()
  } else if (p.id === hostId) {
    hostOnline = false
    hostId = null
    stopRemote()
    setWatchStatus('主播已停止直播', false)
    showWatchPlaceholder('主播已停止直播')
  }
}

function handleViewerPresence(topic, str) {
  if (role !== 'host') return
  let p
  try { p = JSON.parse(str) } catch (_) { return }
  if (!p || typeof p.online !== 'boolean') return
  const id = topic.slice(topic.lastIndexOf('/') + 1)
  lastSeen.set(id, Date.now())
  if (p.online) viewers.set(id, p.name || '观众')
  else viewers.delete(id)
  renderViewers()
}

function cleanupStale() {
  const now = Date.now()
  for (const [id, seen] of lastSeen) {
    if (now - seen > STALE_MS && viewers.has(id)) viewers.delete(id)
  }
  renderViewers()
}

function renderViewers() {
  sViewers.textContent = String(viewers.size)
  sViewerList.textContent = ''
  const frag = document.createDocumentFragment()
  for (const name of viewers.values()) {
    const d = document.createElement('div')
    d.className = 'viewer'
    const dot = document.createElement('span')
    dot.className = 'dot'
    const l = document.createElement('span')
    l.textContent = name
    d.appendChild(dot)
    d.appendChild(l)
    frag.appendChild(d)
  }
  sViewerList.appendChild(frag)
}

// ---- signaling ----

function handleSignal(p) {
  if (!p || !p.type) return
  if (role === 'host') {
    if (p.type === 'want-offer') onWantOffer(p)
    else if (p.type === 'answer') onAnswer(p)
    else if (p.type === 'ice') onHostIce(p)
  } else if (role === 'viewer') {
    if (p.type === 'offer') onOffer(p)
    else if (p.type === 'ice') onViewerIce(p)
  }
}

async function onWantOffer(p) {
  if (!localStream) return
  let pcv = pcs.get(p.from)
  if (!pcv) {
    pcv = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    pcs.set(p.from, pcv)
    pcv.onicecandidate = (e) => {
      if (e.candidate) sendTo(p.from, { type: 'ice', candidate: toCandidateObj(e.candidate) })
    }
    pcv.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].indexOf(pcv.connectionState) !== -1) {
        pcs.delete(p.from)
      }
    }
    for (const t of localStream.getTracks()) pcv.addTrack(t, localStream)
  }
  try {
    const offer = await pcv.createOffer()
    await pcv.setLocalDescription(offer)
    sendTo(p.from, { type: 'offer', sdp: pcv.localDescription })
  } catch (_) {}
}

async function onAnswer(p) {
  const pcv = pcs.get(p.from)
  if (pcv) {
    try { await pcv.setRemoteDescription(p.sdp) } catch (_) {}
  }
}

async function onHostIce(p) {
  const pcv = pcs.get(p.from)
  if (pcv && p.candidate) {
    try { await pcv.addIceCandidate(p.candidate) } catch (_) {}
  }
}

function requestStream() {
  if (!hostOnline || !hostId) return
  if (pc && (pc.connectionState === 'connected' || pc.connectionState === 'connecting')) return
  sendTo(hostId, { type: 'want-offer', from: myId })
}

function stopRemote() {
  if (pc) {
    pc.ontrack = null
    pc.onicecandidate = null
    pc.onconnectionstatechange = null
    try { pc.close() } catch (_) {}
    pc = null
  }
  remoteVideo.srcObject = null
}

async function onOffer(p) {
  if (role !== 'viewer') return
  if (p.from) hostId = p.from
  stopRemote()
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  pc.onicecandidate = (e) => {
    if (e.candidate) sendTo(hostId, { type: 'ice', candidate: toCandidateObj(e.candidate) })
  }
  pc.ontrack = (e) => {
    const s = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track])
    remoteVideo.srcObject = s
    setWatchStatus('直播中', true)
    wPlaceholder.classList.add('hidden')
    remoteVideo.classList.remove('hidden')
  }
  pc.onconnectionstatechange = () => {
    if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
      scheduleRetry()
    }
  }
  try {
    await pc.setRemoteDescription(p.sdp)
    const ans = await pc.createAnswer()
    await pc.setLocalDescription(ans)
    sendTo(hostId, { type: 'answer', sdp: pc.localDescription })
  } catch (_) {}
}

async function onViewerIce(p) {
  if (pc && p.candidate) {
    try { await pc.addIceCandidate(p.candidate) } catch (_) {}
  }
}

function scheduleRetry() {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    requestStream()
  }, 3000)
}

// ---- broadcast control ----

async function startBroadcast() {
  if (localStream) return
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: true,
    })
  } catch (_) {
    toast('无法获取摄像头/麦克风权限')
    return
  }
  localStream = stream
  localVideo.srcObject = stream
  sPlaceholder.classList.add('hidden')
  localVideo.classList.remove('hidden')
  startBtn.classList.add('hidden')
  stopBtn.classList.remove('hidden')
  publishHostPresence()
  setStudioStatus('直播中', true)
  sDot.classList.add('ok')
  pushSys('主播开播了')
}

function stopBroadcast() {
  if (localStream) {
    for (const t of localStream.getTracks()) t.stop()
    localStream = null
  }
  localVideo.srcObject = null
  localVideo.classList.add('hidden')
  sPlaceholder.classList.remove('hidden')
  for (const pcv of pcs.values()) { try { pcv.close() } catch (_) {} }
  pcs.clear()
  if (client) {
    client.publish(hostTopic(), JSON.stringify({ id: myId, online: false, t: Date.now() }), { qos: 1, retain: true })
  }
  startBtn.classList.remove('hidden')
  stopBtn.classList.add('hidden')
  setStudioStatus('未开播', false)
  sDot.classList.remove('ok')
  pushSys('主播已停止直播')
}

// ---- chat ----

function handleChat(str) {
  let m
  try { m = JSON.parse(str) } catch (_) { return }
  if (m && m.sys) {
    sysLog.push({ sys: true, text: m.text, t: m.t || Date.now() })
    sysLog = sysLog.slice(-30)
    renderChat()
    return
  }
  if (!m || !m.id || seenIds.has(m.id)) return
  seenIds.add(m.id)
  messages.push(m)
  renderChat()
}

function pushSys(text) {
  if (client) {
    client.publish(chatTopic(), JSON.stringify({ sys: true, text, t: Date.now() }), { qos: 0 })
  }
  sysLog.push({ sys: true, text, t: Date.now() })
  sysLog = sysLog.slice(-30)
  renderChat()
}

async function sendChat() {
  const input = role === 'host' ? sMsg : wMsg
  const text = input.value.trim()
  if (!text || !client) return
  const base = { id: uid(), sender: role === 'host' ? '主播' : myName, t: Date.now() }
  let wire
  if (chatKey) {
    const enc = await encryptChat(text)
    wire = Object.assign(base, { iv: enc.iv, data: enc.data })
  } else {
    wire = Object.assign(base, { text })
  }
  messages.push(wire)
  seenIds.add(wire.id)
  client.publish(chatTopic(), JSON.stringify(wire), { qos: 0 })
  renderChat()
  input.value = ''
  input.focus()
}

function chatBox() { return role === 'host' ? sChat : wChat }

function renderChat() {
  const box = chatBox()
  if (!box) return
  const wasAtBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24
  const items = []
  for (const m of messages) items.push(m)
  for (const s of sysLog) items.push(s)
  items.sort((a, b) => (a.t || 0) - (b.t || 0))
  const slice = items.slice(-200)
  box.textContent = ''
  const frag = document.createDocumentFragment()
  for (const m of slice) frag.appendChild(renderMsg(m))
  box.appendChild(frag)
  if (wasAtBottom) box.scrollTop = box.scrollHeight
}

function renderMsg(m) {
  const wrap = document.createElement('div')
  if (m.sys) {
    wrap.className = 'msg sys'
    const s = document.createElement('span')
    s.textContent = m.text
    wrap.appendChild(s)
    return wrap
  }
  const mine = (role === 'host' && m.sender === '主播') || (role === 'viewer' && m.sender === myName)
  wrap.className = 'msg' + (mine ? ' mine' : '')
  const meta = document.createElement('div')
  meta.className = 'meta'
  meta.textContent = m.sender + ' · ' + new Date(m.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  wrap.appendChild(meta)
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  if (m.text != null) {
    bubble.textContent = m.text
  } else {
    bubble.textContent = '正在解密…'
    decryptChat(m).then((t) => {
      bubble.textContent = (t == null) ? '[无法解密]' : t
    })
  }
  wrap.appendChild(bubble)
  return wrap
}

// ---- ui helpers ----

function setStudioStatus(t, ok) {
  sStatus.textContent = t
  sStatus.className = 'status' + (ok ? ' ok' : '')
}

function setWatchStatus(t, ok) {
  wStatus.textContent = t
  wStatus.className = 'status' + (ok ? ' ok' : '')
  wDot.className = 'dot' + (ok ? ' ok' : '')
}

function showWatchPlaceholder(t) {
  wPlaceholder.textContent = t
  wPlaceholder.classList.remove('hidden')
  remoteVideo.classList.add('hidden')
}

function teardown() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  stopRemote()
  if (localStream) {
    for (const t of localStream.getTracks()) t.stop()
    localStream = null
  }
  for (const pcv of pcs.values()) { try { pcv.close() } catch (_) {} }
  pcs.clear()
  if (client) {
    try {
      if (role === 'host') {
        client.publish(hostTopic(), JSON.stringify({ id: myId, online: false, t: Date.now() }), { qos: 1, retain: true })
      } else {
        client.publish(viewerTopic(myId), JSON.stringify({ online: false, t: Date.now() }), { qos: 1, retain: true })
      }
      client.end(true)
    } catch (_) {}
  }
  client = null
  room = null
  role = null
  hostId = null
  hostOnline = false
  pc = null
  viewers = new Map()
  lastSeen = new Map()
  messages = []
  sysLog = []
  seenIds = new Set()
  entryEl.classList.remove('hidden')
  studioEl.classList.add('hidden')
  watchEl.classList.add('hidden')
  roomInput.value = ''
  localVideo.srcObject = null
  remoteVideo.srcObject = null
  localVideo.classList.add('hidden')
  remoteVideo.classList.add('hidden')
  sPlaceholder.classList.remove('hidden')
  wPlaceholder.classList.remove('hidden')
  sChat.textContent = ''
  wChat.textContent = ''
  sViewerList.textContent = ''
  sViewers.textContent = '0'
  startBtn.classList.remove('hidden')
  stopBtn.classList.add('hidden')
  sDot.classList.remove('ok')
}

let toastTimer = null
function toast(msg) {
  const el = $('toast')
  if (!el) return
  el.textContent = msg
  el.classList.add('show')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500)
}

broadcastBtn.addEventListener('click', () => enter('host'))
watchBtn.addEventListener('click', () => enter('viewer'))
roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); enter('host') }
})
startBtn.addEventListener('click', startBroadcast)
stopBtn.addEventListener('click', stopBroadcast)
sLeave.addEventListener('click', teardown)
wLeave.addEventListener('click', teardown)
sSend.addEventListener('click', sendChat)
wSend.addEventListener('click', sendChat)
sMsg.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendChat() }
})
wMsg.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendChat() }
})
