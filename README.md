# AutoCert

AutoCert 用于签发 Let's Encrypt 通配符证书。前端部署到 Vercel；后端完全运行在 Cloudflare Worker 上，使用 D1 保存元数据和加密密钥，使用 R2 保存证书文件，使用 Workflows 执行 ACME 签发流程。

## 功能

- 自动签发 `example.com` 和 `*.example.com` 证书
- 使用 Cloudflare DNS-01 完成 ACME 验证
- 每个域名独立保存访问密码、Cloudflare API Token 和 ACME account key
- Cloudflare API Token 和 ACME account key 使用 `ENCRYPTION_KEY` 加密后写入 D1
- 证书文件写入 R2：`fullchain.cer`、`{domain}.key`、`metadata.json`
- 前端通过 Vercel `/api/*` 代理访问 Worker，浏览器不直连后端
- 签发进度通过 Worker SSE 接口按域名推送
- 证书页支持下载 zip 包，并分别复制 `fullchain.cer` 和 `{domain}.key` 的 R2 固定地址

## 目录结构

```text
auto-cert/
  worker/                 # Cloudflare Worker 后端
    src/                  # API、ACME、D1、R2、Workflow 代码
    schema.sql            # D1 表结构参考，Worker 运行时会自动创建表
    wrangler.toml.example # Worker 配置模板，不含真实资源 ID
  frontend/               # React + Vite 前端
    api/[...path].js      # Vercel 后端代理
    src/
```

## Cloudflare 资源

先创建 D1 和 R2：

```bash
cd worker
npm install
npx wrangler d1 create auto-cert
npx wrangler r2 bucket create auto-cert
```

真实的 `worker/wrangler.toml` 不提交到 Git。先复制模板：

```bash
cp wrangler.toml.example wrangler.toml
```

把 `wrangler d1 create` 输出的 `database_id` 写入本地 `worker/wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "auto-cert"
database_id = "真实-d1-database-id"
```

如果 R2 bucket 名不是 `auto-cert`，同步修改：

```toml
[[r2_buckets]]
binding = "CERT_BUCKET"
bucket_name = "auto-cert"
```

## Worker 配置

`worker/wrangler.toml` 里常用变量：

```toml
[vars]
R2_KEY_PREFIX = "auto-cert"
R2_PUBLIC_BASE_URL = "https://certs.example.com"
CORS_ORIGINS = "*"
```

`R2_PUBLIC_BASE_URL` 是 R2 公开域名或自定义域名。配置后，前端复制的证书地址会是：

```text
https://certs.example.com/auto-cert/certificates/example.com/fullchain.cer
https://certs.example.com/auto-cert/certificates/example.com/example.com.key
```

如果不配置 `R2_PUBLIC_BASE_URL`，接口只能返回 R2 object key，不会是可直接访问的公网 URL。

设置加密密钥：

```bash
openssl rand -base64 32
npx wrangler secret put ENCRYPTION_KEY
```

`ENCRYPTION_KEY` 必须是 32 字节的 base64/base64url 字符串。这个密钥用于加密每个域名保存的 Cloudflare Token 和 ACME account key。

Worker 运行时会自动执行 `CREATE TABLE IF NOT EXISTS` 初始化表结构，不会删除已有数据。你只需要提前创建 D1 数据库资源，并在 Cloudflare Builds 的环境变量里配置 `CLOUDFLARE_D1_DATABASE_ID`。

## 后端部署

手动部署 Worker：

```bash
cd worker
npm install
cp wrangler.toml.example wrangler.toml
# 填好 wrangler.toml 里的 D1 database_id、R2 bucket_name、R2_PUBLIC_BASE_URL
npm run typecheck
npx wrangler deploy
```

后端发布由 GitHub Actions 和 Cloudflare Builds 配合完成：

- GitHub Actions 只在 `backend-v*` tag 推送时运行
- Actions 把 tag 对应 commit 强制推进到 `backend-release` 分支
- Cloudflare 监听 `backend-release` 分支并部署 Worker

