import { readFileSync } from "node:fs";

import {
  buildIndex,
  createFolder,
  getDatabaseFolder,
  getDatabaseKey,
  getDatabasePath,
  getFieldKey,
  getTablePath,
  getTablesFolder,
  writeYaml,
  type DatabaseKey,
  type FieldKey,
  type MetadataIndex,
  type RawDatabase,
  type RawField,
  type RawMetadata,
  type RawTable,
} from "./lib.js";

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

export type ExtractMetadataOptions = {
  inputFile: string;
  outputFolder: string;
};

export type ExtractMetadataResult = {
  databases: number;
  tables: number;
  fields: number;
};

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

function buildStats(metadata: RawMetadata): ExtractMetadataResult {
  return {
    databases: metadata.databases.length,
    tables: metadata.tables.length,
    fields: metadata.fields.length,
  };
}

export function extractTableMetadata({
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
