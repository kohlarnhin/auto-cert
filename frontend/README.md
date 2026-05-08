# AutoCert Frontend

AutoCert 前端基于 React 和 Vite，负责域名输入、密码登录、Cloudflare Token 录入、证书签发进度展示、证书包下载和 R2 证书地址复制。

## 本地开发

```bash
npm install
npm run dev
```

开发服务器默认运行在 `http://localhost:3000`，`/api` 会代理到 `http://localhost:8000`。

## 构建

```bash
npm run lint
npm run build
```

生产部署到 Vercel 时，需要将 `/api/*` 转发到后端服务，或者让前端和后端处于同一域名下。
