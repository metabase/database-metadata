import { postNdjson } from "./ndjson.js";
import { streamJsonElements } from "./stream-json.js";

export const API_PATHS = {
  databases: "/api/database/metadata/databases",
  tables: "/api/database/metadata/tables",
  fields: "/api/database/metadata/fields",
  fieldsFinalize: "/api/database/metadata/fields/finalize",
  fieldValues: "/api/database/field-values",
} as const;

const JSON_PATHS = {
  databases: "$.databases.*",
  tables: "$.tables.*",
  fields: "$.fields.*",
  fieldValues: "$.field_values.*",
} as const;

export type UploadMetadataOptions = {
  metadataFile: string;
  fieldValuesFile?: string;
  instanceUrl: string;
  apiKey: string;
  onWarning?: (message: string) => void;
};

export type UploadStepStats = {
  mapped: number;
  errors: number;
};

export type UploadFieldInsertStats = UploadStepStats & {
  inserted: number;
  matched: number;
};

export type UploadMetadataResult = {
  databases: UploadStepStats;
  tables: UploadStepStats;
  fieldsInsert: UploadFieldInsertStats;
  fieldsFinalize: UploadStepStats;
  fieldValues: UploadStepStats;
};

type DatabaseEntry = {
  id: number;
  name: string;
  engine: string;
};

type TableEntry = {
  id: number;
  db_id: number;
  name: string;
  schema: string | null;
  description?: string | null;
};

type FieldEntry = {
  id: number;
  table_id: number;
  name: string;
  base_type?: string;
  database_type?: string;
  description?: string | null;
  semantic_type?: string | null;
  effective_type?: string | null;
  coercion_strategy?: string | null;
  parent_id?: number | null;
  fk_target_field_id?: number | null;
};

type FieldValuesEntry = {
  field_id: number;
  values: unknown[];
  has_more_values?: boolean;
  human_readable_values?: string[];
};

type DatabaseRequest = {
  id: number;
  name: string;
  engine: string;
};

type TableRequest = {
  id: number;
  db_id: number;
  name: string;
  schema: string | null;
  description?: string | null;
};

type FieldInsertRequest = {
  id: number;
  table_id: number;
  name: string;
  base_type?: string;
  database_type?: string;
  description?: string | null;
  semantic_type?: string | null;
  effective_type?: string | null;
  coercion_strategy?: string | null;
};

type FieldFinalizeRequest = {
  id: number;
  parent_id: number | null;
  fk_target_field_id: number | null;
};

type FieldValuesRequest = {
  field_id: number;
  values: unknown[];
  has_more_values: boolean;
  human_readable_values?: string[];
};

type IdMapResponse =
  | { old_id: number; new_id: number }
  | { old_id: number; existing_id: number }
  | { old_id?: number; line?: number; error: string; detail?: string };

type FieldFinalizeResponse =
  | { id: number; ok: true }
  | { id?: number; line?: number; error: string; detail?: string };

type FieldValuesResponse =
  | { field_id: number; created: true }
  | { field_id: number; updated: true }
  | { field_id?: number; line?: number; error: string; detail?: string };

type RecordIdMapResponseOptions = {
  response: IdMapResponse;
  responseIndex: number;
  stats: UploadStepStats;
  idMap: Map<number, number>;
  label: string;
  onInserted?: (oldId: number) => void;
  onMatched?: (oldId: number) => void;
};

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function emptyStats(): UploadStepStats {
  return { mapped: 0, errors: 0 };
}

function emptyFieldInsertStats(): UploadFieldInsertStats {
  return { mapped: 0, errors: 0, inserted: 0, matched: 0 };
}

function formatError(
  label: string,
  id: number | undefined,
  response: { error?: string; detail?: string; line?: number },
  requestIndex?: number,
): string {
  const locator = buildErrorLocator(id, response.line, requestIndex);
  const detailSuffix = response.detail ? ` — ${response.detail}` : "";
  return `${label}${locator}: ${response.error ?? "unknown error"}${detailSuffix}`;
}

function buildErrorLocator(
  id: number | undefined,
  serverLine: number | undefined,
  requestIndex: number | undefined,
): string {
  if (id !== undefined) {
    return ` ${id}`;
  }
  if (serverLine !== undefined) {
    return ` (source line #${serverLine})`;
  }
  if (requestIndex !== undefined) {
    return ` (response #${requestIndex})`;
  }
  return "";
}

