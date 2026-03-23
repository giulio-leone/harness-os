#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
from pathlib import Path


CURRENT_SCHEMA_VERSION = 2
REQUIRED_TABLES = (
    "campaigns",
    "runs",
    "milestones",
    "issues",
    "leases",
    "checkpoints",
    "events",
    "artifacts",
    "memory_links",
    "active_sessions",
    "sync_state",
)
REQUIRED_INDEXES = (
    "idx_issues_project_campaign_status_priority",
    "idx_leases_project_status_issue_expires",
    "idx_checkpoints_issue_created_at",
    "idx_events_issue_created_at",
    "idx_active_sessions_project_status_issue",
    "idx_leases_unique_active_issue",
)
REQUIRED_COLUMNS = {
    "campaigns": ("status", "scope_json", "updated_at"),
    "checkpoints": ("task_status", "next_step", "artifact_ids_json"),
    "artifacts": ("workspace_id", "project_id", "campaign_id", "issue_id", "metadata_json"),
    "memory_links": ("workspace_id", "project_id", "campaign_id", "issue_id", "memory_ref", "summary"),
    "active_sessions": ("context_json", "begin_input_json", "updated_at", "closed_at"),
    "sync_state": ("family", "last_source", "last_runtime_sync_at", "status", "notes"),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Upgrade a legacy agent-harness SQLite database to schema v2.",
    )
    parser.add_argument("--db", required=True, help="Absolute path to the SQLite database.")
    parser.add_argument(
        "--backup-path",
        help="Optional explicit backup path. Defaults to <db>.pre-v2.bak when backups are enabled.",
    )
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="Skip the automatic file backup step.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    db_path = Path(args.db).expanduser().resolve()

    if not db_path.exists():
        print(json.dumps({"error": f"Database does not exist: {db_path}"}), file=sys.stderr)
        return 1

    backup_path: Path | None = None
    if not args.no_backup:
        backup_path = (
            Path(args.backup_path).expanduser().resolve()
            if args.backup_path
            else db_path.with_name(f"{db_path.name}.pre-v2.bak")
        )
        shutil.copy2(db_path, backup_path)

    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row

    try:
        version = get_user_version(connection)

        if version == CURRENT_SCHEMA_VERSION:
            validate_current_schema(connection)
            emit_result("already_current", db_path, backup_path)
            return 0

        if not has_table(connection, "runs"):
            raise RuntimeError(
                "The database does not contain the agent-harness tables expected by this migration."
            )

        if version not in (0, 1):
            raise RuntimeError(
                f"Unsupported schema version {version}. This migration script only upgrades legacy v1/unversioned databases to v2."
            )

        migrate_legacy_schema_to_v2(connection)
        validate_current_schema(connection)
        emit_result("migrated", db_path, backup_path)
        return 0
    except Exception as error:  # pragma: no cover - exercised from integration tests
        print(
            json.dumps(
                {
                    "error": str(error),
                    "dbPath": str(db_path),
                    "backupPath": str(backup_path) if backup_path else None,
                },
                indent=2,
            ),
            file=sys.stderr,
        )
        return 1
    finally:
        connection.close()


def emit_result(status: str, db_path: Path, backup_path: Path | None) -> None:
    print(
        json.dumps(
            {
                "status": status,
                "dbPath": str(db_path),
                "backupPath": str(backup_path) if backup_path else None,
                "schemaVersion": CURRENT_SCHEMA_VERSION,
            },
            indent=2,
        )
    )


