"""
Authentication and RBAC helpers for GreenOps.

Provides:
  - password hashing / verification via passlib+bcrypt
  - JWT creation and decoding via python-jose
  - FastAPI dependency get_current_user()
  - FastAPI dependency factory require_role(*roles) for endpoint-level RBAC

Environment variables (loaded by main.py via python-dotenv):
  JWT_SECRET_KEY      – required, no default
  JWT_ALGORITHM       – default HS256
  JWT_EXPIRE_MINUTES  – default 480 (8 hours)
"""

import os
from datetime import datetime, timedelta
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from .database import get_db
from . import models

# ---------------------------------------------------------------------------
# Configuration (read from environment — never hardcoded)
# ---------------------------------------------------------------------------

_SECRET_KEY: Optional[str] = None


def _get_secret() -> str:
    """Return JWT secret, raising clearly if missing."""
    global _SECRET_KEY
    if _SECRET_KEY is None:
        _SECRET_KEY = os.getenv("JWT_SECRET_KEY")
    if not _SECRET_KEY:
        raise RuntimeError(
            "JWT_SECRET_KEY environment variable is not set. "
            "Add it to backend/.env and restart with --env-file .env"
        )
    return _SECRET_KEY


ALGORITHM: str = os.getenv("JWT_ALGORITHM", "HS256")
EXPIRE_MINUTES: int = int(os.getenv("JWT_EXPIRE_MINUTES", "480"))

# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain: str) -> str:
    """Return bcrypt hash of *plain*. Never store the plain text."""
    return _pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    """Return True if *plain* matches the stored *hashed* password."""
    return _pwd_context.verify(plain, hashed)


# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------

def create_access_token(user_id: int, role: str, name: str) -> str:
    """Create a signed JWT containing user_id, role, and name."""
    expire = datetime.utcnow() + timedelta(minutes=EXPIRE_MINUTES)
    payload = {
        "sub": str(user_id),
        "role": role,
        "name": name,
        "exp": expire,
    }
    return jwt.encode(payload, _get_secret(), algorithm=ALGORITHM)


def _decode_token(token: str) -> dict:
    """Decode and validate a JWT. Raises HTTPException on any failure."""
    try:
        payload = jwt.decode(token, _get_secret(), algorithms=[ALGORITHM])
        return payload
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token is invalid or has expired.",
            headers={"WWW-Authenticate": "Bearer"},
        )


# ---------------------------------------------------------------------------
# FastAPI OAuth2 scheme
# ---------------------------------------------------------------------------

# tokenUrl matches the login endpoint defined in main.py
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> models.User:
    """
    FastAPI dependency. Validates the Bearer JWT and returns the User row.
    Raises HTTP 401 if the token is missing, invalid, or expired.
    Raises HTTP 401 if the user account is inactive or deleted.
    """
    payload = _decode_token(token)
    user_id_str: Optional[str] = payload.get("sub")
    if not user_id_str:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token payload is malformed.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = db.query(models.User).filter(
        models.User.id == int(user_id_str)
    ).first()

    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account not found or is inactive.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def require_role(*allowed_roles: str):
    """
    Dependency factory for endpoint-level RBAC.

    Usage:
        @app.post("/some/endpoint")
        def my_endpoint(
            current_user = Depends(require_role("infrastructure_manager")),
        ):
            ...

    Returns the authenticated User if their role is in *allowed_roles*.
    Raises HTTP 403 otherwise.
    """
    def _checker(current_user: models.User = Depends(get_current_user)) -> models.User:
        if current_user.role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"Your role '{current_user.role}' is not authorised to perform this action. "
                    f"Required: {', '.join(allowed_roles)}."
                ),
            )
        return current_user
    return _checker


# ---------------------------------------------------------------------------
# Valid roles constant (single source of truth)
# ---------------------------------------------------------------------------

ROLES = {
    "infrastructure_manager",
    "sustainability_manager",
    "operations_engineer",
}
