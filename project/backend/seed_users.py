#!/usr/bin/env python3
"""
GreenOps demo user seed script.

Creates exactly three demo users (one per role) if they don't already exist.
Safe to run multiple times — will not overwrite or duplicate existing users.

Usage:
    cd backend
    DATABASE_URL=postgresql://Kaviya@localhost:5432/greenops \\
    JWT_SECRET_KEY=... \\
        python seed_users.py

Or with uvicorn-style env file loading:
    cd backend
    python seed_users.py          # reads .env automatically

Passwords are set via environment variables so plaintext never appears in
source code. If a variable is not set, a clear error message is shown.

  INFRA_PASSWORD          – password for infra@greenops.local
  SUSTAINABILITY_PASSWORD – password for sustainability@greenops.local
  OPERATIONS_PASSWORD     – password for operations@greenops.local
"""

import os
import sys

# Load .env from the same directory as this script
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

# Now DATABASE_URL is available — import SQLAlchemy setup
from app.database import engine, Base, SessionLocal
from app import models
from app.auth import hash_password


def _require_env(name: str) -> str:
    val = os.getenv(name)
    if not val:
        print(f"ERROR: Environment variable '{name}' is not set.")
        print(f"       Set it before running this script, e.g.:")
        print(f"       {name}=your-password python seed_users.py")
        sys.exit(1)
    return val


DEMO_USERS = [
    {
        "name": "Infrastructure Manager",
        "email": "infra@greenops.local",
        "role": "infrastructure_manager",
        "password_env": "INFRA_PASSWORD",
    },
    {
        "name": "Sustainability Manager",
        "email": "sustainability@greenops.local",
        "role": "sustainability_manager",
        "password_env": "SUSTAINABILITY_PASSWORD",
    },
    {
        "name": "Operations Engineer",
        "email": "operations@greenops.local",
        "role": "operations_engineer",
        "password_env": "OPERATIONS_PASSWORD",
    },
]


def seed():
    # Collect passwords first so we fail fast if any are missing
    passwords = {}
    for u in DEMO_USERS:
        passwords[u["email"]] = _require_env(u["password_env"])

    # Ensure tables exist (idempotent)
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        created = 0
        skipped = 0
        for u in DEMO_USERS:
            existing = db.query(models.User).filter(
                models.User.email == u["email"]
            ).first()

            if existing:
                print(f"  SKIP  {u['email']} (already exists, role={existing.role})")
                skipped += 1
                continue

            user = models.User(
                name=u["name"],
                email=u["email"],
                password_hash=hash_password(passwords[u["email"]]),
                role=u["role"],
                is_active=True,
            )
            db.add(user)
            print(f"  CREATE {u['email']} → role={u['role']}")
            created += 1

        db.commit()
        print(f"\nDone. {created} user(s) created, {skipped} already existed.")

    finally:
        db.close()


if __name__ == "__main__":
    print("GreenOps user seed\n")
    seed()
