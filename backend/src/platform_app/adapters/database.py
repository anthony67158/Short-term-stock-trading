"""Transaction owner is the application use case, never the HTTP transport.

https://docs.sqlalchemy.org/en/20/orm/session_basics.html#using-a-sessionmaker
"""
from functools import lru_cache

from sqlalchemy import MetaData, create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from platform_app.config import settings


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention={
        "ix": "ix_%(table_name)s_%(column_0_name)s",
        "uq": "uq_%(table_name)s_%(column_0_name)s",
        "ck": "ck_%(table_name)s_%(constraint_name)s",
        "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
        "pk": "pk_%(table_name)s",
    })


@lru_cache
def engine():
    return create_engine(
        settings().database_url.get_secret_value(),
        pool_pre_ping=True, pool_size=5, max_overflow=5,
        connect_args={"connect_timeout": 5, "options": "-c statement_timeout=10000"},
    )


@lru_cache
def sessions():
    return sessionmaker(engine(), expire_on_commit=False)
