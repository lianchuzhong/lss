# 留言板（Video / Image Message Board）

纯静态前端（GitHub Pages）+ Cloudflare Worker 后端。访客上传 1 个视频或图片并留言，**内容端到端加密（E2EE）**，服务器与仓库里只有密文；新留言会通过 **7 个通道**推送到手机 / 微信 / 邮箱。

## 功能

- 访客无需注册，提交昵称、价格、联系方式、留言文字 + 1 个视频或图片
- 端到端加密：留言文字与文件用随机 AES-256-GCM 密钥加密，密钥再用站长 RSA-2048 公钥（RSA-OAEP / SHA-256）包裹
- 仅站长可解密：私钥只存在站长自己浏览器的 localStorage，不参与任何网络传输
- 站长后台：粘贴私钥即可查看全部明文留言与视频/图片，支持一键锁定
- 实时更新：MQTT over WSS 广播新留言，配合浏览器 Web Notification 弹窗提醒
- PWA：可「添加到主屏幕」，装到手机后也能收到系统通知
- 限流与防护：单 IP 限流、附件大小限制、媒体路径白名单校验

## 通知通道（全部可独立开关）

| 通道 | 形式 | 需要的配置 |
| --- | --- | --- |
| `github` | 自动创建 GitHub Issue → **按账号设置发邮件到邮箱** | `GITHUB_TOKEN`（需 `issues:write`） |
| `bark` | **iOS / Android 手机系统级推送**（可设重要提醒、声音、角标、点击跳转） | `BARK_KEY`（+ 可选 `BARK_URL`） |
| `pushplus` | 微信服务号推送 | `PUSHPLUS_TOKEN` |
| `serverchan` | Server酱³ 微信推送 | `SERVERCHAN_KEY` |
| `wecom` | 企业微信群机器人 | `WECOM_WEBHOOK` |
| `email` | 自定义邮件（Resend） | `RESEND_API_KEY` + `MAIL_TO` |
| `webhook` | 任意自定义 webhook（钉钉 / 飞书 / 你的服务） | `WEBHOOK_URL`（+ 可选 `WEBHOOK_SECRET`） |

通知内容**只含留言编号、提交时间、附件有无和后台链接**，不包含任何留言正文或媒体密文。

## 架构

| 组件 | 用途 |
| --- | --- |
| GitHub Pages | 托管静态页面（index.html + bundle.js + sw.js + manifest） |
| Cloudflare Worker | 接收加密留言、写入仓库、扇出通知、代理媒体密文、限流 |
| GitHub repo | 存储加密媒体 `uploads/`、加密留言 `data/posts/`、索引 `data/index.json` |
| esbuild | 把 `src/app.js` 打包为 `bundle.js` |
| 公共 MQTT broker | 仅用于实时广播（新留言 ID），不落库、不传密文 |

## 部署

### 1. 部署 Cloudflare Worker

```bash
cd worker
npm install
npx wrangler login

npx wrangler secret put GITHUB_TOKEN     # 必需：GitHub PAT，权限 repo + issues:write
npx wrangler secret put ADMIN_TOKEN      # 强烈建议：自测接口的管理口令
npx wrangler secret put BARK_KEY         # 手机推送（推荐）
npx wrangler secret put PUSHPLUS_TOKEN   # 微信兜底（可选）
npx wrangler secret put SERVERCHAN_KEY   # 微信兜底（可选）
npx wrangler secret put WECOM_WEBHOOK    # 企业微信（可选）
npx wrangler secret put RESEND_API_KEY   # 邮件（可选）
npx wrangler secret put MAIL_TO          # 收件邮箱（可选）
npx wrangler secret put WEBHOOK_URL      # 自定义 webhook（可选）

npx wrangler deploy
```

非密钥配置在 `worker/wrangler.toml` 的 `[vars]`：`GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_BRANCH`、`SITE_URL`、`BARK_URL`、`BARK_GROUP`、`BARK_SOUND`、`RATE_MAX`、`RATE_WINDOW_MIN`、`MEDIA_MAX_BYTES`。

部署后得到地址，例如 `https://lss-board.<你的子域>.workers.dev`。

### 2. 配置前端

前端默认 `DEFAULT_WORKER_BASE = ''`（空），**不需要重新构建**：站长首次打开站点时点「🔑 站长查看」→ 在「后端 Worker 地址」填入地址 → 「保存并检测」，会存入 localStorage。