function pickDatabaseRequest(db: DatabaseEntry): DatabaseRequest {
  return { id: db.id, name: db.name, engine: db.engine };
}

function pickTableRequest(table: TableEntry, dbId: number): TableRequest {
  const request: TableRequest = {
    id: table.id,
    db_id: dbId,
    name: table.name,
    schema: table.schema,
  };
  if (table.description !== undefined) {
    request.description = table.description;
  }
  return request;
}

function pickFieldInsertRequest(
  field: FieldEntry,
  tableId: number,
): FieldInsertRequest {
  const request: FieldInsertRequest = {
    id: field.id,
    table_id: tableId,
    name: field.name,
  };
  if (field.base_type !== undefined) {
    request.base_type = field.base_type;
  }
  if (field.database_type !== undefined) {
    request.database_type = field.database_type;
  }
  if (field.description !== undefined) {
    request.description = field.description;
  }
  if (field.semantic_type !== undefined) {
    request.semantic_type = field.semantic_type;
  }
  if (field.effective_type !== undefined) {
    request.effective_type = field.effective_type;
  }
  if (field.coercion_strategy !== undefined) {
    request.coercion_strategy = field.coercion_strategy;
  }
  return request;
}

function pickFieldValuesRequest(
  entry: FieldValuesEntry,
  fieldId: number,
): FieldValuesRequest {
  const request: FieldValuesRequest = {
    field_id: fieldId,
    values: entry.values,
    has_more_values: entry.has_more_values ?? false,
  };
  if (entry.human_readable_values !== undefined) {
    request.human_readable_values = entry.human_readable_values;
  }
  return request;
}

