"""Certificate API schemas."""

from pydantic import BaseModel


class CertApplyRequest(BaseModel):
    domain: str
    password: str
    cf_token: str | None = None
    staging: bool = False


class RegisterRequest(BaseModel):
    domain: str
    password: str
    cf_token: str
