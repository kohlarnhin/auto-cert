"""Application configuration loaded from config.yaml."""

import logging
from dataclasses import dataclass
from functools import lru_cache
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

import yaml


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class CloudflareSettings:
    account_id: str
    api_token: str
    d1_database_id: str
    r2_bucket: str
    r2_access_key_id: str
    r2_secret_access_key: str
    r2_endpoint_url: str
    r2_region: str
    r2_key_prefix: str
    r2_public_base_url: str


@dataclass(frozen=True)
class AppSettings:
    config_path: Path
    logs_dir: Path
    log_level: str
    cloudflare: CloudflareSettings
    encryption_key: str


def _candidate_paths() -> list[Path]:
    backend_dir = Path(__file__).resolve().parents[2]
    runtime_root = Path(__file__).resolve().parents[3]
    cwd = Path.cwd()
    paths = [
        cwd / "config.yaml",
        backend_dir / "config.yaml",
        runtime_root / "config.yaml",
    ]
    unique: list[Path] = []
    for path in paths:
        if path not in unique:
            unique.append(path)
    return unique


def _find_config_path() -> Path:
    for path in _candidate_paths():
        if path.exists():
            return path
    searched = ", ".join(str(p) for p in _candidate_paths())
    raise ConfigError(f"config.yaml not found. Searched: {searched}")


def _load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise ConfigError("config.yaml must contain a YAML mapping at the top level")
    return data


def _clean(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value).strip()


def _require(name: str, value: Any) -> str:
    cleaned = _clean(value)
    if not cleaned or cleaned.startswith("replace-me"):
        raise ConfigError(f"Missing required config value: {name}")
    return cleaned


def _resolve_path(base: Path, value: Any, default: str) -> Path:
    raw = _clean(value, default)
    path = Path(raw)
    if path.is_absolute():
        return path
    return (base / path).resolve()


@lru_cache(maxsize=1)
def get_settings() -> AppSettings:
    config_path = _find_config_path()
    data = _load_yaml(config_path)

    cloudflare = data.get("cloudflare") or {}
    d1 = cloudflare.get("d1") or {}
    r2 = cloudflare.get("r2") or {}
    logging_cfg = data.get("logging") or {}
    security = data.get("security") or {}

    account_id = _require("cloudflare.account_id", cloudflare.get("account_id"))
    d1_token = _require(
        "cloudflare.api_token or cloudflare.d1.api_token",
        d1.get("api_token") or cloudflare.get("api_token"),
    )
    r2_account_id = _clean(r2.get("account_id"), account_id)
    endpoint_url = _clean(
        r2.get("endpoint_url"),
        f"https://{r2_account_id}.r2.cloudflarestorage.com",
    )

    settings = AppSettings(
        config_path=config_path,
        logs_dir=_resolve_path(config_path.parent, logging_cfg.get("dir"), "./logs"),
        log_level=_clean(logging_cfg.get("level"), "INFO").upper(),
        cloudflare=CloudflareSettings(
            account_id=account_id,
            api_token=d1_token,
            d1_database_id=_require("cloudflare.d1.database_id", d1.get("database_id")),
            r2_bucket=_require("cloudflare.r2.bucket", r2.get("bucket")),
            r2_access_key_id=_require("cloudflare.r2.access_key_id", r2.get("access_key_id")),
            r2_secret_access_key=_require(
                "cloudflare.r2.secret_access_key",
                r2.get("secret_access_key"),
            ),
            r2_endpoint_url=endpoint_url,
            r2_region=_clean(r2.get("region"), "auto"),
            r2_key_prefix=_clean(r2.get("key_prefix")),
            r2_public_base_url=_clean(r2.get("public_base_url")),
        ),
        encryption_key=_require("security.encryption_key", security.get("encryption_key")),
    )
    return settings


def setup_logging() -> None:
    settings = get_settings()
    settings.logs_dir.mkdir(parents=True, exist_ok=True)

    level = getattr(logging, settings.log_level, logging.INFO)
    root = logging.getLogger()
    root.setLevel(level)

    if not any(getattr(handler, "name", "") == "autocert_file" for handler in root.handlers):
        handler = RotatingFileHandler(
            settings.logs_dir / "app.log",
            maxBytes=10 * 1024 * 1024,
            backupCount=5,
            encoding="utf-8",
        )
        handler.name = "autocert_file"
        handler.setLevel(level)
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")
        )
        root.addHandler(handler)

    logging.getLogger("botocore").setLevel(logging.WARNING)
    logging.getLogger("boto3").setLevel(logging.WARNING)
