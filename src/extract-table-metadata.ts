import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
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

type Order = "tables-first" | "fields-first";

type TouchState = {
   lastTouched: string | null 
};

type FieldState = {
  buffer: string;
  bufferedPath: string | null;
};

const YAML_OPTS = { lineWidth: -1, noRefs: true } as const;

// Per-table field buffer size before flushing
const FIELD_BUFFER_LIMIT = 1024 * 1024;

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

function isDatabase(value: unknown): value is Database {
  return typeof value === "object" && value !== null && "engine" in value;
}

function isField(value: unknown): value is Field {
  return typeof value === "object" && value !== null && "table_id" in value;
}

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && "db_id" in value;
}

// Subpass 1: write a database yaml file.
function writeDatabase(
  outputFolder: string,
  db: Database,
  stats: ExtractMetadataResult,
): void {
  mkdirSync(join(outputFolder, escapeFilename(db.name)), { recursive: true });
  writeFileSync(
    getDatabasePath(outputFolder, db.name),
    yaml.dump(formatDatabase(db), YAML_OPTS),
  );
  stats.databases++;
}

// Subpass 2: touch each parent table file so the table phase can detect "has fields"
// via existsSync. Skips the syscall for runs of consecutive fields sharing a path.
function touchTableFile(
  outputFolder: string,
  field: Field,
  state: TouchState,
): void {
  const [dbName, tableSchema, tableName] = field.table_id;
  const path = getTablePath(outputFolder, dbName, tableSchema, tableName);
  if (path === state.lastTouched) {
    return;
  }
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
  state.lastTouched = path;
}

// Subpass 3: write the table yaml; if the file already exists (touched by subpass 2),
// append a bare `fields:` trailer so subpass 4 can stream items underneath.
function writeTable(
  outputFolder: string,
  table: Table,
  stats: ExtractMetadataResult,
): void {
  const path = getTablePath(
    outputFolder,
    table.db_id,
    table.schema,
    table.name,
  );
  const hasFields = existsSync(path);
  if (!hasFields) {
    mkdirSync(dirname(path), { recursive: true });
  }
  let content = yaml.dump(formatTable(table), YAML_OPTS);
  if (hasFields) {
    content += "fields:\n";
  }
  writeFileSync(path, content);
  stats.tables++;
}

function flushFieldBuffer(state: FieldState): void {
  if (state.bufferedPath !== null) {
    appendFileSync(state.bufferedPath, state.buffer);
    state.buffer = "";
  }
}

// Subpass 4: append a field as a 2-space-indented YAML list item, buffering
// consecutive fields sharing a path so they coalesce into one appendFileSync per table.
// Wide tables flush mid-stream once the buffer exceeds FIELD_BUFFER_LIMIT bytes.
// The caller flushes the trailing buffer once the stream ends.
function writeField(
  outputFolder: string,
  field: Field,
  state: FieldState,
  stats: ExtractMetadataResult,
): void {
  const [dbName, tableSchema, tableName] = field.table_id;
  const path = getTablePath(outputFolder, dbName, tableSchema, tableName);
  if (path !== state.bufferedPath) {
    flushFieldBuffer(state);
    state.bufferedPath = path;
  }
  state.buffer += indentLines(yaml.dump([formatField(field)], YAML_OPTS), "  ");
  if (state.buffer.length >= FIELD_BUFFER_LIMIT) {
    flushFieldBuffer(state);
  }
  stats.fields++;
}

function streamAll(inputFile: string, paths: string[]): JSONParser {
  const parser = new JSONParser({ paths, keepStack: false });
  createReadStream(inputFile).pipe(parser);
  return parser;
}

// Pass 1: stream the entire JSON. Always run subpass 1 (dbs) + subpass 2 (touch).
// Detect order from the first non-database hit; if fields appear before tables, also run
// subpass 3 (writeTable) here so pass 2 only has to write fields.
async function firstPass(
  inputFile: string,
  outputFolder: string,
  stats: ExtractMetadataResult,
): Promise<Order> {
  let order: Order | null = null;
  const state: TouchState = { lastTouched: null };

  for await (const { value } of streamAll(inputFile, [
    "$.databases.*",
    "$.tables.*",
    "$.fields.*",
  ])) {
    if (isDatabase(value)) {
      writeDatabase(outputFolder, value, stats);
    } else if (isField(value)) {
      if (order === null) {
        order = "fields-first";
      }
      touchTableFile(outputFolder, value, state);
    } else if (isTable(value)) {
      if (order === null) {
        order = "tables-first";
      }
      if (order === "fields-first") {
        writeTable(outputFolder, value, stats);
      }
      // tables-first: skip — pass 2 will write them.
    }
  }

  return order ?? "tables-first";
}

// Pass 2: in tables-first mode, run subpass 3 (writeTable) + subpass 4 (writeField).
// In fields-first mode, only subpass 4 — tables were already written in pass 1.
async function secondPass(
  inputFile: string,
  outputFolder: string,
  order: Order,
  stats: ExtractMetadataResult,
): Promise<void> {
  const state: FieldState = { buffer: "", bufferedPath: null };
  const paths =
    order === "tables-first" ? ["$.tables.*", "$.fields.*"] : ["$.fields.*"];

  for await (const { value } of streamAll(inputFile, paths)) {
    if (isTable(value)) {
      writeTable(outputFolder, value, stats);
    } else if (isField(value)) {
      writeField(outputFolder, value, state, stats);
    }
  }
  flushFieldBuffer(state);
}

export async function extractTableMetadata({
  inputFile,
  outputFolder,
}: ExtractMetadataOptions): Promise<ExtractMetadataResult> {
  const stats: ExtractMetadataResult = { databases: 0, tables: 0, fields: 0 };
  const order = await firstPass(inputFile, outputFolder, stats);
  await secondPass(inputFile, outputFolder, order, stats);
  return stats;
}
