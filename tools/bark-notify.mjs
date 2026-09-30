import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { webcrypto as crypto } from 'node:crypto'
import mqtt from 'mqtt'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATHS = [
  path.join(HERE, 'bark.config.json'),
  path.join(HERE, '..', 'bark.config.json'),
]

const DEFAULT_BROKERS = [
  'wss://broker-cn.emqx.io:8084/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
]

function loadConfig() {
  let file = {}
  for (const p of CONFIG_PATHS) {
    if (fs.existsSync(p)) {
      try {
        file = JSON.parse(fs.readFileSync(p, 'utf8'))
        console.log(`[cfg] 读取配置 ${p}`)
      } catch (err) {
        console.error(`[cfg] ${p} 解析失败：${err.message}`)
      }
    }
  }
  const cfg = {
    barkKey: process.env.BARK_KEY || file.barkKey || '',
    barkUrl: (process.env.BARK_URL || file.barkUrl || 'https://api.day.app').replace(/\/+$/, ''),
    barkGroup: process.env.BARK_GROUP || file.barkGroup || 'lss-board',
    barkSound: process.env.BARK_SOUND || file.barkSound || 'minuet.caf',
    privateKeyPath: process.env.PRIVATE_KEY_PATH || file.privateKeyPath || '',
    topicPrefix: process.env.LSS_TOPIC_PREFIX || file.topicPrefix || 'lss/board/',
    siteUrl: (process.env.SITE_URL || file.siteUrl || '').replace(/\/+$/, ''),
    brokers: (process.env.MQTT_BROKERS ? process.env.MQTT_BROKERS.split(',') : file.brokers) || DEFAULT_BROKERS,
    logFile: process.env.LOG_FILE || file.logFile || '',
    notifyOnTest: process.env.NOTIFY_ON_TEST !== '0',
  }
  return cfg
}

const cfg = loadConfig()

if (!cfg.barkKey) {
  console.error('缺少 Bark device key。任选一种配置方式：')
  console.error('  1) 环境变量  setx BARK_KEY "你的device_key"')
  console.error('  2) 配置文件  tools\\bark.config.json  {"barkKey":"你的device_key"}')
  process.exit(1)
}

function log(...args) {
  const line = args.join(' ')
  console.log(line)
  if (!cfg.logFile) return
  try {
    fs.appendFileSync(cfg.logFile, `${new Date().toISOString()} ${line}\n`)
  } catch (_) {}
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function pemBody(pem) {
  return String(pem)
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '')
}

function derLen(n) {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  let x = n
  while (x > 0) {
    bytes.unshift(x & 0xff)
    x >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function der(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content])
}

function rsaPkcs1ToPkcs8(b64) {
  const oid = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01])
  const algId = der(0x30, Buffer.concat([oid, Buffer.from([0x05, 0x00])]))
  return der(0x30, Buffer.concat([Buffer.from([0x02, 0x01, 0x00]), algId, der(0x04, Buffer.from(b64, 'base64'))]))
}

let privateKey = null
if (cfg.privateKeyPath) {
  const file = path.resolve(HERE, '..', cfg.privateKeyPath)
  try {
    const pem = fs.readFileSync(file, 'utf8')
    const der = pem.includes('BEGIN RSA PRIVATE KEY') ? rsaPkcs1ToPkcs8(pemBody(pem)) : Buffer.from(pemBody(pem), 'base64')
    privateKey = await crypto.subtle.importKey('pkcs8', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['unwrapKey'])
    log(`[key] 已载入私钥 ${file}，通知将包含明文内容`)
  } catch (err) {
    log(`[key] 私钥载入失败（${err.message}），通知将只含编号与链接，不含明文`)
    privateKey = null
  }
} else {
  log('[key] 未配置 privateKeyPath，通知只含编号/时间/链接（不含明文）。填入后可推完整内容。')
}

