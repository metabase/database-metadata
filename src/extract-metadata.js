import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function getDatabaseFolder(outputFolder, db) {
  return join(outputFolder, slugify(db.name));
}

function getTablesFolder(outputFolder, db, table) {
  const dbFolder = getDatabaseFolder(outputFolder, db);
  if (table.schema) {
    return join(dbFolder, "schemas", slugify(table.schema), "tables");
  }
  return join(dbFolder, "tables");
}

function getDatabasePath(outputFolder, db) {
  return join(getDatabaseFolder(outputFolder, db), `${slugify(db.name)}.yaml`);
}

function getTablePath(outputFolder, db, table) {
  return join(getTablesFolder(outputFolder, db, table), `${slugify(table.name)}.yaml`);
}

function getDbId(db) {
  return db.name;
}

function getTableId(db, table) {
  return [getDbId(db), table.schema ?? null, table.name];
}

function getFieldOrThrow(fieldsById, id) {
  const field = fieldsById.get(id);
  if (!field) {
    throw new Error(`Field ${id} was not found`);
  }
  return field;
}

function getTableOrThrow(tablesById, id) {
  const table = tablesById.get(id);
  if (!table) {
    throw new Error(`Table ${id} was not found`);
  }
  return table;
}

function getDatabaseOrThrow(databasesById, id) {
  const database = databasesById.get(id);
  if (!database) {
    throw new Error(`Database ${id} was not found`);
  }
  return database;
}

function getFieldId(db, table, field, fieldsById) {
  const names = [];
  let current = field;
  while (current) {
    names.unshift(current.name);
    current = current.parent_id ? getFieldOrThrow(fieldsById, current.parent_id) : null;
  }
  return [...getTableId(db, table), ...names];
}

function formatDatabase(db) {
  const { id, ...result } = db;
  return result;
}

function formatTable(db, table) {
  const { id, db_id, ...result } = table;
  result.db_id = getDbId(db);
  return result;
}

function formatField(db, table, field, index) {
  const { fieldsById, tablesById, databasesById } = index;
  const { id, table_id, parent_id, fk_target_field_id, ...result } = field;
  if (parent_id) {
    const parent = getFieldOrThrow(fieldsById, parent_id);
    result.parent_id = getFieldId(db, table, parent, fieldsById);
  }
  if (fk_target_field_id) {
    const targetField = getFieldOrThrow(fieldsById, fk_target_field_id);
    const targetTable = getTableOrThrow(tablesById, targetField.table_id);
    const targetDb = getDatabaseOrThrow(databasesById, targetTable.db_id);
    result.fk_target_field_id = getFieldId(targetDb, targetTable, targetField, fieldsById);
  }
  return result;
}

function createFolder(folderPath) {
  mkdirSync(folderPath, { recursive: true });
}

function writeYaml(filePath, data) {
  writeFileSync(filePath, yaml.dump(data, { lineWidth: -1, noRefs: true }));
}

function buildIndex(metadata) {
  return {
    databases: metadata.databases,
    databasesById: new Map(metadata.databases.map((d) => [d.id, d])),
    tablesByDbId: Map.groupBy(metadata.tables, (t) => t.db_id),
    tablesById: new Map(metadata.tables.map((t) => [t.id, t])),
    fieldsByTableId: Map.groupBy(metadata.fields, (f) => f.table_id),
    fieldsById: new Map(metadata.fields.map((f) => [f.id, f])),
  };
}

function buildStats(metadata) {
  return {
    databases: metadata.databases.length,
    tables: metadata.tables.length,
    fields: metadata.fields.length,
  };
}

export function extractMetadata({ inputFile, outputFolder }) {
  const metadata = JSON.parse(readFileSync(inputFile, "utf-8"));
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
