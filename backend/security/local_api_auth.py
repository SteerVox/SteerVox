from __future__ import annotations

import hmac
import os
import secrets

from fastapi import Header, HTTPException, Request, status

from utils.branding import LOCAL_BACKEND_AUTH_HEADER, LOCAL_BACKEND_TOKEN_ENV_VAR


LOCAL_API_TOKEN_ENV_VAR = LOCAL_BACKEND_TOKEN_ENV_VAR
LOCAL_API_TOKEN_HEADER = LOCAL_BACKEND_AUTH_HEADER


def resolve_local_api_token() -> str:
    token = os.environ.get(LOCAL_API_TOKEN_ENV_VAR)
    if token:
        return token

    token = secrets.token_urlsafe(32)
    os.environ[LOCAL_API_TOKEN_ENV_VAR] = token
    return token


def build_local_api_auth_headers(token: str) -> dict[str, str]:
    return {LOCAL_API_TOKEN_HEADER: token}


async def require_local_api_token(
    request: Request,
    local_api_token: str | None = Header(default=None, alias=LOCAL_API_TOKEN_HEADER),
) -> None:
    expected_token = getattr(request.app.state, "local_api_token", None) or resolve_local_api_token()
    if local_api_token and hmac.compare_digest(local_api_token, expected_token):
        return

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Missing or invalid local API token.",
    )
