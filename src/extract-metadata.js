import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

function escapeFilename(name) {
  return name.replace(/\//g, "__SLASH__").replace(/\\/g, "__BACKSLASH__");
}

function getDatabaseFolder(outputFolder, db) {
  return join(outputFolder, escapeFilename(db.name));
}

function getTablesFolder(outputFolder, db, table) {
  const dbFolder = getDatabaseFolder(outputFolder, db);
  if (table.schema) {
    return join(dbFolder, "schemas", escapeFilename(table.schema), "tables");
  }
  return join(dbFolder, "tables");
}

function getDatabasePath(outputFolder, db) {
  return join(getDatabaseFolder(outputFolder, db), `${escapeFilename(db.name)}.yaml`);
}

function getTablePath(outputFolder, db, table) {
  return join(getTablesFolder(outputFolder, db, table), `${escapeFilename(table.name)}.yaml`);
}

function getDbId(db) {
  return db.name;
}

function getTableId(db, table) {
  return [getDbId(db), table.schema ?? null, table.name];
}

function getFieldId(db, table, field, fieldsById) {
  if (!field.parent_id) {
    return [...getTableId(db, table), field.name];
  }
  const parent = fieldsById.get(field.parent_id);
  if (!parent) {
    return null;
  }
  const parentId = getFieldId(db, table, parent, fieldsById);
  return parentId && [...parentId, field.name];
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
  // Silently drop parent_id / fk_target_field_id if the referenced entity can't be resolved.
  if (parent_id) {
    const parent = fieldsById.get(parent_id);
    const parentId = parent && getFieldId(db, table, parent, fieldsById);
    if (parentId) {
      result.parent_id = parentId;
    }
  }
  if (fk_target_field_id) {
    const targetField = fieldsById.get(fk_target_field_id);
    const targetTable = targetField && tablesById.get(targetField.table_id);
    const targetDb = targetTable && databasesById.get(targetTable.db_id);
    const targetId = targetDb && getFieldId(targetDb, targetTable, targetField, fieldsById);
    if (targetId) {
      result.fk_target_field_id = targetId;
    }
  }
  return result;
}

function createFolder(folderPath) {
  mkdirSync(folderPath, { recursive: true });
}

function writeYaml(filePath, data) {
  writeFileSync(filePath, yaml.dump(data, { lineWidth: -1, noRefs: true }));
}

function groupBy(items, keyFn) {
  const result = new Map();
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

function buildIndex(metadata) {
  return {
    databases: metadata.databases,
    databasesById: new Map(metadata.databases.map((d) => [d.id, d])),
    tablesByDbId: groupBy(metadata.tables, (t) => t.db_id),
    tablesById: new Map(metadata.tables.map((t) => [t.id, t])),
    fieldsByTableId: groupBy(metadata.fields, (f) => f.table_id),
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
