"""ACME v2 协议服务 - 纯 Python 实现 Let's Encrypt 证书申请"""

import asyncio
import base64
import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Callable, List, Optional, Tuple

import httpx
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.padding import PKCS1v15
from cryptography.x509.oid import NameOID

from app.db import database as db
from app.services.cloudflare import CloudflareService

LETS_ENCRYPT_DIR = "https://acme-v02.api.letsencrypt.org/directory"
LETS_ENCRYPT_STAGING_DIR = "https://acme-staging-v02.api.letsencrypt.org/directory"


def _b64url(data) -> str:
    """Base64url 编码（无 padding）"""
    if isinstance(data, str):
        data = data.encode()
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _int_to_b64url(n: int) -> str:
    """将大整数转为 base64url 编码"""
    byte_len = (n.bit_length() + 7) // 8
    return _b64url(n.to_bytes(byte_len, byteorder="big"))


class AcmeService:
    """ACME v2 客户端，支持 DNS-01 验证申请通配符证书"""

    def __init__(self, staging: bool = False):
        self.directory_url = LETS_ENCRYPT_STAGING_DIR if staging else LETS_ENCRYPT_DIR
        self.directory: Optional[dict] = None
        self.account_key = None
        self.account_key_pem: bytes | None = None
        self.account_url: Optional[str] = None
        self.nonce: Optional[str] = None
        self.client = httpx.AsyncClient(timeout=60.0)
        self._log_cb: Optional[Callable] = None

    def set_log_callback(self, cb: Callable):
        self._log_cb = cb

    async def _log(self, msg: str, level: str = "info", step: str = ""):
        if self._log_cb:
            await self._log_cb(msg, level, step)

    # ── JWK / JWS ─────────────────────────────────────────────

    def _get_jwk(self) -> dict:
        pub = self.account_key.public_key().public_numbers()
        return {"e": _int_to_b64url(pub.e), "kty": "RSA", "n": _int_to_b64url(pub.n)}

    def _thumbprint(self) -> str:
        jwk = self._get_jwk()
        ordered = json.dumps(jwk, sort_keys=True, separators=(",", ":"))
        return _b64url(hashlib.sha256(ordered.encode()).digest())

    def _sign_jws(self, url: str, payload) -> dict:
        header = {"alg": "RS256", "nonce": self.nonce, "url": url}
        if self.account_url:
            header["kid"] = self.account_url
        else:
            header["jwk"] = self._get_jwk()

        protected_b64 = _b64url(json.dumps(header))
        payload_b64 = "" if payload is None else _b64url(json.dumps(payload))

        sig = self.account_key.sign(
            f"{protected_b64}.{payload_b64}".encode(), PKCS1v15(), hashes.SHA256()
        )
        return {"protected": protected_b64, "payload": payload_b64, "signature": _b64url(sig)}

    async def _post(self, url: str, payload=None) -> httpx.Response:
        body = self._sign_jws(url, payload)
        resp = await self.client.post(
            url, json=body, headers={"Content-Type": "application/jose+json"}
        )
        if "Replay-Nonce" in resp.headers:
            self.nonce = resp.headers["Replay-Nonce"]
        return resp

    # ── ACME 流程 ──────────────────────────────────────────────

    async def init(self, domain: str):
        """初始化：获取目录、Nonce、加载/生成账户密钥"""
        resp = await self.client.get(self.directory_url)
        self.directory = resp.json()

        resp = await self.client.head(self.directory["newNonce"])
        self.nonce = resp.headers["Replay-Nonce"]

        account = await db.get_acme_account(domain)
        if account and account.get("account_key_pem"):
            self.account_key_pem = account["account_key_pem"].encode("utf-8")
            self.account_key = serialization.load_pem_private_key(self.account_key_pem, password=None)
            self.account_url = account.get("account_url")
        else:
            self.account_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            self.account_key_pem = self.account_key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )

    async def ensure_account(self, domain: str):
        if self.account_url:
            return
        if not self.account_key_pem:
            raise RuntimeError("ACME account key was not initialized")
        resp = await self._post(
            self.directory["newAccount"], {"termsOfServiceAgreed": True}
        )
        self.account_url = resp.headers.get("Location")
        await db.save_acme_account(domain, self.account_key_pem, self.account_url)

    async def create_order(self, domains: List[str]) -> dict:
        ids = [{"type": "dns", "value": d} for d in domains]
        resp = await self._post(self.directory["newOrder"], {"identifiers": ids})
        order = resp.json()
        order["_url"] = resp.headers.get("Location")
        return order

    async def get_authorization(self, url: str) -> dict:
        resp = await self._post(url, None)
        return resp.json()

    async def respond_challenge(self, url: str):
        await self._post(url, {})

    async def poll_status(self, url: str, target: str, max_tries: int = 30) -> dict:
        for _ in range(max_tries):
            resp = await self._post(url, None)
            obj = resp.json()
            status = obj.get("status")
            if status == target:
                return obj
            if status in ("invalid", "expired", "revoked"):
                raise Exception(f"状态异常: {status} - {json.dumps(obj, ensure_ascii=False)}")
            await asyncio.sleep(3)
        raise Exception("轮询超时")

    async def finalize(self, url: str, csr_der: bytes) -> dict:
        resp = await self._post(url, {"csr": _b64url(csr_der)})
        return resp.json()

    async def download_cert(self, url: str) -> str:
        resp = await self._post(url, None)
        return resp.text

    # ── 辅助方法 ───────────────────────────────────────────────

    def dns_txt_value(self, token: str) -> str:
        """计算 DNS-01 验证所需的 TXT 记录值"""
        ka = f"{token}.{self._thumbprint()}"
        return _b64url(hashlib.sha256(ka.encode()).digest())

    @staticmethod
    def generate_csr(domains: List[str]) -> Tuple[bytes, bytes]:
        """生成 CSR 和私钥，返回 (csr_der, key_pem)"""
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, domains[0])])
        san = x509.SubjectAlternativeName([x509.DNSName(d) for d in domains])
        csr = (
            x509.CertificateSigningRequestBuilder()
            .subject_name(name)
            .add_extension(san, critical=False)
            .sign(key, hashes.SHA256())
        )
        csr_der = csr.public_bytes(serialization.Encoding.DER)
        key_pem = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        return csr_der, key_pem

    # ── 完整申请流程 ───────────────────────────────────────────

    async def apply_certificate(
        self,
        domain: str,
        cf: CloudflareService,
        staging: bool = False,
    ) -> dict[str, Any]:
        """完整的通配符证书申请流程"""
        domains = [domain, f"*.{domain}"]
        dns_records: list[tuple[str, str]] = []

        try:
            await self._log(f"开始申请证书: {', '.join(domains)}", step="init")

            # 1. 初始化
            await self._log("连接 Let's Encrypt...", step="init")
            await self.init(domain)
            await self._log("连接成功", "success", step="init")

            # 2. 注册账户
            await self._log("准备 ACME 账户...", step="account")
            await self.ensure_account(domain)
            await self._log("账户就绪", "success", step="account")

            # 3. 创建订单
            await self._log("创建证书订单...", step="order")
            order = await self.create_order(domains)
            await self._log(f"订单已创建，需验证 {len(order['authorizations'])} 个授权", "success", step="order")

            # 4. 获取 Zone ID
            await self._log(f"查询 Cloudflare Zone: {domain}", step="dns")
            zone_id = await cf.get_zone_id(domain)
            await self._log("Zone 已找到", "success", step="dns")

            # 5. 处理每个授权的 DNS-01 Challenge
            challenges_to_respond = []
            for auth_url in order["authorizations"]:
                auth = await self.get_authorization(auth_url)
                auth_domain = auth["identifier"]["value"]

                dns_ch = next((c for c in auth["challenges"] if c["type"] == "dns-01"), None)
                if not dns_ch:
                    raise Exception(f"未找到 {auth_domain} 的 dns-01 验证")

                txt_val = self.dns_txt_value(dns_ch["token"])
                record_name = f"_acme-challenge.{auth_domain}"

                await self._log(f"添加 DNS 记录: {record_name}", step="dns")
                rid = await cf.create_txt_record(zone_id, record_name, txt_val)
                dns_records.append((zone_id, rid))
                await self._log("DNS 记录已添加", "success", step="dns")

                challenges_to_respond.append((auth_url, dns_ch["url"], auth_domain))

            # 6. 等待 DNS 传播
            await self._log("等待 DNS 传播...", step="propagation")
            for i in range(30, 0, -1):
                await self._log(f"倒计时 {i}s...", "debug", step="propagation")
                await asyncio.sleep(1)
            await self._log("DNS 传播完成", "success", step="propagation")

            # 7. 响应 Challenge
            for auth_url, ch_url, auth_domain in challenges_to_respond:
                await self._log(f"提交验证: {auth_domain}", step="verify")
                await self.respond_challenge(ch_url)

            # 8. 等待验证通过
            for auth_url, _, auth_domain in challenges_to_respond:
                await self._log(f"等待验证: {auth_domain}...", step="verify")
                await self.poll_status(auth_url, "valid")
                await self._log(f"{auth_domain} 验证通过", "success", step="verify")

            # 9. 生成 CSR & 完成订单
            await self._log("生成证书密钥和 CSR...", step="generate")
            csr_der, key_pem = self.generate_csr(domains)
            await self._log("CSR 已生成", "success", step="generate")

            await self._log("提交订单完成请求...", step="finalize")
            result = await self.finalize(order["finalize"], csr_der)

            if result.get("status") != "valid":
                result = await self.poll_status(order["_url"], "valid")

            # 10. 下载证书
            await self._log("下载证书...", step="finalize")
            cert_pem = await self.download_cert(result["certificate"])
            await self._log("证书已下载", "success", step="finalize")

            # 11. 解析证书元数据，调用方负责持久化到 R2/D1
            cert_obj = x509.load_pem_x509_certificate(cert_pem.encode())
            expires = cert_obj.not_valid_after_utc
            issued_at = datetime.now(timezone.utc).isoformat()
            meta = {
                "domain": domain,
                "domains": domains,
                "issued_at": issued_at,
                "expires_at": expires.isoformat(),
            }

            await self._log(f"证书申请成功！有效期至 {expires.strftime('%Y-%m-%d')}", "success", step="complete")
            return {
                "fullchain_pem": cert_pem,
                "privkey_pem": key_pem.decode("utf-8"),
                "metadata": meta,
                "issued_at": issued_at,
                "expires_at": expires.isoformat(),
            }

        except Exception as e:
            await self._log(f"申请失败: {e}", "error", step="error")
            raise
        finally:
            # 清理 DNS 记录
            if dns_records:
                await self._log("清理 DNS 记录...", step="cleanup")
                for zid, rid in dns_records:
                    try:
                        await cf.delete_txt_record(zid, rid)
                    except Exception as e:
                        await self._log(f"清理失败: {e}", "warn", step="cleanup")
                await self._log("DNS 记录已清理", "success", step="cleanup")
            await self.client.aclose()