也可以把 `src/app.js` 顶部的 `DEFAULT_WORKER_BASE` 改成你的 Worker 地址并 `npm run build`，让所有访客都自动走后端。

```bash
npm install
npm run build      # 生成 bundle.js
```

### 3. 推送 GitHub

提交并推送到默认分支（`main`），GitHub Pages 自动生效。需在仓库 Settings → Pages 中开启，Source 选择主分支根目录。

### 5. 手机推送（Bark，推荐）

1. App Store / 应用市场安装 **Bark**（iOS / Android 均可）
2. 打开 App 得到自己的服务器地址与 device key，例如 `https://api.day.app` + `xxxxxxxx`
3. 两种配置方式，任选其一：

**方式 A：Cloudflare Worker 推送（24/7，不需要电脑开机）**

```bash
npx wrangler secret put BARK_KEY         # 粘贴 device key
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

**方式 B：本机监听脚本推送（零云端，5 分钟搞定，电脑需保持开机）**

```bash
copy tools\bark.config.example.json bark.config.json
notepad bark.config.json      # 填 barkKey；填了 privateKeyPath 则通知含明文内容
npm run notify
```

脚本会订阅站点的新留言，用你的私钥解密后把「编号 / 昵称 / 价格 / 联系方式 / 留言」推送到手机（启动时先发一条测试通知确认 key 正确）。想开机自启可用 `schtasks /create /sc onlogon /tn lss-bark /tr "node E:\桌面1\lss\lss-main\tools\bark-notify.mjs"`。

> 注意：方式 B 走公共 MQTT 通道，未配置 `DEFAULT_WORKER_BASE` 的访客留言会经过该通道，因此能收到；一旦改用 Worker 提交，留言不再进 MQTT，方式 B 就收不到了（此时用方式 A）。两者可并存：Worker 负责落库+通知，脚本作为本地备份。

4. 站点 →「🔑 站长查看」→ 填 `ADMIN_TOKEN` → 点「向所有通道发送测试通知」，1 秒内手机应收到

### 4. 站长查看留言

1. 拿到 `留言板站长私钥.pem`（PKCS#8 或 PKCS#1 均可导入）
2. 站点 →「🔑 站长查看」→ 粘贴私钥或选择 `.pem` 文件 → 「解锁查看」
3. 全部明文留言与视频/图片显示在页面下方，看完点「锁定」

## 私钥

- 私钥只保存在站长本人浏览器的 localStorage 中，不会上传
- 私钥文件请自行备份，**切勿提交到仓库或发给任何人**
- 公钥已内嵌在 `src/app.js` 顶部的 `OWNER_PUBLIC_KEY_PEM`（公钥公开无风险）
- 万一私钥彻底丢失：打开 `tools/keygen.html`（或 `https://<你的站点>/tools/keygen.html`）在本地生成新的 RSA-2048 密钥对，把新公钥替换进 `src/app.js` 的 `OWNER_PUBLIC_KEY_PEM` 后重新构建。**注意：换公钥后此前所有留言将无法解密。**

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 后端状态、各通知通道是否就绪、限流与附件上限 |
| GET | `/api/posts` | 留言索引（不含密文），1 次请求 |
| GET | `/api/posts?full=1` | 全部留言密文（供站长解密） |
| GET | `/api/post?id=` | 单条留言密文 |
| POST | `/api/post` | 提交留言（multipart：`enc` + 可选 `file`），落库并触发通知 |
| GET | `/api/media?path=uploads/xxx.bin` | 媒体密文转发（路径白名单校验） |
| POST | `/api/notify-test` | 通知通道自测，需 `X-Admin-Token` |
| POST | `/api/prune?max=N` | 只保留最近 N 条留言，需 `X-Admin-Token` |

## 本地开发与测试

```bash
npm install
npm run build                    # 生成 bundle.js
npm run dev --prefix worker      # 本地调试 Worker
npm test --prefix worker         # Worker 端到端冒烟测试（mock GitHub API + 全部通知通道）
```

## 限流与安全说明

- 单 IP 默认 10 分钟 5 条（`RATE_MAX` / `RATE_WINDOW_MIN` 可调）
- 附件默认上限 45MB（`MEDIA_MAX_BYTES`；未配置后端时前端退回 450KB 实时模式）
- 存储的全部为密文；站长私钥始终只在本机，不参与任何网络传输
- 媒体转发只允许 `uploads/<id>.bin` 形式，拒绝路径穿越