export async function uploadMetadata({
  metadataFile,
  fieldValuesFile,
  instanceUrl,
  apiKey,
  onWarning,
}: UploadMetadataOptions): Promise<UploadMetadataResult> {
  const warn = onWarning ?? ((message: string) => console.warn(message));

  const databaseIdMap = new Map<number, number>();
  const tableIdMap = new Map<number, number>();
  const fieldIdMap = new Map<number, number>();
  const insertedFieldIds = new Set<number>();

  const result: UploadMetadataResult = {
    databases: emptyStats(),
    tables: emptyStats(),
    fieldsInsert: emptyFieldInsertStats(),
    fieldsFinalize: emptyStats(),
    fieldValues: emptyStats(),
  };

  function recordIdMapResponse({
    response,
    responseIndex,
    stats,
    idMap,
    label,
    onInserted,
    onMatched,
  }: RecordIdMapResponseOptions): void {
    if ("new_id" in response) {
      idMap.set(response.old_id, response.new_id);
      onInserted?.(response.old_id);
      stats.mapped += 1;
      return;
    }
    if ("existing_id" in response) {
      idMap.set(response.old_id, response.existing_id);
      onMatched?.(response.old_id);
      stats.mapped += 1;
      return;
    }
    stats.errors += 1;
    warn(formatError(label, response.old_id, response, responseIndex));
  }

  async function* remapForeignKey<In, Out>(opts: {
    jsonPath: string;
    sourceFile: string;
    getKey: (entry: In) => number;
    idMap: Map<number, number>;
    transform: (entry: In, newKey: number) => Out;
    describeSkip: (entry: In, missingKey: number) => string;
  }): AsyncGenerator<Out> {
    for await (const entry of streamJsonElements<In>(
      opts.sourceFile,
      opts.jsonPath,
    )) {
      const oldKey = opts.getKey(entry);
      const newKey = opts.idMap.get(oldKey);
      if (newKey === undefined) {
        warn(opts.describeSkip(entry, oldKey));
        continue;
      }
      yield opts.transform(entry, newKey);
    }
  }

  function remapFieldReference(
    oldId: number | null | undefined,
    ownerFieldId: number,
    referenceName: "parent_id" | "fk_target_field_id",
  ): number | null {
    if (oldId == null) {
      return null;
    }
    const newId = fieldIdMap.get(oldId);
    if (newId === undefined) {
      warn(
        `Field ${ownerFieldId}: dropping ${referenceName} → ${oldId} (referenced field was not mapped)`,
      );
      return null;
    }
    return newId;
  }

  async function* fieldFinalizeRequests(): AsyncGenerator<FieldFinalizeRequest> {
    for await (const field of streamJsonElements<FieldEntry>(
      metadataFile,
      JSON_PATHS.fields,
    )) {
      if (!insertedFieldIds.has(field.id)) {
        continue;
      }
      const newId = fieldIdMap.get(field.id);
      if (newId === undefined) {
        continue;
      }
      yield {
        id: newId,
        parent_id: remapFieldReference(field.parent_id, field.id, "parent_id"),
        fk_target_field_id: remapFieldReference(
          field.fk_target_field_id,
          field.id,
          "fk_target_field_id",
        ),
      };
    }
  }

  async function* streamDatabaseRequests(): AsyncGenerator<DatabaseRequest> {
    for await (const database of streamJsonElements<DatabaseEntry>(
      metadataFile,
      JSON_PATHS.databases,
    )) {
      yield pickDatabaseRequest(database);
    }
  }

  await postNdjson<DatabaseRequest, IdMapResponse>({
    url: joinUrl(instanceUrl, API_PATHS.databases),
    apiKey,
    requests: streamDatabaseRequests(),
    onWarning: warn,
    onResponse: (response, responseIndex) =>
      recordIdMapResponse({
        response,
        responseIndex,
        stats: result.databases,
        idMap: databaseIdMap,
        label: "Database",
      }),
  });

  await postNdjson<TableRequest, IdMapResponse>({
    url: joinUrl(instanceUrl, API_PATHS.tables),
    apiKey,
    onWarning: warn,
    requests: remapForeignKey<TableEntry, TableRequest>({
      jsonPath: JSON_PATHS.tables,
      sourceFile: metadataFile,
      getKey: (table) => table.db_id,
      idMap: databaseIdMap,
      transform: pickTableRequest,
      describeSkip: (table, oldDbId) =>
        `Skipping table ${table.id} (${table.name}): source db_id ${oldDbId} did not map to a target database`,
    }),
    onResponse: (response, responseIndex) =>
      recordIdMapResponse({
        response,
        responseIndex,
        stats: result.tables,
        idMap: tableIdMap,
        label: "Table",
      }),
  });

  await postNdjson<FieldInsertRequest, IdMapResponse>({
    url: joinUrl(instanceUrl, API_PATHS.fields),
    apiKey,
    onWarning: warn,
    requests: remapForeignKey<FieldEntry, FieldInsertRequest>({
      jsonPath: JSON_PATHS.fields,
      sourceFile: metadataFile,
      getKey: (field) => field.table_id,
      idMap: tableIdMap,
      transform: pickFieldInsertRequest,
      describeSkip: (field, oldTableId) =>
        `Skipping field ${field.id} (${field.name}): source table_id ${oldTableId} did not map to a target table`,
    }),
    onResponse: (response, responseIndex) =>
      recordIdMapResponse({
        response,
        responseIndex,
        stats: result.fieldsInsert,
        idMap: fieldIdMap,
        label: "Field",
        onInserted: (oldId) => {
          insertedFieldIds.add(oldId);
          result.fieldsInsert.inserted += 1;
        },
        onMatched: () => {
          result.fieldsInsert.matched += 1;
        },
      }),
  });

  const finalizePass = postNdjson<FieldFinalizeRequest, FieldFinalizeResponse>({
    url: joinUrl(instanceUrl, API_PATHS.fieldsFinalize),
    apiKey,
    onWarning: warn,
    requests: fieldFinalizeRequests(),
    onResponse: (response, responseIndex) => {
      if ("ok" in response) {
        result.fieldsFinalize.mapped += 1;
        return;
      }
      result.fieldsFinalize.errors += 1;
      warn(formatError("Finalize", response.id, response, responseIndex));
    },
  });

  const fieldValuesPass = fieldValuesFile
    ? postNdjson<FieldValuesRequest, FieldValuesResponse>({
        url: joinUrl(instanceUrl, API_PATHS.fieldValues),
        apiKey,
        onWarning: warn,
        requests: remapForeignKey<FieldValuesEntry, FieldValuesRequest>({
          jsonPath: JSON_PATHS.fieldValues,
          sourceFile: fieldValuesFile,
          getKey: (entry) => entry.field_id,
          idMap: fieldIdMap,
          transform: pickFieldValuesRequest,
          describeSkip: (entry, oldId) =>
            `Skipping field values for field_id ${oldId}: no mapping from source field to target`,
        }),
        onResponse: (response, responseIndex) => {
          if ("error" in response) {
            result.fieldValues.errors += 1;
            warn(
              formatError("Field values", response.field_id, response, responseIndex),
            );
            return;
          }
          result.fieldValues.mapped += 1;
        },
      })
    : Promise.resolve();

  await Promise.all([finalizePass, fieldValuesPass]);

  return result;
}
