"""Certificate object storage backed by Cloudflare R2."""

import asyncio
import json
from functools import lru_cache
from typing import Any
from urllib.parse import quote

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

from app.core.config import get_settings


class StorageError(RuntimeError):
    pass


class R2Storage:
    def __init__(self):
        settings = get_settings()
        cf = settings.cloudflare
        self.bucket = cf.r2_bucket
        self.prefix = cf.r2_key_prefix.strip("/")
        self.endpoint_url = cf.r2_endpoint_url.rstrip("/")
        self.public_base_url = cf.r2_public_base_url.rstrip("/")
        self.client = boto3.client(
            "s3",
            endpoint_url=cf.r2_endpoint_url,
            aws_access_key_id=cf.r2_access_key_id,
            aws_secret_access_key=cf.r2_secret_access_key,
            region_name=cf.r2_region,
            config=BotoConfig(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
            ),
        )

    def _key(self, key: str) -> str:
        key = key.strip("/")
        if self.prefix:
            return f"{self.prefix}/{key}"
        return key

    def public_url(self, key: str) -> str:
        object_key = quote(self._key(key), safe="/")
        if self.public_base_url:
            return f"{self.public_base_url}/{object_key}"
        return f"{self.endpoint_url}/{quote(self.bucket, safe='')}/{object_key}"

    def _get_bytes_sync(self, key: str) -> bytes | None:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=self._key(key))
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code")
            if code in {"NoSuchKey", "404", "NotFound"}:
                return None
            raise StorageError(f"R2 get_object failed for {key}: {exc}") from exc

        body = response["Body"]
        try:
            return body.read()
        finally:
            body.close()

    def _put_bytes_sync(self, key: str, data: bytes, content_type: str) -> None:
        try:
            self.client.put_object(
                Bucket=self.bucket,
                Key=self._key(key),
                Body=data,
                ContentType=content_type,
            )
        except ClientError as exc:
            raise StorageError(f"R2 put_object failed for {key}: {exc}") from exc

    def _delete_many_sync(self, keys: list[str]) -> None:
        object_keys = [{"Key": self._key(key)} for key in keys if key]
        if not object_keys:
            return
        try:
            self.client.delete_objects(
                Bucket=self.bucket,
                Delete={"Objects": object_keys, "Quiet": True},
            )
        except ClientError as exc:
            raise StorageError(f"R2 delete_objects failed: {exc}") from exc

    async def get_bytes(self, key: str) -> bytes | None:
        return await asyncio.to_thread(self._get_bytes_sync, key)

    async def get_text(self, key: str) -> str | None:
        data = await self.get_bytes(key)
        if data is None:
            return None
        return data.decode("utf-8")

    async def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        await asyncio.to_thread(self._put_bytes_sync, key, data, content_type)

    async def put_text(self, key: str, text: str, content_type: str) -> None:
        await self.put_bytes(key, text.encode("utf-8"), content_type)

    @staticmethod
    def certificate_keys(domain: str) -> dict[str, str]:
        normalized = domain.strip().lower().lstrip("*.").strip("/")
        base = f"certificates/{normalized}"
        return {
            "fullchain_key": f"{base}/fullchain.cer",
            "privkey_key": f"{base}/{normalized}.key",
            "metadata_key": f"{base}/metadata.json",
        }

    async def save_certificate(
        self,
        domain: str,
        fullchain_pem: str,
        privkey_pem: str,
        metadata: dict[str, Any],
    ) -> dict[str, str]:
        keys = self.certificate_keys(domain)
        await asyncio.gather(
            self.put_text(keys["fullchain_key"], fullchain_pem, "application/x-pem-file"),
            self.put_text(keys["privkey_key"], privkey_pem, "application/x-pem-file"),
            self.put_text(
                keys["metadata_key"],
                json.dumps(metadata, ensure_ascii=False, indent=2),
                "application/json",
            ),
        )
        return keys

    async def get_certificate_files(
        self,
        fullchain_key: str,
        privkey_key: str,
    ) -> dict[str, str] | None:
        fullchain, privkey = await asyncio.gather(
            self.get_text(fullchain_key),
            self.get_text(privkey_key),
        )
        if not fullchain or not privkey:
            return None
        return {"fullchain_pem": fullchain, "privkey_pem": privkey}

    def get_certificate_urls(self, domain: str, fullchain_key: str, privkey_key: str) -> dict[str, str]:
        normalized = domain.strip().lower().lstrip("*.").strip("/")
        privkey_name = f"{normalized}.key"
        return {
            "fullchain_name": "fullchain.cer",
            "privkey_name": privkey_name,
            "fullchain_url": self.public_url(fullchain_key),
            "privkey_url": self.public_url(privkey_key),
        }

    async def delete_certificate_files(self, *keys: str | None) -> None:
        await asyncio.to_thread(self._delete_many_sync, [key for key in keys if key])


@lru_cache(maxsize=1)
def get_storage() -> R2Storage:
    return R2Storage()
