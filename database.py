"""SQLite 数据库模块 - 配置与证书存储"""

import sqlite3
import os
from datetime import datetime, timezone
from typing import Optional

DB_PATH = os.path.join("data", "autocert.db")


def _get_conn() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    """初始化数据库表"""
    conn = _get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS certificates (
            domain          TEXT PRIMARY KEY,
            wildcard_domain TEXT NOT NULL,
            fullchain_pem   TEXT,
            privkey_pem     TEXT,
            status          TEXT NOT NULL DEFAULT 'pending',
            issued_at       TEXT,
            expires_at      TEXT,
            created_at      TEXT NOT NULL
        );
    """)
    conn.commit()
    conn.close()


# ── 配置 ──

def get_config(key: str, default: str = "") -> str:
    conn = _get_conn()
    row = conn.execute("SELECT value FROM config WHERE key = ?", (key,)).fetchone()
    conn.close()
    return row["value"] if row else default


def set_config(key: str, value: str):
    conn = _get_conn()
    conn.execute(
        "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
        (key, value, value),
    )
    conn.commit()
    conn.close()


# ── 证书 ──

def get_cert(domain: str) -> Optional[dict]:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM certificates WHERE domain = ?", (domain,)).fetchone()
    conn.close()
    return dict(row) if row else None


def list_certs() -> list[dict]:
    conn = _get_conn()
    rows = conn.execute(
        "SELECT domain, wildcard_domain, status, issued_at, expires_at, created_at "
        "FROM certificates ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_cert_record(domain: str) -> bool:
    """创建待申请的证书记录，域名唯一"""
    conn = _get_conn()
    try:
        conn.execute(
            "INSERT INTO certificates (domain, wildcard_domain, status, created_at) VALUES (?, ?, 'pending', ?)",
            (domain, f"*.{domain}", datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False
    finally:
        conn.close()


def update_cert(domain: str, **kwargs):
    """更新证书记录字段"""
    if not kwargs:
        return
    sets = ", ".join(f"{k} = ?" for k in kwargs)
    vals = list(kwargs.values()) + [domain]
    conn = _get_conn()
    conn.execute(f"UPDATE certificates SET {sets} WHERE domain = ?", vals)
    conn.commit()
    conn.close()


def delete_cert(domain: str):
    conn = _get_conn()
    conn.execute("DELETE FROM certificates WHERE domain = ?", (domain,))
    conn.commit()
    conn.close()


def get_cert_files(domain: str) -> Optional[dict]:
    """获取证书的 PEM 文件内容"""
    conn = _get_conn()
    row = conn.execute(
        "SELECT fullchain_pem, privkey_pem FROM certificates WHERE domain = ? AND status = 'valid'",
        (domain,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


# 启动时初始化
init_db()
