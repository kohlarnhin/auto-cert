# AutoCert Frontend

AutoCert 前端基于 React 和 Vite。生产环境部署到 Vercel，浏览器只访问同源 `/api/*`，由 `frontend/api/[...path].js` 代理到 Cloudflare Worker。

## 本地开发

先启动 Worker：

```bash
cd ../worker
npm install
npx wrangler dev
```

再启动前端：

```bash
npm install
npm run dev
```

开发服务器默认运行在 `http://localhost:3000`，`/api` 会代理到 `http://localhost:8787`。如果 Worker dev 地址不同：

```bash
VITE_BACKEND_DEV_URL=http://localhost:8787 npm run dev
```

## Vercel 后端代理

Vercel 项目需要配置服务端环境变量：

```text
BACKEND_URL=https://auto-cert-api.example.workers.dev
```

`BACKEND_URL` 不会暴露给浏览器。

## 构建

```bash
npm run lint
npm run build
```