发布命令：

```bash
git tag backend-v1.0.0
git push origin backend-v1.0.0
```

GitHub Actions 不需要 Cloudflare API Token。workflow 只需要仓库写权限来更新 `backend-release`，已经在 `.github/workflows/backend-worker.yml` 中配置：

```yaml
permissions:
  contents: write
```

Cloudflare Workers Builds 配置：

```text
Git repository: kohlarnhin/auto-cert
Production branch: backend-release
Root directory: worker
Build command: npm install && npm run typecheck
Deploy command: npm run deploy:cloudflare
```

Cloudflare Builds 需要配置环境变量：

```text
CLOUDFLARE_D1_DATABASE_ID=d1-database-id
ENCRYPTION_KEY=32-byte-base64-key
```

可选环境变量：

```text
CLOUDFLARE_R2_BUCKET_NAME=auto-cert
R2_PUBLIC_BASE_URL=https://certs.example.com
```

Cloudflare 会在自己的构建环境里运行 `npm run deploy:cloudflare`，该脚本会从 `worker/wrangler.toml.example` 生成真实 `wrangler.toml`，并通过 `--secrets-file` 发布 `ENCRYPTION_KEY`。真实 D1 database ID 不提交到 GitHub。

回退时可以把 `backend-release` 指回旧 tag：

```bash
git fetch origin --tags
git push origin backend-v0.0.6:refs/heads/backend-release --force
```

## 前端部署

前端部署到 Vercel：

```text
Framework Preset: Vite
Root Directory: frontend
Build Command: npm run build
Output Directory: dist
```

Vercel 项目需要配置服务端环境变量：

```text
BACKEND_URL=https://auto-cert-api.<your-subdomain>.workers.dev
```

`BACKEND_URL` 是 Worker 的公网地址，不要以 `/` 结尾。这个变量只在 Vercel Serverless Function 中读取，不会暴露给浏览器。

前端发布 workflow 位于 `.github/workflows/frontend-vercel.yml`。只有推送 `frontend-v*` tag 才会发布前端：

```bash
git tag frontend-v1.0.0
git push origin frontend-v1.0.0
```

如果使用 GitHub Actions 发布到 Vercel，需要配置：

```text
VERCEL_TOKEN=vercel-token
VERCEL_ORG_ID=vercel-org-id
VERCEL_PROJECT_ID=vercel-project-id
```

如果希望严格做到“只有 `frontend-v*` tag 才发布”，需要在 Vercel 项目中关闭或忽略默认 Git 自动部署。

## 本地开发

启动 Worker：

```bash
cd worker
npm install
npx wrangler dev
```

启动前端：

```bash
cd frontend
npm install
npm run dev
```

前端开发服务器默认运行在 `http://localhost:3000`，并把 `/api` 代理到 `http://localhost:8787`。如果 Worker dev 地址不同，可以设置：

```bash
VITE_BACKEND_DEV_URL=http://localhost:8787 npm run dev
```

## API

Worker 对前端提供这些接口：

```text
GET    /api/cert/exists/{domain}
POST   /api/cert/register
POST   /api/cert/apply
GET    /api/cert/check/{domain}
GET    /api/cert/download/{domain}
POST   /api/cert/urls/{domain}
DELETE /api/cert/{domain}
GET    /api/logs?domain={domain}
GET    /api/status
```

`check`、`download`、`urls`、`delete` 需要请求头：

```text
X-Domain-Password: your-domain-password
```

## 安全说明

- 用户输入的 Cloudflare API Token 是“每个域名一份”，不是项目全局 Token。
- 每个域名独立保存一个 ACME account key。
- R2 固定公网地址如果可以直接访问，私钥文件 `{domain}.key` 也会被直接访问。只在你明确接受这种方式时配置公开域名。
- Worker 运行时不需要 `config.yaml`、`docker-compose.yaml`、服务器目录挂载或 Python 环境。