def migrate_legacy_schema_to_v2(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA foreign_keys = OFF")

    try:
        connection.execute("BEGIN IMMEDIATE")
        rebuild_projects_table(connection)
        rebuild_campaigns_table(connection)
        rebuild_runs_table(connection)
        rebuild_milestones_table(connection)
        rebuild_issues_table(connection)
        rebuild_leases_table(connection)
        normalize_duplicate_active_leases(connection)
        rebuild_checkpoints_table(connection)
        rebuild_events_table(connection)
        rebuild_artifacts_table(connection)
        rebuild_memory_links_table(connection)
        rebuild_sync_state_table(connection)
        create_active_sessions_table(connection)
        create_support_indexes(connection)
        set_user_version(connection, CURRENT_SCHEMA_VERSION)
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.execute("PRAGMA foreign_keys = ON")

    foreign_key_errors = connection.execute("PRAGMA foreign_key_check").fetchall()
    if foreign_key_errors:
        raise RuntimeError(
            "Foreign key validation failed after migration: "
            + json.dumps([dict(row) for row in foreign_key_errors])
        )


def rebuild_projects_table(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE projects__new (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          key TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          domain TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
        );

        INSERT INTO projects__new (
          id,
          workspace_id,
          key,
          name,
          domain,
          status,
          created_at,
          updated_at
        )
        SELECT
          id,
          workspace_id,
          key,
          name,
          domain,
          status,
          created_at,
          updated_at
        FROM projects;

        DROP TABLE projects;
        ALTER TABLE projects__new RENAME TO projects;
        """
    )


def rebuild_campaigns_table(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE campaigns__new (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          objective TEXT NOT NULL,
          status TEXT NOT NULL,
          scope_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(scope_json)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id)
        );

        INSERT INTO campaigns__new (
          id,
          project_id,
          name,
          objective,
          status,
          scope_json,
          created_at,
          updated_at
        )
        SELECT
          id,
          project_id,
          name,
          objective,
          'active',
          '{}',
          created_at,
          created_at
        FROM campaigns;

        DROP TABLE campaigns;
        ALTER TABLE campaigns__new RENAME TO campaigns;
        """
    )


def rebuild_runs_table(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE runs__new (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          campaign_id TEXT,
          session_type TEXT NOT NULL,
          host TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          notes TEXT,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY (project_id) REFERENCES projects(id),
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
        );

        INSERT INTO runs__new (
          id,
          workspace_id,
          project_id,
          campaign_id,
          session_type,
          host,
          status,
          started_at,
          finished_at,
          notes
        )
        SELECT
          id,
          workspace_id,
          project_id,
          campaign_id,
          session_type,
          COALESCE(host, 'legacy-host'),
          status,
          started_at,
          finished_at,
          notes
        FROM runs;

        DROP TABLE runs;
        ALTER TABLE runs__new RENAME TO runs;
        """
    )


def rebuild_milestones_table(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE milestones__new (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          description TEXT NOT NULL,
          priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'in_progress', 'blocked', 'done', 'failed')),
          depends_on TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(depends_on)),
          FOREIGN KEY (project_id) REFERENCES projects(id)
        );

        INSERT INTO milestones__new (
          id,
          project_id,
          description,
          priority,
          status,
          depends_on
        )
        SELECT
          id,
          project_id,
          description,
          priority,
          CASE status
            WHEN 'todo' THEN 'pending'
            WHEN 'review' THEN 'ready'
            ELSE status
          END,
          depends_on
        FROM milestones;

        DROP TABLE milestones;
        ALTER TABLE milestones__new RENAME TO milestones;
        """
    )


def rebuild_issues_table(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE issues__new (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          campaign_id TEXT,
          milestone_id TEXT,
          task TEXT NOT NULL,
          priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'in_progress', 'blocked', 'needs_recovery', 'done', 'failed')),
          size TEXT NOT NULL CHECK (size IN ('S', 'M', 'L', 'XL')),
          depends_on TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(depends_on)),
          next_best_action TEXT,
          FOREIGN KEY (project_id) REFERENCES projects(id),
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
          FOREIGN KEY (milestone_id) REFERENCES milestones(id)
        );

        INSERT INTO issues__new (
          id,
          project_id,
          campaign_id,
          milestone_id,
          task,
          priority,
          status,
          size,
          depends_on,
          next_best_action
        )
        SELECT
          id,
          project_id,
          campaign_id,
          milestone_id,
          task,
          priority,
          CASE status
            WHEN 'todo' THEN 'pending'
            WHEN 'review' THEN 'ready'
            ELSE status
          END,
          size,
          depends_on,
          next_best_action
        FROM issues;

        DROP TABLE issues;
        ALTER TABLE issues__new RENAME TO issues;
        """
    )


def rebuild_leases_table(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE leases__new (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          campaign_id TEXT,
          issue_id TEXT,
          agent_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'released', 'needs_recovery', 'recovered')),
          acquired_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          released_at TEXT,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY (project_id) REFERENCES projects(id),
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
          FOREIGN KEY (issue_id) REFERENCES issues(id)
        );

        INSERT INTO leases__new (
          id,
          workspace_id,
          project_id,
          campaign_id,
          issue_id,
          agent_id,
          status,
          acquired_at,
          expires_at,
          released_at
        )
        SELECT
          id,
          workspace_id,
          project_id,
          campaign_id,
          issue_id,
          agent_id,
          status,
          acquired_at,
          expires_at,
          released_at
        FROM leases;

        DROP TABLE leases;
        ALTER TABLE leases__new RENAME TO leases;
        """
    )


