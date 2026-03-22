#!/usr/bin/env python3
import argparse
import json
import os
import sqlite3
from pathlib import Path


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + '\n', encoding='utf-8')


def first_ready_issue(db_path: Path, project_id: str) -> str:
    query = """
    SELECT id
    FROM issues
    WHERE project_id = ? AND status = 'ready'
    ORDER BY CASE priority
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        ELSE 9
    END, rowid
    LIMIT 1
    """
    with sqlite3.connect(db_path) as connection:
        row = connection.execute(query, (project_id,)).fetchone()
    if row is None:
        raise SystemExit(f'No ready issue available in {db_path} for project {project_id}')
    return row[0]


def inspect_overview_payload(db_path: Path, project_id: str) -> dict:
    return {
        'action': 'inspect_overview',
        'input': {
            'dbPath': str(db_path),
            'projectId': project_id,
            'runLimit': 10,
        },
    }


def inspect_issue_payload(db_path: Path, issue_id: str) -> dict:
    return {
        'action': 'inspect_issue',
        'input': {
            'dbPath': str(db_path),
            'issueId': issue_id,
            'eventLimit': 20,
        },
    }


def begin_payload(action_name: str, db_path: Path, workspace_id: str, project_id: str, project_root: Path, issue_id: str) -> dict:
    mem0_enabled = action_name == 'live-claim'
    return {
        'action': 'begin_incremental',
        'input': {
            'sessionId': f'{action_name}-001',
            'dbPath': str(db_path),
            'workspaceId': workspace_id,
            'projectId': project_id,
            'progressPath': str(project_root / 'progress.md'),
            'featureListPath': str(project_root / 'feature_list.json'),
            'planPath': str(project_root / '.harness' / f'{action_name}.plan.md'),
            'syncManifestPath': str(project_root / '.harness' / f'{action_name}.SYNC_MANIFEST.yaml'),
            'mem0Enabled': mem0_enabled,
            'agentId': os.environ.get('COPILOT_AGENT_ID', 'copilot-cli'),
            'preferredIssueId': issue_id,
            'checkpointFreshnessSeconds': 3600,
        },
    }


def main() -> int:
    script_dir = Path(__file__).resolve().parent
    project_root = script_dir.parent
    runtime_dir = script_dir / 'runtime'
    generated_dir = runtime_dir / 'generated'
    catalog = read_json(script_dir / 'live-mission-catalog.json')

    parser = argparse.ArgumentParser(description='Generate portable session-lifecycle payloads for the consumer workspace template.')
    parser.add_argument('--action', required=True, choices=['live-claim', 'dry-run', 'queue-promotion'])
    parser.add_argument('--db-path', default='')
    parser.add_argument('--issue-id', default='')
    args = parser.parse_args()

    workspace_id = catalog['workspace']['id']
    project_id = catalog['project']['id']
    action_name = args.action

    if args.db_path:
        db_path = Path(args.db_path).resolve()
    elif action_name == 'dry-run':
        db_path = (runtime_dir / 'live-dry-run.sqlite').resolve()
    else:
        db_path = (runtime_dir / 'live-catalog.sqlite').resolve()

    generated = {}
    target_issue_id = ''

    if action_name in {'live-claim', 'dry-run'}:
        target_issue_id = args.issue_id or first_ready_issue(db_path, project_id)
        prefix = 'live-claim' if action_name == 'live-claim' else 'live-dry-run'
        begin_path = generated_dir / f'{prefix}.begin.json'
        overview_path = generated_dir / f'{prefix}.inspect-overview.json'
        issue_path = generated_dir / f'{prefix}.inspect-issue.json'

        write_json(begin_path, begin_payload(prefix, db_path, workspace_id, project_id, project_root, target_issue_id))
        write_json(overview_path, inspect_overview_payload(db_path, project_id))
        write_json(issue_path, inspect_issue_payload(db_path, target_issue_id))

        generated = {
            'beginInput': str(begin_path),
            'overviewInput': str(overview_path),
            'issueInput': str(issue_path),
        }
    else:
        promote_path = generated_dir / 'live-queue-promotion.json'
        overview_path = generated_dir / 'live-queue-promotion.inspect-overview.json'
        write_json(
            promote_path,
            {
                'action': 'promote_queue',
                'input': {
                    'dbPath': str(db_path),
                    'projectId': project_id,
                },
            },
        )
        write_json(overview_path, inspect_overview_payload(db_path, project_id))
        generated = {
            'promotionInput': str(promote_path),
            'overviewInput': str(overview_path),
        }

    print(
        json.dumps(
            {
                'action': action_name,
                'dbPath': str(db_path),
                'workspaceId': workspace_id,
                'projectId': project_id,
                'targetIssueId': target_issue_id,
                'generatedFiles': generated,
            },
            indent=2,
        )
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
