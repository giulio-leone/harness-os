import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CURRENT_SCHEMA_VERSION = 2;
const MIGRATION_SKILL_NAME = 'harness-schema-migration';
const REQUIRED_TABLES = [
  'campaigns',
  'runs',
  'milestones',
  'issues',
  'leases',
  'checkpoints',
  'events',
  'artifacts',
  'memory_links',
  'active_sessions',
  'sync_state',
] as const;
const REQUIRED_INDEXES = [
  'idx_issues_project_campaign_status_priority',
  'idx_leases_project_status_issue_expires',
  'idx_checkpoints_issue_created_at',
  'idx_events_issue_created_at',
  'idx_active_sessions_project_status_issue',
  'idx_leases_unique_active_issue',
] as const;
const REQUIRED_COLUMNS = {
  campaigns: ['status', 'scope_json', 'updated_at'],
  checkpoints: ['task_status', 'next_step', 'artifact_ids_json'],
  artifacts: ['workspace_id', 'project_id', 'campaign_id', 'issue_id', 'metadata_json'],
  memory_links: ['workspace_id', 'project_id', 'campaign_id', 'issue_id', 'memory_ref', 'summary'],
  active_sessions: ['context_json', 'begin_input_json', 'updated_at', 'closed_at'],
  sync_state: ['family', 'last_source', 'last_runtime_sync_at', 'status', 'notes'],
} as const;

export interface HarnessStoreConfig {
  dbPath: string;
  schemaPath?: string;
}

export interface SchemaSnapshot {
  dbPath: string;
  schemaSql: string;
}

export type SqliteValue = string | number | bigint | Uint8Array | null;

export interface HarnessDatabase {
  dbPath: string;
  connection: DatabaseSync;
  close(): void;
}

export function loadSchemaSnapshot(config: HarnessStoreConfig): SchemaSnapshot {
  const schemaPath = config.schemaPath ?? resolve(__dirname, 'sqlite.schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf8');

  return {
    dbPath: config.dbPath,
    schemaSql,
  };
}

export function openHarnessDatabase(config: HarnessStoreConfig): HarnessDatabase {
  const snapshot = loadSchemaSnapshot(config);
  const connection = new DatabaseSync(snapshot.dbPath);

  try {
    connection.exec('PRAGMA journal_mode = WAL');
    connection.exec('PRAGMA busy_timeout = 5000');
    connection.exec('PRAGMA foreign_keys = ON');
    ensureHarnessSchema(connection, snapshot.schemaSql);
  } catch (error) {
    connection.close();
    throw error;
  }

  return {
    dbPath: snapshot.dbPath,
    connection,
    close() {
      connection.close();
    },
  };
}

export function ensureHarnessSchema(
  connection: DatabaseSync,
  schemaSql: string,
): void {
  if (!hasTable(connection, 'runs')) {
    if (hasUserTables(connection)) {
      throw new Error(
        'This SQLite database is not a current agent-harness database. ' +
          'Automatic legacy upgrades were removed from the runtime. ' +
          `Run the "${MIGRATION_SKILL_NAME}" skill before reopening this database.`,
      );
    }

    connection.exec(schemaSql);
    setUserVersion(connection, CURRENT_SCHEMA_VERSION);
    return;
  }

  const version = getUserVersion(connection);

  if (version === 0) {
    throw new Error(
      'Detected an unversioned or legacy harness database. ' +
        'Automatic runtime migration has been removed. ' +
        `Run the "${MIGRATION_SKILL_NAME}" skill to upgrade it to schema v${CURRENT_SCHEMA_VERSION}.`,
    );
  }

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Harness schema version ${version} is newer than this runtime (${CURRENT_SCHEMA_VERSION}).`,
    );
  }

  if (version < CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Harness schema version ${version} is no longer supported by this runtime. ` +
        `Run the "${MIGRATION_SKILL_NAME}" skill to upgrade it to schema v${CURRENT_SCHEMA_VERSION}.`,
    );
  }

  validateCurrentSchema(connection);
}

function validateCurrentSchema(connection: DatabaseSync): void {
  const missingTables = REQUIRED_TABLES.filter((tableName) => !hasTable(connection, tableName));

  const missingColumns = Object.entries(REQUIRED_COLUMNS).flatMap(
    ([tableName, columns]) =>
      columns
        .filter((columnName) => !hasColumn(connection, tableName, columnName))
        .map((columnName) => `${tableName}.${columnName}`),
  );

  const missingIndexes = REQUIRED_INDEXES.filter((indexName) => !hasIndex(connection, indexName));

  if (
    missingTables.length === 0 &&
    missingColumns.length === 0 &&
    missingIndexes.length === 0
  ) {
    return;
  }

  const missingParts = [
    ...missingTables.map((tableName) => `table:${tableName}`),
    ...missingColumns.map((columnName) => `column:${columnName}`),
    ...missingIndexes.map((indexName) => `index:${indexName}`),
  ];

  throw new Error(
    `Harness schema v${CURRENT_SCHEMA_VERSION} is incomplete or corrupted (${missingParts.join(', ')}). ` +
      `Run the "${MIGRATION_SKILL_NAME}" skill or restore a clean schema-v${CURRENT_SCHEMA_VERSION} database.`,
  );
}

function hasUserTables(connection: DatabaseSync): boolean {
  const row = connection
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'`,
    )
    .get() as { cnt: number };

  return Number(row.cnt) > 0;
}

function hasTable(connection: DatabaseSync, tableName: string): boolean {
  const table = connection
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(tableName) as { name: string } | undefined;

  return table !== undefined;
}

function hasColumn(
  connection: DatabaseSync,
  tableName: string,
  columnName: string,
): boolean {
  const columns = connection
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  return columns.some((column) => column.name === columnName);
}

function hasIndex(connection: DatabaseSync, indexName: string): boolean {
  const index = connection
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ? LIMIT 1",
    )
    .get(indexName) as { name: string } | undefined;

  return index !== undefined;
}

function getUserVersion(connection: DatabaseSync): number {
  const row = connection
    .prepare('PRAGMA user_version')
    .get() as { user_version: number };

  return Number(row.user_version);
}

function setUserVersion(connection: DatabaseSync, version: number): void {
  connection.exec(`PRAGMA user_version = ${version}`);
}

export function selectOne<T extends object>(
  connection: DatabaseSync,
  sql: string,
  parameters: readonly SqliteValue[] = [],
): T | null {
  const row = connection.prepare(sql).get(...parameters) as T | undefined;

  return row ?? null;
}

export function selectAll<T extends object>(
  connection: DatabaseSync,
  sql: string,
  parameters: readonly SqliteValue[] = [],
): T[] {
  return connection.prepare(sql).all(...parameters) as T[];
}

export function runStatement(
  connection: DatabaseSync,
  sql: string,
  parameters: readonly SqliteValue[] = [],
): void {
  connection.prepare(sql).run(...parameters);
}

export function runInTransaction<T>(
  connection: DatabaseSync,
  operation: () => T,
): T {
  connection.exec('BEGIN IMMEDIATE');

  try {
    const result = operation();
    connection.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      connection.exec('ROLLBACK');
    } catch {
      // Ignore rollback errors so the original failure is preserved.
    }

    throw error;
  }
}
