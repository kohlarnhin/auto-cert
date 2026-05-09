"""Symmetric encryption helpers for sensitive D1 fields."""

from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import ConfigError, get_settings

ENCRYPTED_PREFIX = "enc:"


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    key = get_settings().encryption_key.encode("utf-8")
    try:
        return Fernet(key)
    except ValueError as exc:
        raise ConfigError(
            "security.encryption_key must be a Fernet key. Generate one with: "
            "python3 -c \"import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())\""
        ) from exc


def encrypt_text(value: str) -> str:
    if value.startswith(ENCRYPTED_PREFIX):
        return value
    token = _fernet().encrypt(value.encode("utf-8")).decode("utf-8")
    return f"{ENCRYPTED_PREFIX}{token}"


def decrypt_text(value: str | None) -> str | None:
    if value is None:
        return None
    if not value.startswith(ENCRYPTED_PREFIX):
        return value
    token = value[len(ENCRYPTED_PREFIX):].encode("utf-8")
    try:
        return _fernet().decrypt(token).decode("utf-8")
    except InvalidToken as exc:
        raise ConfigError("Unable to decrypt a D1 secret with security.encryption_key") from exc
