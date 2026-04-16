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

function getFieldOrThrow(fieldsById, id) {
  const field = fieldsById.get(id);
  if (!field) {
    throw new Error(`Field ${id} was not found`);
  }
  return field;
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

function getDatabaseSerdesMeta(db) {
  return [{ id: db.name, model: "Database" }];
}

function getTableSerdesMeta(db, table) {
  const meta = [{ id: db.name, model: "Database" }];
  if (table.schema) {
    meta.push({ id: table.schema, model: "Schema" });
  }
  meta.push({ id: table.name, model: "Table" });
  return meta;
}

function getFieldSerdesMeta(db, table, field, fieldsById) {
  const meta = getTableSerdesMeta(db, table);
  const names = [];
  let current = field;
  while (current) {
    names.unshift(current.name);
    current = current.parent_id ? fieldsById.get(current.parent_id) : null;
  }
  for (const name of names) meta.push({ id: name, model: "Field" });
  return meta;
}

function formatDatabase(db, { serdes = false } = {}) {
  const { id, ...result } = db;
  if (serdes) {
    result["serdes/meta"] = getDatabaseSerdesMeta(db);
  }
  return result;
}

function formatTable(db, table, { serdes = false } = {}) {
  const { id, db_id,  ...result } = table;
  result.db_id = getDbId(db);
  if (serdes) {
    result.active = true;
    result["serdes/meta"] = getTableSerdesMeta(db, table);
  }
  return result;
}

function formatField(db, table, field, fieldsById, { serdes = false } = {}) {
  const { id, table_id, parent_id, ...result } = field;
  if (parent_id) {
    const parent = getFieldOrThrow(fieldsById, parent_id);
    result.parent_id = getFieldId(db, table, parent, fieldsById);
  }
  if (serdes) {
    result.table_id = getTableId(db, table);
    result.active = true;
    result["serdes/meta"] = getFieldSerdesMeta(db, table, field, fieldsById);
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

function extractDefault({ metadata, outputFolder }) {
  const { databases, tablesByDbId, fieldsByTableId, fieldsById } = buildIndex(metadata);

  for (const db of databases) {
    createFolder(getDatabaseFolder(outputFolder, db));
    writeYaml(getDatabasePath(outputFolder, db), formatDatabase(db));

    for (const table of tablesByDbId.get(db.id) ?? []) {
      const fields = (fieldsByTableId.get(table.id) ?? []).map((field) =>
        formatField(db, table, field, fieldsById),
      );
      createFolder(getTableFolder(outputFolder, db, table));
      writeYaml(getTablePath(outputFolder, db, table), { ...formatTable(db, table), fields });
    }
  }

  return buildStats(metadata);
}

function extractSerdes({ metadata, outputFolder }) {
  const { databases, tablesByDbId, fieldsByTableId, fieldsById } = buildIndex(metadata);

  for (const db of databases) {
    createFolder(getDatabaseFolder(outputFolder, db));
    writeYaml(getDatabasePath(outputFolder, db), formatDatabase(db, { serdes: true }));

    for (const table of tablesByDbId.get(db.id) ?? []) {
      createFolder(getTableFolder(outputFolder, db, table));
      writeYaml(getTablePath(outputFolder, db, table), formatTable(db, table, { serdes: true }));

      for (const field of fieldsByTableId.get(table.id) ?? []) {
        createFolder(getFieldFolder(outputFolder, db, table, field));
        writeYaml(
          getFieldPath(outputFolder, db, table, field),
          formatField(db, table, field, fieldsById, { serdes: true }),
        );
      }
    }
  }

  return buildStats(metadata);
}

export function extractMetadata({ inputFile, outputFolder, mode }) {
  const metadata = JSON.parse(readFileSync(inputFile, "utf-8"));

  switch (mode) {
    case "default":
      return extractDefault({ metadata, outputFolder });
    case "serdes":
      return extractSerdes({ metadata, outputFolder });
  }
}
