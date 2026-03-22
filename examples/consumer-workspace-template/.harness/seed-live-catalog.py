#!/usr/bin/env python3
import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def discover_harness_core(project_root: Path) -> Path:
    candidates = []
    env_value = os.environ.get('HARNESS_CORE')
    if env_value:
        candidates.append(Path(env_value).expanduser())

    candidates.extend(
        [
            project_root,
            project_root.parent,
            project_root.parent.parent,
            project_root.parent / 'agent-harness-core',
            project_root.parent.parent / 'agent-harness-core',
            Path.home() / 'Sviluppo' / 'agent-harness-core',
        ]
    )

    seen = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if (resolved / 'src/db/sqlite.schema.sql').exists():
            return resolved

    raise SystemExit('Unable to resolve agent-harness-core. Set HARNESS_CORE to the repo root before seeding the catalog.')


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + '\n', encoding='utf-8')


def main() -> int:
    script_dir = Path(__file__).resolve().parent
    project_root = script_dir.parent

    parser = argparse.ArgumentParser(description='Seed the template live mission catalog into a fresh harness SQLite database.')
    parser.add_argument('--catalog-path', default=str(script_dir / 'live-mission-catalog.json'))
    parser.add_argument('--db-path', default=str(script_dir / 'runtime' / 'live-catalog.sqlite'))
    parser.add_argument('--schema-path', default='')
    parser.add_argument('--reset', action='store_true', help='Delete the target DB before reseeding it.')
    args = parser.parse_args()

    catalog_path = Path(args.catalog_path).resolve()
    db_path = Path(args.db_path).resolve()
    schema_path = Path(args.schema_path).resolve() if args.schema_path else discover_harness_core(project_root) / 'src/db/sqlite.schema.sql'

    if not catalog_path.exists():
        raise SystemExit(f'Catalog file not found: {catalog_path}')
    if not schema_path.exists():
        raise SystemExit(f'Schema file not found: {schema_path}')

    if args.reset and db_path.exists():
        db_path.unlink()

    db_path.parent.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(catalog_path.read_text(encoding='utf-8'))
    schema_sql = schema_path.read_text(encoding='utf-8')
    seeded_at = utc_now()

    connection = sqlite3.connect(db_path)
    try:
        connection.executescript(schema_sql)
        cursor = connection.cursor()

        workspace = catalog['workspace']
        project = catalog['project']

        cursor.execute(
            'INSERT OR REPLACE INTO workspaces (id, name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            (workspace['id'], workspace['name'], workspace['kind'], seeded_at, seeded_at),
        )
        cursor.execute(
            'INSERT OR REPLACE INTO projects (id, workspace_id, key, name, domain, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (
                project['id'],
                workspace['id'],
                project['key'],
                project['name'],
                project['domain'],
                project['status'],
                seeded_at,
                seeded_at,
            ),
        )

        for campaign in catalog['campaigns']:
            cursor.execute(
                'INSERT OR REPLACE INTO campaigns (id, project_id, name, objective, status, scope_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (
                    campaign['id'],
                    project['id'],
                    campaign['name'],
                    campaign['objective'],
                    campaign['status'],
                    json.dumps(campaign.get('scope', {}), sort_keys=True),
                    seeded_at,
                    seeded_at,
                ),
            )

        for issue in catalog['issues']:
            cursor.execute(
                'INSERT OR REPLACE INTO issues (id, project_id, campaign_id, milestone_id, task, priority, status, size, depends_on, next_best_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (
                    issue['id'],
                    project['id'],
                    issue['campaignId'],
                    None,
                    issue['task'],
                    issue['priority'],
                    issue['status'],
                    issue['size'],
                    json.dumps(issue.get('dependsOn', [])),
                    issue.get('nextBestAction'),
                ),
            )

        connection.commit()

        counts = {
            'campaignCount': cursor.execute('SELECT COUNT(*) FROM campaigns WHERE project_id = ?', (project['id'],)).fetchone()[0],
            'issueCount': cursor.execute('SELECT COUNT(*) FROM issues WHERE project_id = ?', (project['id'],)).fetchone()[0],
            'readyIssues': cursor.execute("SELECT COUNT(*) FROM issues WHERE project_id = ? AND status = 'ready'", (project['id'],)).fetchone()[0],
            'pendingIssues': cursor.execute("SELECT COUNT(*) FROM issues WHERE project_id = ? AND status = 'pending'", (project['id'],)).fetchone()[0],
        }
    finally:
        connection.close()

    overview_input = project_root / '.harness' / 'runtime' / 'generated' / 'live-catalog.inspect-overview.json'
    write_json(
        overview_input,
        {
            'action': 'inspect_overview',
            'input': {
                'dbPath': str(db_path),
                'projectId': project['id'],
                'runLimit': 10,
            },
        },
    )

    print(
        json.dumps(
            {
                'catalogPath': str(catalog_path),
                'dbPath': str(db_path),
                'schemaPath': str(schema_path),
                'seededAt': seeded_at,
                'workspaceId': workspace['id'],
                'projectId': project['id'],
                'overviewInputPath': str(overview_input),
                **counts,
            },
            indent=2,
        )
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
