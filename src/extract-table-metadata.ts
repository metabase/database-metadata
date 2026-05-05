import { createReadStream } from "node:fs";
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { JSONParser } from "@streamparser/json-node";

type DatabaseId = string;
type TableId = [DatabaseId, string | null, string];
type FieldId = [...TableId, string, ...string[]];

type Database = {
  id: DatabaseId;
  name: string;
  engine: string;
};

type Table = {
  id: TableId;
  db_id: DatabaseId;
  name: string;
  schema: string | null;
  description?: string;
};

type Field = {
  id: FieldId;
  table_id: TableId;
  name: string;
  description?: string;
  base_type?: string;
  database_type?: string;
  effective_type?: string;
  semantic_type?: string;
  coercion_strategy?: string;
  parent_id?: FieldId;
  fk_target_field_id?: FieldId;
  nfc_path?: string[];
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

const YAML_OPTS = { lineWidth: -1, noRefs: true } as const;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function escapeFilename(name: string): string {
  return name.replace(/\//g, "__SLASH__").replace(/\\/g, "__BACKSLASH__");
}

function getDatabasePath(outputFolder: string, dbName: string): string {
  const safe = escapeFilename(dbName);
  return join(outputFolder, safe, `${safe}.yaml`);
}

function getTablePath(
  outputFolder: string,
  dbName: DatabaseId,
  tableSchema: string | null,
  tableName: string,
): string {
  const dbFolder = join(outputFolder, escapeFilename(dbName));
  const tablesFolder = tableSchema
    ? join(dbFolder, "schemas", escapeFilename(tableSchema), "tables")
    : join(dbFolder, "tables");
  return join(tablesFolder, `${escapeFilename(tableName)}.yaml`);
}

function indentLines(text: string, prefix: string): string {
  return text.replace(/^(?=.)/gm, prefix);
}

function formatDatabase(db: Database) {
  const { id: _id, ...rest } = db;
  return rest;
}

function formatTable(table: Table) {
  const { id: _id, ...rest } = table;
  return rest;
}

function formatField(field: Field) {
  const { id: _id, table_id: _table_id, ...rest } = field;
  return rest;
}

function createParser(inputFile: string, key: string): JSONParser {
  const parser = new JSONParser({
    paths: [`$.${key}.*`],
    keepStack: false,
  });
  createReadStream(inputFile).pipe(parser);
  return parser;
}

export async function extractTableMetadata({
  inputFile,
  outputFolder,
}: ExtractMetadataOptions): Promise<ExtractMetadataResult> {
  let databases = 0;
  let tables = 0;
  let fields = 0;

  // Pass 1 — databases: write each database yaml.
  for await (const { value } of createParser(inputFile, "databases")) {
    const db: Database = value;
    await mkdir(join(outputFolder, escapeFilename(db.name)), {
      recursive: true,
    });
    await writeFile(
      getDatabasePath(outputFolder, db.name),
      yaml.dump(formatDatabase(db), YAML_OPTS),
    );
    databases++;
  }

  // Pass 2 — fields (touch): create an empty file at each parent table's path so pass 3
  // can detect "this table has fields" via fileExists.
  for await (const { value } of createParser(inputFile, "fields")) {
    const field: Field = value;
    const [dbName, tableSchema, tableName] = field.table_id;
    const path = getTablePath(outputFolder, dbName, tableSchema, tableName);
    if (!(await fileExists(path))) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "");
    }
  }

  // Pass 3 — tables: write each table's metadata; when pass 2 already created the file,
  // append a bare `fields:` so pass 4 can stream items underneath.
  for await (const { value } of createParser(inputFile, "tables")) {
    const table: Table = value;
    const path = getTablePath(
      outputFolder,
      table.db_id,
      table.schema,
      table.name,
    );
    const hasFields = await fileExists(path);
    if (!hasFields) {
      await mkdir(dirname(path), { recursive: true });
    }
    let content = yaml.dump(formatTable(table), YAML_OPTS);
    if (hasFields) {
      content += "fields:\n";
    }
    await writeFile(path, content);
    tables++;
  }

  // Pass 4 — fields (write): append each field as a 2-space-indented YAML list item.
  for await (const { value } of createParser(inputFile, "fields")) {
    const field: Field = value;
    const [dbName, tableSchema, tableName] = field.table_id;
    const path = getTablePath(outputFolder, dbName, tableSchema, tableName);
    const item = yaml.dump([formatField(field)], YAML_OPTS);
    await appendFile(path, indentLines(item, "  "));
    fields++;
  }

  return { databases, tables, fields };
}
