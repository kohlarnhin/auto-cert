"""AutoCert - ACME 通配符证书自动申请系统 (FastAPI)"""

import asyncio
import json
import os
import re
import zipfile
from datetime import datetime, timezone
from io import BytesIO

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from acme_service import AcmeService
from cloudflare_service import CloudflareService
import database as db

app = FastAPI(title="AutoCert", version="2.0.0")

# ── 全局状态 ──

is_applying = False
log_queues: list[asyncio.Queue] = []


async def broadcast_log(message: str, level: str = "info", step: str = ""):
    event = {
        "message": message,
        "level": level,
        "time": datetime.now().strftime("%H:%M:%S"),
        "step": step,
    }
    dead = []
    for q in log_queues:
        try:
            q.put_nowait(event)
        except Exception:
            dead.append(q)
    for q in dead:
        log_queues.remove(q)


# ── 数据模型 ──

class ConfigRequest(BaseModel):
    api_token: str


class CertApplyRequest(BaseModel):
    domain: str
    staging: bool = False


# ── API: 配置 ──

@app.get("/api/config")
async def get_config():
    token = db.get_config("cloudflare_api_token")
    masked = ""
    if token:
        masked = token[:8] + "..." + token[-4:] if len(token) > 12 else "****"
    return {"has_token": bool(token), "masked_token": masked}


@app.post("/api/config")
async def save_config(req: ConfigRequest):
    token = req.api_token.strip()
    if not token:
        raise HTTPException(400, "API Token 不能为空")

    cf = CloudflareService(api_token=token)
    try:
        valid = await cf.verify_token()
    except Exception as e:
        raise HTTPException(400, f"验证失败: {e}")
    finally:
        await cf.close()

    if not valid:
        raise HTTPException(400, "API Token 无效")

    db.set_config("cloudflare_api_token", token)
    return {"success": True, "message": "配置已保存并验证通过"}


@app.post("/api/config/verify")
async def verify_config():
    token = db.get_config("cloudflare_api_token")
    if not token:
        return {"success": False, "message": "未配置 API Token"}
    cf = CloudflareService(api_token=token)
    try:
        valid = await cf.verify_token()
        return {"success": valid, "message": "验证通过" if valid else "Token 无效"}
    except Exception as e:
        return {"success": False, "message": str(e)}
    finally:
        await cf.close()


# ── API: 证书 ──

DOMAIN_RE = re.compile(r"^[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$")


@app.post("/api/cert/apply")
async def apply_cert(req: CertApplyRequest):
    global is_applying

    domain = req.domain.strip().lower()
    if domain.startswith("*."):
        domain = domain[2:]

    if not DOMAIN_RE.match(domain):
        raise HTTPException(400, "域名格式不正确，请输入顶级域名如 example.com")

    parts = domain.split(".")
    if len(parts) > 2:
        raise HTTPException(400, "请输入顶级域名（如 example.com），不支持子域名")

    if is_applying:
        raise HTTPException(409, "正在申请中，请等待当前任务完成")

    token = db.get_config("cloudflare_api_token")
    if not token:
        raise HTTPException(400, "请先配置 Cloudflare API Token")

    # 检查是否已存在有效证书
    existing = db.get_cert(domain)
    if existing and existing["status"] == "valid":
        raise HTTPException(409, f"*.{domain} 已有有效证书，如需重新申请请先删除")

    # 创建或更新记录
    if not existing:
        db.create_cert_record(domain)
    else:
        db.update_cert(domain, status="pending", created_at=datetime.now(timezone.utc).isoformat())

    is_applying = True
    asyncio.create_task(_run_apply(domain, token, req.staging))
    return {"success": True, "message": f"已开始申请 *.{domain} 证书"}


async def _run_apply(domain: str, token: str, staging: bool):
    global is_applying
    cf = CloudflareService(api_token=token)
    try:
        acme = AcmeService(staging=staging)
        acme.set_log_callback(broadcast_log)
        await acme.apply_certificate(domain, cf, staging=staging)

        # 申请成功 → 保存到数据库
        import os as _os
        from acme_service import CERTS_DIR

        cert_dir = _os.path.join(CERTS_DIR, domain)
        fullchain = ""
        privkey = ""
        if _os.path.exists(_os.path.join(cert_dir, "fullchain.pem")):
            with open(_os.path.join(cert_dir, "fullchain.pem")) as f:
                fullchain = f.read()
        if _os.path.exists(_os.path.join(cert_dir, "privkey.pem")) :
            with open(_os.path.join(cert_dir, "privkey.pem")) as f:
                privkey = f.read()

        # 解析到期时间
        expires_at = ""
        if fullchain:
            from cryptography import x509
            cert_obj = x509.load_pem_x509_certificate(fullchain.encode())
            expires_at = cert_obj.not_valid_after_utc.isoformat()

        db.update_cert(
            domain,
            fullchain_pem=fullchain,
            privkey_pem=privkey,
            status="valid",
            issued_at=datetime.now(timezone.utc).isoformat(),
            expires_at=expires_at,
        )
    except Exception:
        db.update_cert(domain, status="failed")
    finally:
        is_applying = False
        try:
            await cf.close()
        except Exception:
            pass


@app.get("/api/cert/check/{domain:path}")
async def check_domain(domain: str):
    """检查域名状态：是否已有证书、是否已配置 Token"""
    domain = domain.strip().lower()
    cert = db.get_cert(domain)
    has_token = bool(db.get_config("cloudflare_api_token"))
    return {
        "domain": domain,
        "has_token": has_token,
        "cert": cert,
    }


@app.get("/api/cert/list")
async def list_certs():
    return {"certs": db.list_certs()}


@app.get("/api/cert/download/{domain:path}")
async def download_cert(domain: str):
    files = db.get_cert_files(domain)
    if not files or not files["fullchain_pem"]:
        raise HTTPException(404, "证书不存在或尚未签发")

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{domain}/fullchain.pem", files["fullchain_pem"])
        zf.writestr(f"{domain}/privkey.pem", files["privkey_pem"])
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{domain}.zip"'},
    )


@app.delete("/api/cert/{domain:path}")
async def delete_cert(domain: str):
    cert = db.get_cert(domain)
    if not cert:
        raise HTTPException(404, "证书不存在")
    db.delete_cert(domain)
    return {"success": True}


# ── API: SSE 日志 ──

@app.get("/api/logs")
async def sse_logs(request: Request):
    queue: asyncio.Queue = asyncio.Queue()
    log_queues.append(queue)

    async def stream():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            if queue in log_queues:
                log_queues.remove(queue)

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.get("/api/status")
async def get_status():
    return {"applying": is_applying}


# ── 静态文件 ──

os.makedirs("static", exist_ok=True)
app.mount("/", StaticFiles(directory="static", html=True), name="static")
