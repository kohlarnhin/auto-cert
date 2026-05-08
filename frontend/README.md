# AutoCert Frontend

AutoCert 前端基于 React 和 Vite，负责域名输入、密码登录、Cloudflare Token 录入、证书签发进度展示、证书包下载和 R2 证书地址复制。

## 本地开发

```bash
npm install
npm run dev
```

开发服务器默认运行在 `http://localhost:3000`，`/api` 会代理到 `http://localhost:8000`。

## Vercel 后端代理

生产环境下，浏览器只请求 Vercel 同源的 `/api/*`，再由 Vercel 代理到真实后端。Vercel 项目需要配置服务端环境变量：

```text
BACKEND_URL=https://api.example.com
```

`BACKEND_URL` 不会暴露给浏览器。本地开发不配置时默认使用相对路径 `/api`，并由 Vite dev server 代理到本地后端。

## 构建

```bash
npm run lint
npm run build
```

生产部署到 Vercel 时，`frontend/api/[...path].js` 会代理 `/api/*` 到 `BACKEND_URL`。
