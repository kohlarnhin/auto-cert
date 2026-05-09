"""Reusable API dependencies and domain validation helpers."""

import re

from fastapi import Header, HTTPException

from app.db import database as db

DOMAIN_RE = re.compile(r"^[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$")


def normalize_domain(domain: str) -> str:
    domain = domain.strip().lower()
    if domain.startswith("*."):
        domain = domain[2:]
    return domain


def validate_root_domain(domain: str) -> str:
    domain = normalize_domain(domain)
    if not DOMAIN_RE.match(domain):
        raise HTTPException(400, "域名格式不正确，请输入顶级域名如 example.com")

    if len(domain.split(".")) > 2:
        raise HTTPException(400, "请输入顶级域名（如 example.com），不支持子域名")

    return domain


async def verify_domain_auth(
    domain: str,
    x_domain_password: str | None = Header(None),
    pwd: str | None = None,
) -> dict:
    domain = normalize_domain(domain)
    password = x_domain_password or pwd
    cert = await db.get_cert(domain)
    if not cert:
        raise HTTPException(404, "域名未注册")
    if cert["password_hash"] != db.hash_password(password or ""):
        raise HTTPException(401, "访问密码错误")
    return cert
