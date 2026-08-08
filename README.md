# 留言板（Video / Image Message Board）

纯静态托管（GitHub Pages）+ Cloudflare Worker 后台转发，无需自建服务器。

## 功能

- 访客无需注册，直接上传 **1 个视频或图片**。
- 可填写**价格**、**联系方式**、**留言内容**。
- **端到端加密（E2EE）**：所有留言内容（文字 + 文件）都用随机的 AES-256-GCM 密钥加密，密钥再用站长 RSA-2048 公钥（RSA-OAEP）包裹后上传。
- **仅站长可解密**：服务器、GitHub 仓库、任何中间人看到的都只是密文；只有站长在页面粘贴自己的私钥解锁后，才能看到真实文字与视频/图片。
- 私钥只保存在站长本人浏览器的 localStorage 中，不会上传。

## 站长密钥

- 私钥文件：`桌面\留言板站长私钥.pem`（**请自行备份，切勿提交到仓库或发给任何人**）。
- 公钥已内嵌在 `src/app.js` 顶部的 `OWNER_PUBLIC_KEY_PEM` 中（公钥公开无风险）。

## 架构

| 组件 | 用途 |
| ---- | ---- |
| GitHub Pages | 托管静态页面（index.html + bundle.js） |
| Cloudflare Worker | 转发接口，内部持有 GitHub token（不暴露给浏览器）；提供 `/api/media` 直接转发媒体密文 |
| GitHub repo | 存储加密后的媒体（uploads/）与加密留言（data/posts/） |
| esbuild | 把 src/app.js 打包为 bundle.js |

## 部署

### 1. 部署 Cloudflare Worker

在 `worker/` 目录：

```bash
npm install
npx wrangler login        # 浏览器登录 Cloudflare
npx wrangler secret put GITHUB_TOKEN   # 输入你的 GitHub Personal Access Token
npx wrangler deploy
```

部署成功后得到 Worker 地址（类似 `https://lss-board.<你的子域>.workers.dev`）。

### 2. 配置前端

将 `src/app.js` 顶部的 `WORKER_BASE` 改成你的 Worker 地址，然后：

```bash
npm install
npm run build
```

### 3. 推送 GitHub

把改动提交并推送到仓库默认分支（`main`），GitHub Pages 即自动生效。

> 注意：GitHub Pages 需要在仓库 Settings → Pages 中开启，Source 选择主分支根目录。

### 4. 站长查看留言

打开站点 → 点右上角「🔑 站长查看」→ 粘贴或选择 `留言板站长私钥.pem` → 解锁后可查看全部明文留言与媒体。

## 本地开发

```bash
npm install
npm run build       # 生成 bundle.js
npm run dev --prefix worker   # 本地调试 Worker
```

## 限流说明

- 浏览器侧单文件最大 95MB（GitHub Contents API 单文件上限 100MB）。
- 存储的全部为密文；站长私钥始终只在你本机，不参与任何网络传输。