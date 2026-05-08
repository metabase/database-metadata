import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export type DatabaseID = number;
type TableID = number;
export type FieldID = number;

export type DatabaseKey = string;
export type TableKey = [DatabaseKey, string | null, string];
export type FieldKey = [...TableKey, string, ...string[]];

export type RawDatabase = {
  id: DatabaseID;
  name: string;
  engine: string;
};

export type RawTable = {
  id: TableID;
  db_id: DatabaseID;
  name: string;
  schema: string | null;
  description?: string;
};

export type RawField = {
  id: FieldID;
  table_id: TableID;
  name: string;
  description?: string;
  base_type?: string;
  database_type?: string;
  semantic_type?: string;
  parent_id?: FieldID | null;
  fk_target_field_id?: FieldID | null;
};

export type RawMetadata = {
  databases: RawDatabase[];
  tables: RawTable[];
  fields: RawField[];
};

export type MetadataIndex = {
  databases: RawDatabase[];
  databasesById: Map<DatabaseID, RawDatabase>;
  tablesByDbId: Map<DatabaseID, RawTable[]>;
  tablesById: Map<TableID, RawTable>;
  fieldsByTableId: Map<TableID, RawField[]>;
  fieldsById: Map<FieldID, RawField>;
};

export function escapeFilename(name: string): string {
  return name.replace(/\//g, "__SLASH__").replace(/\\/g, "__BACKSLASH__");
}

// Field-values filenames join nested JSON paths with dots, so a literal dot in
// a field segment would produce an ambiguous path (e.g. `a.b.yaml` could mean
// either a nested path or a single field named `a.b`). We escape dots inside
// each segment before joining.
function escapeFieldSegment(name: string): string {
  return escapeFilename(name).replace(/\./g, "__DOT__");
}

export function getDatabaseFolder(
  outputFolder: string,
  db: RawDatabase,
): string {
  return join(outputFolder, escapeFilename(db.name));
}

export function getTablesFolder(
  outputFolder: string,
  db: RawDatabase,
  table: RawTable,
): string {
  const dbFolder = getDatabaseFolder(outputFolder, db);
  if (table.schema) {
    return join(dbFolder, "schemas", escapeFilename(table.schema), "tables");
  }
  return join(dbFolder, "tables");
}

export function getDatabasePath(outputFolder: string, db: RawDatabase): string {
  return join(
    getDatabaseFolder(outputFolder, db),
    `${escapeFilename(db.name)}.yaml`,
  );
}

export function getTablePath(
  outputFolder: string,
  db: RawDatabase,
  table: RawTable,
): string {
  return join(
    getTablesFolder(outputFolder, db, table),
    `${escapeFilename(table.name)}.yaml`,
  );
}

export function getDatabaseKey(db: RawDatabase): DatabaseKey {
  return db.name;
}

export function getTableKey(db: RawDatabase, table: RawTable): TableKey {
  return [getDatabaseKey(db), table.schema ?? null, table.name];
}

export function getFieldKey(
  db: RawDatabase,
  table: RawTable,
  field: RawField,
  fieldsById: Map<FieldID, RawField>,
): FieldKey | null {
  if (!field.parent_id) {
    return [...getTableKey(db, table), field.name];
  }
  const parent = fieldsById.get(field.parent_id);
  if (!parent) {
    return null;
  }
  const parentKey = getFieldKey(db, table, parent, fieldsById);
  return parentKey && [...parentKey, field.name];
}

export function getFieldFilename(fieldKey: FieldKey): string {
  const [, , , ...fieldPath] = fieldKey;
  return fieldPath.map(escapeFieldSegment).join(".");
}

export function createFolder(folderPath: string): void {
  mkdirSync(folderPath, { recursive: true });
}

export function writeYaml(filePath: string, data: unknown): void {
  writeFileSync(filePath, yaml.dump(data, { lineWidth: -1, noRefs: true }));
}

function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const existing = result.get(key);
    if (existing) {
      existing.push(item);
    } else {
      result.set(key, [item]);
    }
  }
  return result;
}

export function buildIndex(metadata: RawMetadata): MetadataIndex {
  return {
    databases: metadata.databases,
    databasesById: new Map(metadata.databases.map((d) => [d.id, d])),
    tablesByDbId: groupBy(metadata.tables, (t) => t.db_id),
    tablesById: new Map(metadata.tables.map((t) => [t.id, t])),
    fieldsByTableId: groupBy(metadata.fields, (f) => f.table_id),
    fieldsById: new Map(metadata.fields.map((f) => [f.id, f])),
  };
}
