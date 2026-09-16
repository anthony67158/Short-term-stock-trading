"""Deployment preflight and PostgreSQL backup/restore verification."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from sqlalchemy import create_engine, text
from sqlalchemy.engine import URL, make_url

from platform_app.adapters.database import engine
from platform_app.config import settings
from platform_app.modules.experiments.joint_bundle import JointBundle
from platform_app.modules.portfolio.migration_import import (
    migrate_snapshot,
)

EXPECTED_ALEMBIC_REVISION = "0020_prospective_immutability"


class OperationsError(ValueError):
    pass


def _external_path(value: Path) -> Path:
    path = value.expanduser().resolve()
    repository = Path(__file__).resolve().parents[4]
    if path == repository or repository in path.parents:
        raise OperationsError("OPERATIONS_PATH_MUST_BE_OUTSIDE_REPOSITORY")
    return path


def _database_url(database: str | None = None) -> URL:
    url = make_url(settings().database_url.get_secret_value())
    return url.set(drivername="postgresql+psycopg", database=database or url.database)


def _postgres_command(name: str, database: str | None = None) -> tuple[list[str], dict]:
    executable = shutil.which(name)
    if executable is None:
        raise OperationsError(f"{name.upper()}_NOT_AVAILABLE")
    url = _database_url(database)
    command = [
        executable,
        "--host",
        url.host or "127.0.0.1",
        "--port",
        str(url.port or 5432),
        "--username",
        url.username or "",
    ]
    environment = os.environ.copy()
    if url.password:
        environment["PGPASSWORD"] = url.password
    return command, environment


def _run(command: list[str], environment: dict) -> None:
    try:
        subprocess.run(
            command,
            env=environment,
            check=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=300,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise OperationsError("POSTGRES_OPERATION_FAILED") from exc


def _sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def preflight() -> dict:
    config = settings()
    with engine().connect() as connection:
        revision = connection.scalar(
            text("SELECT version_num FROM alembic_version")
        )
        connection.scalar(text("SELECT 1"))
    blockers = []
    if revision != EXPECTED_ALEMBIC_REVISION:
        blockers.append("DATABASE_MIGRATION_NOT_CURRENT")
    release = None
    if config.joint_bundle_root is None:
        blockers.append("JOINT_RELEASE_NOT_CONFIGURED")
    else:
        try:
            release = JointBundle(
                config.joint_bundle_root,
                require_ready=False,
            ).manifest
        except (OSError, TypeError, ValueError):
            blockers.append("JOINT_RELEASE_INVALID")
    if config.web_dist_root is not None:
        root = config.web_dist_root.expanduser().resolve()
        if not (root / "index.html").is_file() or not (
            root / "assets"
        ).is_dir():
            blockers.append("WEB_DISTRIBUTION_INCOMPLETE")
    if config.environment == "production" and (
        not config.cookie_secure
        or not config.origin.startswith("https://")
    ):
        blockers.append("PRODUCTION_HTTPS_REQUIRED")
    return {
        "schemaVersion": "deployment-preflight.v1",
        "checkedAt": datetime.now(UTC).isoformat(),
        "revision": config.deployment_revision,
        "databaseRevision": revision,
        "writeEnabled": config.write_enabled,
        "activeRelease": (
            {
                "releaseId": release["bundleId"],
                "status": release["releaseStatus"],
                "allowsNewRisk": release.get("allowsNewRisk", False),
            }
            if release
            else None
        ),
        "blockers": blockers,
        "ready": not blockers,
    }


def backup(output: Path) -> dict:
    target = _external_path(output)
    if target.exists():
        raise OperationsError("BACKUP_TARGET_ALREADY_EXISTS")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    command, environment = _postgres_command("pg_dump")
    url = _database_url()
    command.extend(
        [
            "--format=custom",
            "--no-owner",
            "--no-privileges",
            "--file",
            str(target),
            url.database or "",
        ]
    )
    _run(command, environment)
    target.chmod(0o600)
    report = {
        "schemaVersion": "postgres-backup.v1",
        "createdAt": datetime.now(UTC).isoformat(),
        "database": url.database,
        "backup": str(target),
        "sha256": _sha256(target),
        "bytes": target.stat().st_size,
        "deploymentRevision": settings().deployment_revision,
    }
    report_path = target.with_suffix(target.suffix + ".json")
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2)
        + "\n"
    )
    report_path.chmod(0o600)
    return report


def verify_restore(backup_path: Path) -> dict:
    source = _external_path(backup_path)
    if not source.is_file():
        raise OperationsError("BACKUP_NOT_FOUND")
    temporary_database = "platform_restore_" + uuid4().hex[:12]
    create, environment = _postgres_command(
        "createdb",
        temporary_database,
    )
    source_url = _database_url()
    create.extend(
        [
            "--maintenance-db",
            source_url.database or "postgres",
            temporary_database,
        ]
    )
    _run(create, environment)
    try:
        restore, environment = _postgres_command(
            "pg_restore",
            temporary_database,
        )
        restore.extend(
            [
                "--exit-on-error",
                "--no-owner",
                "--no-privileges",
                "--dbname",
                temporary_database,
                str(source),
            ]
        )
        _run(restore, environment)
        restored_engine = create_engine(
            _database_url(temporary_database),
            pool_pre_ping=True,
        )
        try:
            with restored_engine.connect() as connection:
                revision = connection.scalar(
                    text("SELECT version_num FROM alembic_version")
                )
                counts = {
                    table: int(
                        connection.scalar(
                            text(f"SELECT COUNT(*) FROM {table}")
                        )
                    )
                    for table in (
                        "users",
                        "investment_accounts",
                        "executions",
                        "cash_entries",
                        "position_lots",
                        "prospective_samples",
                        "release_records",
                    )
                }
        finally:
            restored_engine.dispose()
    finally:
        drop, environment = _postgres_command(
            "dropdb",
            temporary_database,
        )
        drop.extend(
            [
                "--if-exists",
                "--force",
                "--maintenance-db",
                source_url.database or "postgres",
                temporary_database,
            ]
        )
        _run(drop, environment)
    return {
        "schemaVersion": "postgres-restore-verification.v1",
        "verifiedAt": datetime.now(UTC).isoformat(),
        "backupSha256": _sha256(source),
        "databaseRevision": revision,
        "expectedRevision": EXPECTED_ALEMBIC_REVISION,
        "counts": counts,
        "passed": revision == EXPECTED_ALEMBIC_REVISION,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="A股投资平台部署运维工具"
    )
    parser.add_argument(
        "command",
        choices=[
            "preflight",
            "backup",
            "verify-restore",
            "migrate-snapshot",
        ],
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--backup", type=Path)
    parser.add_argument("--snapshot", type=Path)
    arguments = parser.parse_args()
    if arguments.command == "preflight":
        result = preflight()
    elif arguments.command == "backup":
        if arguments.output is None:
            parser.error("backup requires --output")
        result = backup(arguments.output)
    elif arguments.command == "verify-restore":
        if arguments.backup is None:
            parser.error("verify-restore requires --backup")
        result = verify_restore(arguments.backup)
    else:
        if arguments.snapshot is None or arguments.output is None:
            parser.error(
                "migrate-snapshot requires --snapshot and --output"
            )
        snapshot = _external_path(arguments.snapshot)
        output = _external_path(arguments.output)
        result = migrate_snapshot(snapshot)
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if output.exists():
            existing = json.loads(output.read_text())
            if existing != result:
                raise OperationsError(
                    "MIGRATION_REPORT_ALREADY_EXISTS"
                )
        else:
            output.write_text(
                json.dumps(
                    result,
                    ensure_ascii=False,
                    sort_keys=True,
                    indent=2,
                )
                + "\n"
            )
            output.chmod(0o600)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    if result.get("ready") is False or result.get("passed") is False:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
