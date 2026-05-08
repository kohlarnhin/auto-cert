"""Certificate management API routes."""

import asyncio
import logging
import zipfile
from datetime import datetime, timezone
from io import BytesIO

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from app.api.deps import normalize_domain, validate_root_domain, verify_domain_auth
from app.core import state
from app.db import database as db
from app.schemas.certificates import CertApplyRequest, RegisterRequest
from app.services.acme import AcmeService
from app.services.cloudflare import CloudflareService
from app.storage.r2 import get_storage

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/cert", tags=["certificates"])


async def _verify_cloudflare_token(token: str) -> None:
    cf = CloudflareService(api_token=token)
    try:
        valid = await cf.verify_token()
        if not valid:
            raise HTTPException(400, "Cloudflare API Token 无效")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f"Token 验证失败: {exc}") from exc
    finally:
        await cf.close()


@router.get("/exists/{domain:path}")
async def check_exists(domain: str):
    domain = normalize_domain(domain)
    return {"exists": await db.get_cert(domain) is not None}


@router.post("/register")
async def register_domain(req: RegisterRequest):
    domain = validate_root_domain(req.domain)

    if not req.cf_token:
        raise HTTPException(400, "需要提供 Cloudflare API Token")
    if not req.password:
        raise HTTPException(400, "需要提供访问密码")

    existing = await db.get_cert(domain)
    if existing:
        raise HTTPException(409, "该域名已注册")

    await _verify_cloudflare_token(req.cf_token)
    success = await db.create_cert_record(domain, db.hash_password(req.password), req.cf_token)
    if not success:
        raise HTTPException(409, "记录创建失败")

    return {"success": True, "message": f"{domain} 已注册，可以开始签发"}


@router.post("/apply")
async def apply_cert(req: CertApplyRequest):
    domain = validate_root_domain(req.domain)

    if state.is_applying():
        raise HTTPException(409, "正在申请中，请等待当前任务完成")

    existing = await db.get_cert(domain)
    if existing:
        if existing["password_hash"] != db.hash_password(req.password or ""):
            raise HTTPException(401, "访问密码错误")

        token = existing["cf_token"]
        if existing["status"] == "valid":
            expires_at_str = existing.get("expires_at")
            if expires_at_str:
                try:
                    expires_at = datetime.fromisoformat(expires_at_str.replace("Z", "+00:00"))
                    days_left = (expires_at - datetime.now(timezone.utc)).days
                    if days_left > 10:
                        raise HTTPException(409, f"*.{domain} 已有有效证书（还剩 {days_left} 天过期），无需重新申请")
                except ValueError:
                    pass
            else:
                raise HTTPException(409, f"*.{domain} 已有有效证书，如需重新申请请先删除")

        await db.update_cert(
            domain,
            status="pending",
            created_at=datetime.now(timezone.utc).isoformat(),
        )
    else:
        if not req.cf_token:
            raise HTTPException(400, "新域名注册需要提供 Cloudflare API Token")
        if not req.password:
            raise HTTPException(400, "新域名注册需要提供访问密码")

        await _verify_cloudflare_token(req.cf_token)
        token = req.cf_token
        success = await db.create_cert_record(domain, db.hash_password(req.password), req.cf_token)
        if not success:
            raise HTTPException(409, "记录创建失败（可能由于并发导致重复创建）")

    state.start_apply(domain)
    asyncio.create_task(_run_apply(domain, token, req.staging))
    return {"success": True, "message": f"已开始申请 *.{domain} 证书"}


async def _run_apply(domain: str, token: str, staging: bool) -> None:
    cf = CloudflareService(api_token=token)
    try:
        acme = AcmeService(staging=staging)
        acme.set_log_callback(state.broadcast_log)
        cert_result = await acme.apply_certificate(domain, cf, staging=staging)
        object_keys = await get_storage().save_certificate(
            domain,
            cert_result["fullchain_pem"],
            cert_result["privkey_pem"],
            cert_result["metadata"],
        )

        await db.update_cert(
            domain,
            fullchain_key=object_keys["fullchain_key"],
            privkey_key=object_keys["privkey_key"],
            metadata_key=object_keys["metadata_key"],
            status="valid",
            issued_at=cert_result["issued_at"],
            expires_at=cert_result["expires_at"],
        )
    except Exception as exc:
        await state.broadcast_log(f"申请失败: {str(exc)}", "error")
        logger.exception("Certificate apply failed for %s", domain)
        await db.update_cert(domain, status="error")
    finally:
        await cf.close()
        state.finish_apply()


@router.get("/check/{domain:path}")
async def check_domain(domain: str, cert: dict = Depends(verify_domain_auth)):
    domain = normalize_domain(domain)
    payload = {"status": cert["status"], "expires_at": cert.get("expires_at")}
    if cert.get("status") == "valid" and cert.get("fullchain_key") and cert.get("privkey_key"):
        payload.update(
            get_storage().get_certificate_urls(
                domain,
                cert["fullchain_key"],
                cert["privkey_key"],
            )
        )
    return payload


@router.get("/list")
async def list_certs():
    return []


@router.get("/download/{domain:path}")
async def download_cert(domain: str, cert: dict = Depends(verify_domain_auth)):
    domain = normalize_domain(domain)
    files = await db.get_cert_files(domain)
    if not files or not files["fullchain_pem"]:
        raise HTTPException(404, "证书不存在或尚未签发")

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        fullchain = files["fullchain_pem"]
        privkey = files["privkey_pem"]
        parts = [
            p.strip() + "\n-----END CERTIFICATE-----\n"
            for p in fullchain.split("-----END CERTIFICATE-----")
            if p.strip()
        ]

        zf.writestr(f"{domain}/fullchain.cer", fullchain)
        zf.writestr(f"{domain}/{domain}.key", privkey)
        if parts:
            zf.writestr(f"{domain}/{domain}.cer", parts[0])
            if len(parts) > 1:
                zf.writestr(f"{domain}/ca.cer", "".join(parts[1:]))

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{domain}.zip"'},
    )


@router.post("/urls/{domain:path}")
async def copy_cert_urls(domain: str, cert: dict = Depends(verify_domain_auth)):
    domain = normalize_domain(domain)
    if cert.get("status") != "valid":
        raise HTTPException(404, "证书不存在或尚未签发")

    fullchain_key = cert.get("fullchain_key")
    privkey_key = cert.get("privkey_key")
    if not fullchain_key or not privkey_key:
        raise HTTPException(404, "证书文件不存在")

    storage = get_storage()
    return storage.get_certificate_urls(domain, fullchain_key, privkey_key)


@router.delete("/{domain:path}")
async def delete_cert(domain: str, cert: dict = Depends(verify_domain_auth)):
    domain = normalize_domain(domain)
    await get_storage().delete_certificate_files(
        cert.get("fullchain_key"),
        cert.get("privkey_key"),
        cert.get("metadata_key"),
    )
    await db.update_cert(
        domain,
        fullchain_key=None,
        privkey_key=None,
        metadata_key=None,
        status="none",
        issued_at=None,
        expires_at=None,
    )
    return {"success": True, "message": "证书已删除"}
