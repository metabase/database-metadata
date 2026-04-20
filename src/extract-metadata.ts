import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

type DatabaseID = number;
type TableID = number;
type FieldID = number;

type DatabaseKey = string;
type TableKey = [DatabaseKey, string | null, string];
type FieldKey = [...TableKey, string, ...string[]];

type RawDatabase = {
  id: DatabaseID;
  name: string;
  engine: string;
};

type RawTable = {
  id: TableID;
  db_id: DatabaseID;
  name: string;
  schema: string | null;
  description?: string;
};

type RawField = {
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

type RawMetadata = {
  databases: RawDatabase[];
  tables: RawTable[];
  fields: RawField[];
};

type Database = {
  name: string;
  engine: string;
};

type Field = {
  name: string;
  description?: string;
  base_type?: string;
  database_type?: string;
  semantic_type?: string;
  parent_id?: FieldKey;
  fk_target_field_id?: FieldKey;
};

type Table = {
  name: string;
  schema: string | null;
  description?: string;
  db_id: DatabaseKey;
  fields: Field[];
};

type MetadataIndex = {
  databases: RawDatabase[];
  databasesById: Map<DatabaseID, RawDatabase>;
  tablesByDbId: Map<DatabaseID, RawTable[]>;
  tablesById: Map<TableID, RawTable>;
  fieldsByTableId: Map<TableID, RawField[]>;
  fieldsById: Map<FieldID, RawField>;
};

export type ExtractMetadataOptions = {
  inputFile: string;
  outputFolder: string;
};

export type ExtractMetadataResult = {
  databases: number;
  tables: number;
  fields: number;
};

function escapeFilename(name: string): string {
  return name.replace(/\//g, "__SLASH__").replace(/\\/g, "__BACKSLASH__");
}

function getDatabaseFolder(outputFolder: string, db: RawDatabase): string {
  return join(outputFolder, escapeFilename(db.name));
}

function getTablesFolder(
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

function getDatabasePath(outputFolder: string, db: RawDatabase): string {
  return join(
    getDatabaseFolder(outputFolder, db),
    `${escapeFilename(db.name)}.yaml`,
  );
}

function getTablePath(
  outputFolder: string,
  db: RawDatabase,
  table: RawTable,
): string {
  return join(
    getTablesFolder(outputFolder, db, table),
    `${escapeFilename(table.name)}.yaml`,
  );
}

function getDatabaseKey(db: RawDatabase): DatabaseKey {
  return db.name;
}

function getTableKey(db: RawDatabase, table: RawTable): TableKey {
  return [getDatabaseKey(db), table.schema ?? null, table.name];
}

function getFieldKey(
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

function formatDatabase(db: RawDatabase): Database {
  const { id: _id, ...result } = db;
  return result;
}

function formatTable(db: RawDatabase, table: RawTable): Omit<Table, "fields"> {
  const { id: _id, db_id: _db_id, ...rest } = table;
  return { ...rest, db_id: getDatabaseKey(db) };
}

function formatField(
  db: RawDatabase,
  table: RawTable,
  field: RawField,
  index: MetadataIndex,
): Field {
  const { fieldsById, tablesById, databasesById } = index;
  const {
    id: _id,
    table_id: _table_id,
    parent_id,
    fk_target_field_id,
    ...rest
  } = field;
  const result: Field = { ...rest };
  // Silently drop parent_id / fk_target_field_id if the referenced entity can't be resolved.
  if (parent_id) {
    const parent = fieldsById.get(parent_id);
    const parentKey = parent && getFieldKey(db, table, parent, fieldsById);
    if (parentKey) {
      result.parent_id = parentKey;
    }
  }
  if (fk_target_field_id) {
    const targetField = fieldsById.get(fk_target_field_id);
    const targetTable = targetField && tablesById.get(targetField.table_id);
    const targetDb = targetTable && databasesById.get(targetTable.db_id);
    const targetKey =
      targetDb &&
      targetTable &&
      targetField &&
      getFieldKey(targetDb, targetTable, targetField, fieldsById);
    if (targetKey) {
      result.fk_target_field_id = targetKey;
    }
  }
  return result;
}

function createFolder(folderPath: string): void {
  mkdirSync(folderPath, { recursive: true });
}

function writeYaml(filePath: string, data: unknown): void {
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

function buildIndex(metadata: RawMetadata): MetadataIndex {
  return {
    databases: metadata.databases,
    databasesById: new Map(metadata.databases.map((d) => [d.id, d])),
    tablesByDbId: groupBy(metadata.tables, (t) => t.db_id),
    tablesById: new Map(metadata.tables.map((t) => [t.id, t])),
    fieldsByTableId: groupBy(metadata.fields, (f) => f.table_id),
    fieldsById: new Map(metadata.fields.map((f) => [f.id, f])),
  };
}

function buildStats(metadata: RawMetadata): ExtractMetadataResult {
  return {
    databases: metadata.databases.length,
    tables: metadata.tables.length,
    fields: metadata.fields.length,
  };
}

export function extractMetadata({
  inputFile,
  outputFolder,
}: ExtractMetadataOptions): ExtractMetadataResult {
  const metadata = JSON.parse(readFileSync(inputFile, "utf-8")) as RawMetadata;
  const index = buildIndex(metadata);
  const { databases, tablesByDbId, fieldsByTableId } = index;

  for (const db of databases) {
    createFolder(getDatabaseFolder(outputFolder, db));
    writeYaml(getDatabasePath(outputFolder, db), formatDatabase(db));

    for (const table of tablesByDbId.get(db.id) ?? []) {
      const fields = (fieldsByTableId.get(table.id) ?? []).map((field) =>
        formatField(db, table, field, index),
      );
      createFolder(getTablesFolder(outputFolder, db, table));
      writeYaml(getTablePath(outputFolder, db, table), {
        ...formatTable(db, table),
        fields,
      });
    }
  }

  return buildStats(metadata);
}
