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

export function loadSchemaSnapshot(config: HarnessStoreConfig): SchemaSnapshot {
  const schemaPath = config.schemaPath ?? resolve(process.cwd(), 'src/db/sqlite.schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf8');

  return {
    dbPath: config.dbPath,
    schemaSql,
  };
}