def normalize_duplicate_active_leases(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        UPDATE leases
        SET status = 'needs_recovery'
        WHERE issue_id IN (
          SELECT issue_id
          FROM leases
          WHERE issue_id IS NOT NULL
            AND status = 'active'
            AND released_at IS NULL
          GROUP BY issue_id
          HAVING COUNT(*) > 1
        )
          AND status = 'active'
          AND released_at IS NULL;

        UPDATE issues
        SET status = 'needs_recovery'
        WHERE id IN (
          SELECT issue_id
          FROM leases
          WHERE issue_id IS NOT NULL
            AND status = 'needs_recovery'
            AND released_at IS NULL
        );
        """
    )


def rebuild_checkpoints_table(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE checkpoints__new (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          issue_id TEXT,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          task_status TEXT NOT NULL CHECK (task_status IN ('pending', 'ready', 'in_progress', 'blocked', 'needs_recovery', 'done', 'failed')),
          next_step TEXT NOT NULL,
          artifact_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(artifact_ids_json)),
          created_at TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES runs(id),
          FOREIGN KEY (issue_id) REFERENCES issues(id)
        );

        INSERT INTO checkpoints__new (
          id,
          run_id,
          issue_id,
          title,
          summary,
          task_status,
          next_step,
          artifact_ids_json,
          created_at
        )
        SELECT
          checkpoints.id,
          checkpoints.run_id,
          checkpoints.issue_id,
          checkpoints.title,
          checkpoints.summary,
          COALESCE(
            (
              SELECT CASE
                WHEN json_valid(events.payload) THEN json_extract(events.payload, '$.taskStatus')
                ELSE NULL
              END
              FROM events
              WHERE events.kind = 'checkpoint_payload'
                AND (
                  CASE
                    WHEN json_valid(events.payload) THEN json_extract(events.payload, '$.checkpointId')
                    ELSE NULL
                  END
                ) = checkpoints.id
              ORDER BY events.created_at DESC
              LIMIT 1
            ),
            CASE checkpoints.title
              WHEN 'needs_recovery' THEN 'needs_recovery'
              WHEN 'blocked' THEN 'blocked'
              ELSE 'in_progress'
            END
          ),
          COALESCE(
            (
              SELECT CASE
                WHEN json_valid(events.payload) THEN json_extract(events.payload, '$.nextStep')
                ELSE NULL
              END
              FROM events
              WHERE events.kind = 'checkpoint_payload'
                AND (
                  CASE
                    WHEN json_valid(events.payload) THEN json_extract(events.payload, '$.checkpointId')
                    ELSE NULL
                  END
                ) = checkpoints.id
              ORDER BY events.created_at DESC
              LIMIT 1
            ),
            'Review the latest checkpoint evidence.'
          ),
          COALESCE(
            (
              SELECT CASE
                WHEN json_valid(events.payload)
                  AND json_valid(json_extract(events.payload, '$.artifactIds'))
                THEN json_extract(events.payload, '$.artifactIds')
                ELSE NULL
              END
              FROM events
              WHERE events.kind = 'checkpoint_payload'
                AND (
                  CASE
                    WHEN json_valid(events.payload) THEN json_extract(events.payload, '$.checkpointId')
                    ELSE NULL
                  END
                ) = checkpoints.id
              ORDER BY events.created_at DESC
              LIMIT 1
            ),
            '[]'
          ),
          checkpoints.created_at
        FROM checkpoints;

        DROP TABLE checkpoints;
        ALTER TABLE checkpoints__new RENAME TO checkpoints;
        """
    )


