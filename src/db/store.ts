import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
  const schemaPath = config.schemaPath ?? resolve(process.cwd(), 'src/db/sqlite.schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf8');

  return {
    dbPath: config.dbPath,
    schemaSql,
  };
}

export function openHarnessDatabase(config: HarnessStoreConfig): HarnessDatabase {
  const snapshot = loadSchemaSnapshot(config);
  const connection = new DatabaseSync(snapshot.dbPath);

  connection.exec('PRAGMA foreign_keys = ON');
  ensureHarnessSchema(connection, snapshot.schemaSql);

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
  const table = connection
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get('runs') as { name: string } | undefined;

  if (table === undefined) {
    connection.exec(schemaSql);
  }
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
