# AutoCert

AutoCert 是一个用于签发 Let's Encrypt 通配符证书的前后端项目。前端提供域名注册、密码登录、签发进度和证书地址复制界面；后端负责 Cloudflare DNS-01 验证、ACME 签发、D1 元数据存储和 R2 证书文件存储。

## 功能

- 自动签发 `*.example.com` 通配符证书
- 使用 Cloudflare DNS-01 完成域名验证
- 每个域名独立保存 Cloudflare API Token 和访问密码
- 每个域名独立保存 ACME account key
- 证书文件保存到 Cloudflare R2
- 证书元数据、密码哈希、加密后的 Token 和 ACME account key 保存到 Cloudflare D1
- 前端实时展示签发进度
- 证书页支持下载证书包
- 证书页支持分别复制 `fullchain.cer` 和 `{domain}.key` 的 R2 固定访问地址

## 目录结构

```text
auto-cert/
  backend/
    app/                  # FastAPI 后端代码
    config.example.yaml   # 后端配置模板
    docker-compose.yaml   # 后端容器编排
    Dockerfile
    requirements.txt
    start.sh              # 本地启动后端
  frontend/
    src/                  # React 前端代码
    package.json
```

## 后端配置

后端只读取 `config.yaml`，不从环境变量读取业务配置。复制模板：

```bash
cd backend
cp config.example.yaml config.yaml
```

配置示例：

```yaml
logging:
  dir: ./logs
  level: INFO

cloudflare:
  account_id: replace-me
  api_token: replace-me
  d1:
    database_id: replace-me
  r2:
    bucket: auto-cert
    access_key_id: replace-me
    secret_access_key: replace-me
    region: auto
    key_prefix: auto-cert
    public_base_url: ""

security:
  encryption_key: replace-me
```

`security.encryption_key` 用于加密保存 Cloudflare Token 和 ACME account key。生成方式：

```bash
python3 -c "import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())"
```

如果希望前端复制出来的 R2 地址可以直接访问，需要在 Cloudflare R2 给 bucket 配置公开域名或自定义域名，并填写：

```yaml
cloudflare:
  r2:
    public_base_url: https://certs.example.com
```

不配置时，后端会按 `r2_endpoint_url/{bucket}/{object_key}` 拼接固定地址。

## 数据库

后端启动时会初始化 D1 表，表不存在才创建：

- `certificates`
- `acme_accounts`

当前版本不需要本地 `data/` 目录。

## R2 对象路径

新签发的证书会写入：

```text
{key_prefix}/certificates/{domain}/fullchain.cer
{key_prefix}/certificates/{domain}/{domain}.key
{key_prefix}/certificates/{domain}/metadata.json
```

证书下载包内包含：

- `fullchain.cer`
- `{domain}.key`
- `{domain}.cer`
- `ca.cer`

## 本地开发

启动后端：

```bash
cd backend
./start.sh
```

启动前端：

```bash
cd frontend
npm install
npm run dev
```

前端开发服务器默认运行在 `http://localhost:3000`，并把 `/api` 代理到 `http://localhost:8000`。

## Docker 部署后端

后端镜像发布到 GitHub Container Registry：

```text
ghcr.io/kohlarnhin/auto-cert-backend:latest
```

服务器不需要前端代码，也不需要后端源码构建镜像。只需要准备：

- `config.yaml`
- `docker-compose.yaml`
- `logs/`

启动：

```bash
mkdir -p logs
docker compose pull
docker compose up -d
```

`docker-compose.yaml` 会挂载：

```text
./config.yaml -> /app/config.yaml
./logs        -> /app/logs
```

## 后端镜像发布

GitHub Actions workflow 位于 `.github/workflows/backend-docker.yml`。

推送后端发布 tag 会自动构建并推送镜像：

```bash
git tag backend-v1.0.0
git push origin backend-v1.0.0
```

发布后可使用：

```text
ghcr.io/kohlarnhin/auto-cert-backend:backend-v1.0.0
ghcr.io/kohlarnhin/auto-cert-backend:latest
```

也可以在 GitHub Actions 页面手动运行 `Publish Backend Docker Image`。

## 前端部署

前端可以独立部署到 Vercel。因为前端使用相对路径请求 `/api`，部署时需要让 `/api/*` 转发到后端服务地址，或者把前后端部署在同一域名下。

常用命令：

```bash
cd frontend
npm run lint
npm run build
```

## 安全说明

- `backend/config.yaml` 不应提交到 Git。
- R2 固定地址如果可公开访问，私钥文件 `{domain}.key` 也会被公开访问。仅在你确认需要这种方式时配置公开域名。
- 用户访问证书页面仍需要域名密码；但复制出的固定 R2 地址是否受保护，取决于 R2 bucket 或自定义域名的访问控制。
