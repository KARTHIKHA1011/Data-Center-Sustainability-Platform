# """
# Database configuration.

# Uses SQLite by default so the project runs out-of-the-box with zero setup.
# To switch to PostgreSQL for a more production-like deployment, just change
# DATABASE_URL below to something like:

#     postgresql://user:password@localhost:5432/greenops

# The rest of the application (SQLAlchemy models, queries) does not change.
# """
# import os
# from sqlalchemy import create_engine
# from sqlalchemy.ext.declarative import declarative_base
# from sqlalchemy.orm import sessionmaker

# DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./greenops.db")


# connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
# engine = create_engine(DATABASE_URL, connect_args=connect_args)

# SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base = declarative_base()


# def get_db():
#     db = SessionLocal()
#     try:
#         yield db
#     finally:
#         db.close()




# import os
# from sqlalchemy import create_engine
# from sqlalchemy.ext.declarative import declarative_base
# from sqlalchemy.orm import sessionmaker

# DATABASE_URL = "postgresql://postgres:aish@localhost:5432/greenops_db1"

# connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

# engine = create_engine(DATABASE_URL, connect_args=connect_args)

# SessionLocal = sessionmaker(
#     autocommit=False,
#     autoflush=False,
#     bind=engine
# )

# Base = declarative_base()


# def get_db():
#     db = SessionLocal()
#     try:
#         yield db
#     finally:
#         db.close()




import os
from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "sqlite:///./greenops.db"
)

connect_args = {
    "check_same_thread": False
} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()