def rebuild_events_table(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE events__new (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          issue_id TEXT,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL CHECK (json_valid(payload)),
          created_at TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES runs(id),
          FOREIGN KEY (issue_id) REFERENCES issues(id)
        );

        INSERT INTO events__new (
          id,
          run_id,
          issue_id,
          kind,
          payload,
          created_at
        )
        SELECT
          id,
          run_id,
          issue_id,
          kind,
          CASE
            WHEN json_valid(payload) THEN payload
            ELSE json_object('legacyPayload', payload)
          END,
          created_at
        FROM events
        WHERE run_id IS NOT NULL;

        DROP TABLE events;
        ALTER TABLE events__new RENAME TO events;
        """
    )


def rebuild_artifacts_table(connection: sqlite3.Connection) -> None:
    if not has_table(connection, "artifacts"):
        connection.executescript(
            """
            CREATE TABLE artifacts (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              project_id TEXT NOT NULL,
              campaign_id TEXT,
              issue_id TEXT,
              kind TEXT NOT NULL,
              path TEXT NOT NULL,
              metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
              created_at TEXT NOT NULL,
              FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
              FOREIGN KEY (project_id) REFERENCES projects(id),
              FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
              FOREIGN KEY (issue_id) REFERENCES issues(id)
            );
            """
        )
        return

    connection.executescript(
        """
        CREATE TABLE artifacts__new (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          campaign_id TEXT,
          issue_id TEXT,
          kind TEXT NOT NULL,
          path TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
          created_at TEXT NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY (project_id) REFERENCES projects(id),
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
          FOREIGN KEY (issue_id) REFERENCES issues(id)
        );

        INSERT INTO artifacts__new (
          id,
          workspace_id,
          project_id,
          campaign_id,
          issue_id,
          kind,
          path,
          metadata_json,
          created_at
        )
        SELECT
          artifacts.id,
          projects.workspace_id,
          issues.project_id,
          issues.campaign_id,
          artifacts.issue_id,
          artifacts.kind,
          artifacts.path,
          '{}',
          artifacts.created_at
        FROM artifacts
        JOIN issues ON issues.id = artifacts.issue_id
        JOIN projects ON projects.id = issues.project_id;

        DROP TABLE artifacts;
        ALTER TABLE artifacts__new RENAME TO artifacts;
        """
    )


def rebuild_memory_links_table(connection: sqlite3.Connection) -> None:
    if not has_table(connection, "memory_links"):
        connection.executescript(
            """
            CREATE TABLE memory_links (
              id TEXT PRIMARY KEY,
              workspace_id TEXT NOT NULL,
              project_id TEXT NOT NULL,
              campaign_id TEXT,
              issue_id TEXT,
              memory_kind TEXT NOT NULL,
              memory_ref TEXT NOT NULL,
              summary TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
              FOREIGN KEY (project_id) REFERENCES projects(id),
              FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
              FOREIGN KEY (issue_id) REFERENCES issues(id)
            );
            """
        )
        return

    connection.executescript(
        """
        CREATE TABLE memory_links__new (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          campaign_id TEXT,
          issue_id TEXT,
          memory_kind TEXT NOT NULL,
          memory_ref TEXT NOT NULL,
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY (project_id) REFERENCES projects(id),
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
          FOREIGN KEY (issue_id) REFERENCES issues(id)
        );

        INSERT INTO memory_links__new (
          id,
          workspace_id,
          project_id,
          campaign_id,
          issue_id,
          memory_kind,
          memory_ref,
          summary,
          created_at
        )
        SELECT
          memory_links.id,
          projects.workspace_id,
          issues.project_id,
          issues.campaign_id,
          memory_links.issue_id,
          memory_links.memory_kind,
          memory_links.memory_id,
          COALESCE(checkpoints.summary, 'Migrated legacy memory link'),
          memory_links.created_at
        FROM memory_links
        JOIN issues ON issues.id = memory_links.issue_id
        JOIN projects ON projects.id = issues.project_id
        LEFT JOIN checkpoints ON checkpoints.id = memory_links.checkpoint_id;

        DROP TABLE memory_links;
        ALTER TABLE memory_links__new RENAME TO memory_links;
        """
    )


def rebuild_sync_state_table(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE sync_state__new (
          family TEXT PRIMARY KEY,
          last_source TEXT,
          last_runtime_sync_at TEXT,
          status TEXT NOT NULL,
          notes TEXT
        );
        """
    )

    if has_table(connection, "sync_state"):
        connection.executescript(
            """
            INSERT INTO sync_state__new (
              family,
              last_source,
              last_runtime_sync_at,
              status,
              notes
            )
            SELECT
              'project:' || project_id,
              NULL,
              updated_at,
              status,
              manifest_json
            FROM sync_state;

            DROP TABLE sync_state;
            """
        )

    connection.executescript(
        """
        ALTER TABLE sync_state__new RENAME TO sync_state;
        """
    )


