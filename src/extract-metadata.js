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

function getTableFolder(outputFolder, db, table) {
  const dbFolder = getDatabaseFolder(outputFolder, db);
  if (table.schema) {
    return join(dbFolder, "schemas", slugify(table.schema), "tables", slugify(table.name));
  }
  return join(dbFolder, "tables", slugify(table.name));
}

function getFieldFolder(outputFolder, db, table, field) {
  return join(getTableFolder(outputFolder, db, table), "fields", slugify(field.name));
}

function getDatabasePath(outputFolder, db) {
  return join(getDatabaseFolder(outputFolder, db), `${slugify(db.name)}.yaml`);
}

function getTablePath(outputFolder, db, table) {
  return join(getTableFolder(outputFolder, db, table), `${slugify(table.name)}.yaml`);
}

function getFieldPath(outputFolder, db, table, field) {
  return join(getFieldFolder(outputFolder, db, table, field), `${slugify(field.name)}.yaml`);
}

function getDbId(db) {
  return db.name;
}

function getTableId(db, table) {
  return [getDbId(db), table.schema ?? null, table.name];
}

function getFieldId(db, table, field, fieldsById) {
  const names = [];
  let current = field;
  while (current) {
    names.unshift(current.name);
    current = current.parent_id ? fieldsById.get(current.parent_id) : null;
  }
  return [...getTableId(db, table), ...names];
}

function formatDatabase(db) {
  const { id, ...rest } = db;
  return rest;
}

function formatTable(db, table, { includeDbId = true } = {}) {
  const { id, db_id, ...rest } = table;
  return includeDbId ? { db_id: getDbId(db), ...rest } : rest;
}

function formatField(db, table, field, fieldsById, { includeTableId = true } = {}) {
  const { id, table_id, parent_id, ...rest } = field;
  const formatted = includeTableId ? { table_id: getTableId(db, table), ...rest } : rest;
  if (parent_id) {
    const parent = fieldsById.get(parent_id);
    formatted.parent_id = getFieldId(db, table, parent, fieldsById);
  }
  return formatted;
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
    tablesByDbId: Map.groupBy(metadata.tables, (t) => t.db_id),
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

function extractDatabase({ metadata, outputFolder }) {
  const { databases, tablesByDbId, fieldsByTableId, fieldsById } = buildIndex(metadata);

  for (const db of databases) {
    const tables = (tablesByDbId.get(db.id) ?? []).map((table) => {
      const fields = (fieldsByTableId.get(table.id) ?? []).map((field) =>
        formatField(db, table, field, fieldsById, { includeTableId: false }),
      );
      return { ...formatTable(db, table, { includeDbId: false }), fields };
    });

    const dbData = { ...formatDatabase(db), tables };
    createFolder(getDatabaseFolder(outputFolder, db));
    writeYaml(getDatabasePath(outputFolder, db), dbData);
  }

  return buildStats(metadata);
}

function extractTable({ metadata, outputFolder }) {
  const { databases, tablesByDbId, fieldsByTableId, fieldsById } = buildIndex(metadata);

  for (const db of databases) {
    createFolder(getDatabaseFolder(outputFolder, db));
    writeYaml(getDatabasePath(outputFolder, db), formatDatabase(db));

    for (const table of tablesByDbId.get(db.id) ?? []) {
      const fields = (fieldsByTableId.get(table.id) ?? []).map((field) =>
        formatField(db, table, field, fieldsById, { includeTableId: false }),
      );
      createFolder(getTableFolder(outputFolder, db, table));
      writeYaml(getTablePath(outputFolder, db, table), { ...formatTable(db, table), fields });
    }
  }

  return buildStats(metadata);
}

function extractField({ metadata, outputFolder }) {
  const { databases, tablesByDbId, fieldsByTableId, fieldsById } = buildIndex(metadata);

  for (const db of databases) {
    createFolder(getDatabaseFolder(outputFolder, db));
    writeYaml(getDatabasePath(outputFolder, db), formatDatabase(db));

    for (const table of tablesByDbId.get(db.id) ?? []) {
      createFolder(getTableFolder(outputFolder, db, table));
      writeYaml(getTablePath(outputFolder, db, table), formatTable(db, table));

      for (const field of fieldsByTableId.get(table.id) ?? []) {
        createFolder(getFieldFolder(outputFolder, db, table, field));
        writeYaml(getFieldPath(outputFolder, db, table, field), formatField(db, table, field, fieldsById));
      }
    }
  }

  return buildStats(metadata);
}

export function extractMetadata({ inputFile, outputFolder, level }) {
  const metadata = JSON.parse(readFileSync(inputFile, "utf-8"));

  switch (level) {
    case "database":
      return extractDatabase({ metadata, outputFolder });
    case "table":
      return extractTable({ metadata, outputFolder });
    case "field":
      return extractField({ metadata, outputFolder });
  }
}