function fmtTime(ts) {
  const d = new Date(ts || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function buildBody(no, createdAt, meta, hasMedia) {
  const lines = [`编号 #${no}`, `时间 ${fmtTime(createdAt)}`]
  if (meta) {
    if (meta.name) lines.push(`昵称 ${meta.name}`)
    if (meta.price) lines.push(`价格 ￥${meta.price}`)
    if (meta.contact) lines.push(`联系 ${meta.contact}`)
    if (meta.media) lines.push(`附件 ${meta.media.name}（${Math.round((meta.media.size || 0) / 1024)}KB）`)
    if (meta.message) lines.push('', meta.message.length > 400 ? meta.message.slice(0, 400) + '…' : meta.message)
  } else {
    lines.push('', '（未提供私钥，内容为密文）')
  }
  if (hasMedia) lines.push('', '含加密附件，请在后台解密查看')
  if (cfg.siteUrl) lines.push('', cfg.siteUrl)
  return lines.join('\n')
}

async function pushBark(title, body, url) {
  const res = await fetch(`${cfg.barkUrl}/${encodeURIComponent(cfg.barkKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      body,
      group: cfg.barkGroup,
      isArchive: 1,
      level: 'timeSensitive',
      sound: cfg.barkSound,
      url: url || cfg.siteUrl || undefined,
    }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
  let data = {}
  try {
    data = JSON.parse(text)
  } catch (_) {}
  if (data.code && data.code !== 200) throw new Error(`code ${data.code} ${data.message || ''}`)
  return data
}

async function decryptMeta(env) {
  if (!privateKey) return null
  try {
    const aes = await crypto.subtle.unwrapKey(
      'raw',
      Buffer.from(env.wrapped, 'base64'),
      privateKey,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    )
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(env.metaIv, 'base64') },
      aes,
      Buffer.from(env.metaCt, 'base64')
    )
    return JSON.parse(Buffer.from(plain).toString('utf8'))
  } catch (err) {
    log(`[warn] 解密失败（私钥不匹配？）：${err.message}`)
    return null
  }
}

const seen = new Map()
let counter = 0

async function onMessage(topic, payload) {
  if (!topic.startsWith(cfg.topicPrefix)) return
  let env = null
  try {
    env = JSON.parse(payload.toString('utf8'))
  } catch (_) {}
  if (!env || !env.id || seen.has(env.id)) return
  seen.set(env.id, Date.now())
  counter++
  if (seen.size > 500) seen.delete(seen.keys().next().value)

  const meta = env.metaCt ? await decryptMeta(env) : null
  const hasMedia = !!env.mediaCipher || !!env.mediaName
  const body = buildBody(counter, env.createdAt, meta, hasMedia)
  if (env.notice && !meta) {
    log(`[notice] #${counter} 仅通知（未带明文）`)
  } else {
    log(`[msg] #${counter} ${meta ? meta.name || '匿名' : '(密文)'}`)
  }
  try {
    await pushBark(`新留言 #${counter}`, body)
    log(`[bark] OK #${counter}`)
  } catch (err) {
    log(`[bark] FAIL #${counter} ${err.message}`)
  }
}

async function start() {
  log(`[boot] Bark ${cfg.barkUrl}  group=${cfg.barkGroup}  topic=${cfg.topicPrefix}#`)
  if (cfg.notifyOnTest) {
    try {
      await pushBark('留言板监听已启动', `时间 ${fmtTime()}\n监听 ${cfg.topicPrefix}# 的新留言\n${cfg.siteUrl || ''}`)
      log('[bark] 启动测试推送已发送')
    } catch (err) {
      log(`[bark] 启动测试推送失败 ${err.message}（请检查 device key）`)
    }
  }

  let connected = false
  for (const url of cfg.brokers) {
    try {
      const client = mqtt.connect(url, { clientId: 'lss-bark-' + Math.random().toString(36).slice(2, 10), reconnectPeriod: 5000 })
      client.on('connect', () => {
        connected = true
        client.subscribe(cfg.topicPrefix + '#')
        log(`[mqtt] 已连接 ${url}`)
      })
      client.on('message', onMessage)
      client.on('error', (e) => log('[mqtt] error ' + e.message))
      client.on('reconnect', () => log('[mqtt] 重连中…'))
      client.on('close', () => {
        if (connected) log('[mqtt] 连接断开，自动重连')
        connected = false
      })
      process.on('SIGINT', () => {
        log('[exit] 正在退出…')
        client.end(true, () => process.exit(0))
        setTimeout(() => process.exit(0), 1500)
      })
      return
    } catch (err) {
      log(`[mqtt] 连接 ${url} 失败：${err.message}`)
    }
  }
  process.exit(1)
}

start()