def create_active_sessions_table(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS active_sessions (
          token TEXT PRIMARY KEY,
          run_id TEXT NOT NULL UNIQUE,
          workspace_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          campaign_id TEXT,
          issue_id TEXT NOT NULL,
          lease_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
          context_json TEXT NOT NULL CHECK (json_valid(context_json)),
          begin_input_json TEXT NOT NULL CHECK (json_valid(begin_input_json)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          closed_at TEXT,
          FOREIGN KEY (run_id) REFERENCES runs(id),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY (project_id) REFERENCES projects(id),
          FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
          FOREIGN KEY (issue_id) REFERENCES issues(id),
          FOREIGN KEY (lease_id) REFERENCES leases(id)
        );
        """
    )


def create_support_indexes(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_issues_project_campaign_status_priority
          ON issues(project_id, campaign_id, status, priority);
        CREATE INDEX IF NOT EXISTS idx_leases_project_status_issue_expires
          ON leases(project_id, status, issue_id, expires_at);
        CREATE INDEX IF NOT EXISTS idx_checkpoints_issue_created_at
          ON checkpoints(issue_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_events_issue_created_at
          ON events(issue_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_active_sessions_project_status_issue
          ON active_sessions(project_id, status, issue_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_leases_unique_active_issue
          ON leases(issue_id)
          WHERE status = 'active'
            AND released_at IS NULL
            AND issue_id IS NOT NULL;
        """
    )


def validate_current_schema(connection: sqlite3.Connection) -> None:
    missing_tables = [table for table in REQUIRED_TABLES if not has_table(connection, table)]
    missing_columns = [
        f"{table}.{column}"
        for table, columns in REQUIRED_COLUMNS.items()
        for column in columns
        if not has_column(connection, table, column)
    ]
    missing_indexes = [index for index in REQUIRED_INDEXES if not has_index(connection, index)]

    if missing_tables or missing_columns or missing_indexes:
        missing_parts = (
            [f"table:{table}" for table in missing_tables]
            + [f"column:{column}" for column in missing_columns]
            + [f"index:{index}" for index in missing_indexes]
        )
        raise RuntimeError(
            "Schema validation failed after migration: " + ", ".join(missing_parts)
        )

    if get_user_version(connection) != CURRENT_SCHEMA_VERSION:
        raise RuntimeError(
            f"Schema validation failed: expected PRAGMA user_version={CURRENT_SCHEMA_VERSION}."
        )


def has_table(connection: sqlite3.Connection, table_name: str) -> bool:
    row = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        (table_name,),
    ).fetchone()
    return row is not None


def has_column(connection: sqlite3.Connection, table_name: str, column_name: str) -> bool:
    rows = connection.execute(f"PRAGMA table_info({table_name})").fetchall()
    return any(row["name"] == column_name for row in rows)


def has_index(connection: sqlite3.Connection, index_name: str) -> bool:
    row = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1",
        (index_name,),
    ).fetchone()
    return row is not None


def get_user_version(connection: sqlite3.Connection) -> int:
    row = connection.execute("PRAGMA user_version").fetchone()
    return int(row[0])


def set_user_version(connection: sqlite3.Connection, version: int) -> None:
    connection.execute(f"PRAGMA user_version = {version}")


if __name__ == "__main__":
    raise SystemExit(main())
