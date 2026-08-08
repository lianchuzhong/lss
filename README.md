# 留言板（Video / Image Message Board）

纯静态托管（GitHub Pages）+ Cloudflare Worker 后台转发，无需自建服务器。

## 功能

- 访客无需注册，直接上传 **1 个视频或图片**。
- 可填写**价格**、**联系方式**、**留言内容**。
- 提交成功后，媒体文件保存在 GitHub 仓库的 `uploads/`，留言元数据保存在 `data/posts/`（即“GitHub 后台”）。
- 首页自动列出所有留言，最新在前。

## 架构

| 组件 | 用途 |
| ---- | ---- |
| GitHub Pages | 托管静态页面（index.html + bundle.js） |
| Cloudflare Worker | 转发接口，内部持有 GitHub token（不暴露给浏览器） |
| GitHub repo | 存储上传的媒体（uploads/）与留言元数据（data/posts/） |
| esbuild | 把 src/app.js 打包为 bundle.js |

## 部署

### 1. 部署 Cloudflare Worker

在 `worker/` 目录：

```bash
npm install
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

## 本地开发

```bash
npm install
npm run build       # 生成 bundle.js
npm run dev --prefix worker   # 本地调试 Worker
```

## 限流说明

- GitHub Contents API 单文件上限 100MB，前端限制单文件 95MB。
- 上传为明文媒体，仓库公开则访客可直接访问文件，请勿上传隐私敏感内容（token 始终只存在于 Worker 环境变量中）。