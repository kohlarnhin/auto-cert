"""Cloudflare DNS API 服务 - 管理 DNS TXT 记录用于 ACME 验证"""

import httpx

CF_API_BASE = "https://api.cloudflare.com/client/v4"


class CloudflareService:
    def __init__(self, api_token: str):
        self.api_token = api_token
        self.client = httpx.AsyncClient(timeout=30.0)

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_token}",
            "Content-Type": "application/json",
        }

    async def verify_token(self) -> bool:
        """验证 API Token 是否有效"""
        resp = await self.client.get(
            f"{CF_API_BASE}/user/tokens/verify",
            headers=self._headers(),
        )
        data = resp.json()
        return data.get("success", False)

    async def get_zone_id(self, domain: str) -> str:
        """根据域名获取 Zone ID"""
        resp = await self.client.get(
            f"{CF_API_BASE}/zones",
            params={"name": domain},
            headers=self._headers(),
        )
        data = resp.json()
        if not data.get("success") or not data.get("result"):
            raise Exception(f"未找到域名 {domain} 的 Zone，请确认域名已添加到 Cloudflare")
        return data["result"][0]["id"]

    async def create_txt_record(self, zone_id: str, name: str, value: str) -> str:
        """创建 DNS TXT 记录，返回记录 ID"""
        resp = await self.client.post(
            f"{CF_API_BASE}/zones/{zone_id}/dns_records",
            json={"type": "TXT", "name": name, "content": value, "ttl": 120},
            headers=self._headers(),
        )
        data = resp.json()
        if not data.get("success"):
            raise Exception(f"创建 DNS 记录失败: {data.get('errors')}")
        return data["result"]["id"]

    async def delete_txt_record(self, zone_id: str, record_id: str):
        """删除 DNS TXT 记录"""
        await self.client.delete(
            f"{CF_API_BASE}/zones/{zone_id}/dns_records/{record_id}",
            headers=self._headers(),
        )

    async def close(self):
        await self.client.aclose()
