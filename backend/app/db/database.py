"""Cloudflare D1 database module for certificate metadata."""

import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.core.config import get_settings
from app.core.crypto import decrypt_text, encrypt_text
from app.storage.r2 import get_storage

logger = logging.getLogger(__name__)


class D1QueryError(RuntimeError):
    pass


def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


class D1Database:
    def __init__(self):
        settings = get_settings()
        cf = settings.cloudflare
        self.url = (
            f"https://api.cloudflare.com/client/v4/accounts/{cf.account_id}"
            f"/d1/database/{cf.d1_database_id}/query"
        )
        self.headers = {
            "Authorization": f"Bearer {cf.api_token}",
            "Content-Type": "application/json",
        }

    async def query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {"sql": sql}
        if params is not None:
            payload["params"] = params

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(self.url, headers=self.headers, json=payload)

        try:
            data = resp.json()
        except ValueError as exc:
            raise D1QueryError(f"D1 returned non-JSON response: HTTP {resp.status_code}") from exc

        if resp.status_code >= 400 or not data.get("success", False):
            errors = data.get("errors") or data
            raise D1QueryError(f"D1 query failed: {errors}")

        result = data.get("result") or []
        if isinstance(result, dict):
            statements = [result]
        else:
            statements = result

        if not statements:
            return []

        statement = statements[0] or {}
        if not statement.get("success", True):
            raise D1QueryError(f"D1 statement failed: {statement.get('error') or statement}")

        return statement.get("results") or []


_d1: D1Database | None = None


def _client() -> D1Database:
    global _d1
    if _d1 is None:
        _d1 = D1Database()
    return _d1


async def init_db() -> None:
    """Create D1 tables when they do not already exist."""
    statements = [
        """
        CREATE TABLE IF NOT EXISTS certificates (
            domain          TEXT PRIMARY KEY,
            wildcard_domain TEXT NOT NULL,
            password_hash   TEXT NOT NULL,
            cf_token        TEXT NOT NULL,
            fullchain_key   TEXT,
            privkey_key     TEXT,
            metadata_key    TEXT,
            status          TEXT NOT NULL DEFAULT 'pending',
            issued_at       TEXT,
            expires_at      TEXT,
            created_at      TEXT NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS acme_accounts (
            domain          TEXT PRIMARY KEY,
            account_key_pem TEXT NOT NULL,
            account_url     TEXT,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        )
        """,
    ]
    for sql in statements:
        await _client().query(sql)


async def get_cert(domain: str) -> Optional[dict]:
    rows = await _client().query(
        "SELECT * FROM certificates WHERE domain = ?",
        [domain],
    )
    if not rows:
        return None
    cert = rows[0]
    cert["cf_token"] = decrypt_text(cert.get("cf_token")) or ""
    return cert


async def list_certs() -> list[dict]:
    return await _client().query(
        """
        SELECT domain, wildcard_domain, status, issued_at, expires_at, created_at
        FROM certificates
        ORDER BY created_at DESC
        """
    )


async def create_cert_record(domain: str, password_hash: str, cf_token: str) -> bool:
    try:
        await _client().query(
            """
            INSERT INTO certificates (
                domain, wildcard_domain, password_hash, cf_token, status, created_at
            ) VALUES (?, ?, ?, ?, 'pending', ?)
            """,
            [
                domain,
                f"*.{domain}",
                password_hash,
                encrypt_text(cf_token),
                datetime.now(timezone.utc).isoformat(),
            ],
        )
    except D1QueryError as exc:
        if "unique" in str(exc).lower() or "constraint" in str(exc).lower():
            return False
        raise

    return True


_CERT_COLUMNS = {
    "wildcard_domain",
    "password_hash",
    "cf_token",
    "fullchain_key",
    "privkey_key",
    "metadata_key",
    "status",
    "issued_at",
    "expires_at",
    "created_at",
}


async def update_cert(domain: str, **kwargs: Any) -> None:
    if not kwargs:
        return
    unknown = set(kwargs) - _CERT_COLUMNS
    if unknown:
        raise ValueError(f"Unsupported certificate columns: {', '.join(sorted(unknown))}")

    if "cf_token" in kwargs and kwargs["cf_token"] is not None:
        kwargs["cf_token"] = encrypt_text(str(kwargs["cf_token"]))

    sets: list[str] = []
    params: list[Any] = []
    for key, value in kwargs.items():
        if value is None:
            sets.append(f"{key} = NULL")
        else:
            sets.append(f"{key} = ?")
            params.append(value)
    set_clause = ", ".join(sets)
    params.append(domain)
    await _client().query(f"UPDATE certificates SET {set_clause} WHERE domain = ?", params)


async def delete_cert(domain: str) -> None:
    await _client().query("DELETE FROM certificates WHERE domain = ?", [domain])


async def get_cert_files(domain: str) -> Optional[dict]:
    rows = await _client().query(
        """
        SELECT fullchain_key, privkey_key
        FROM certificates
        WHERE domain = ? AND status = 'valid'
        """,
        [domain],
    )
    if not rows:
        return None

    row = rows[0]
    fullchain_key = row.get("fullchain_key")
    privkey_key = row.get("privkey_key")
    if not fullchain_key or not privkey_key:
        return None

    return await get_storage().get_certificate_files(fullchain_key, privkey_key)


async def get_acme_account(domain: str) -> Optional[dict]:
    rows = await _client().query(
        """
        SELECT domain, account_key_pem, account_url, created_at, updated_at
        FROM acme_accounts
        WHERE domain = ?
        """,
        [domain],
    )
    if not rows:
        return None
    account = rows[0]
    account["account_key_pem"] = decrypt_text(account.get("account_key_pem")) or ""
    return account


async def save_acme_account(
    domain: str,
    account_key_pem: bytes | str,
    account_url: str | None,
) -> None:
    pem = account_key_pem.decode("utf-8") if isinstance(account_key_pem, bytes) else account_key_pem
    now = datetime.now(timezone.utc).isoformat()
    await _client().query(
        """
        INSERT INTO acme_accounts (
            domain, account_key_pem, account_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(domain) DO UPDATE SET
            account_key_pem = excluded.account_key_pem,
            account_url = excluded.account_url,
            updated_at = excluded.updated_at
        """,
        [domain, encrypt_text(pem), account_url, now, now],
    )

def get_config(key: str, default: str = "") -> str:
    logger.debug("Ignoring database config lookup for %s; config.yaml is authoritative", key)
    return default


def set_config(key: str, value: str) -> None:
    logger.debug("Ignoring database config write for %s; config.yaml is authoritative", key)
