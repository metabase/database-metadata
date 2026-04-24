import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join, resolve } from "path";

import { parseNdjsonStream } from "./ndjson.js";
import { uploadMetadata } from "./upload-metadata.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const EXAMPLE_METADATA = join(REPO_ROOT, "examples/v1/metadata.json");
const EXAMPLE_FIELD_VALUES = join(REPO_ROOT, "examples/v1/field-values.json");

const DB_OFFSET = 1000;
const TABLE_OFFSET = 2000;
const FIELD_OFFSET = 3000;

type RecordedCall = {
  path: string;
  contentType: string;
  transferEncoding: string | null;
  contentLength: string | null;
  apiKey: string | null;
  lines: unknown[];
};

type MockServerControl = {
  baseUrl: string;
  calls: RecordedCall[];
  stop: () => Promise<void>;
  setFieldInsertBehavior: (behavior: FieldInsertBehavior) => void;
  setFieldFailure: (oldId: number) => void;
  setDatabaseFailure: (oldId: number) => void;
};

type FieldInsertBehavior = "new" | "existing" | "alternate";

type IdLine = { id: number };
type TableLine = { id: number; db_id: number };
type FieldInsertLine = Record<string, unknown> & { table_id: number };
type FinalizeLine = {
  id: number;
  parent_id: number | null;
  fk_target_field_id: number | null;
};
type FieldValuesLine = { field_id: number };

async function readNdjsonLines(
  stream: ReadableStream<Uint8Array>,
): Promise<unknown[]> {
  const lines: unknown[] = [];
  for await (const line of parseNdjsonStream<unknown>(stream)) {
    lines.push(line);
  }
  return lines;
}

function ndjsonStreamResponse(responses: AsyncIterable<unknown>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const response of responses) {
          controller.enqueue(encoder.encode(JSON.stringify(response) + "\n"));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

function startMockServer(): MockServerControl {
  const calls: RecordedCall[] = [];
  let fieldInsertBehavior: FieldInsertBehavior = "new";
  const fieldFailures = new Set<number>();
  const databaseFailures = new Set<number>();
  let fieldInsertCounter = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      const contentType = request.headers.get("Content-Type") ?? "";
      const transferEncoding = request.headers.get("Transfer-Encoding");
      const contentLength = request.headers.get("Content-Length");
      const apiKey = request.headers.get("X-API-Key");
      const lines = request.body ? await readNdjsonLines(request.body) : [];
      calls.push({
        path,
        contentType,
        transferEncoding,
        contentLength,
        apiKey,
        lines,
      });

      switch (path) {
        case "/api/database/metadata/databases": {
          async function* responses() {
            for (const line of lines as IdLine[]) {
              if (databaseFailures.has(line.id)) {
                yield {
                  old_id: line.id,
                  error: "no_match",
                  detail: "test failure",
                };
                continue;
              }
              yield { old_id: line.id, new_id: line.id + DB_OFFSET };
            }
          }
          return ndjsonStreamResponse(responses());
        }
        case "/api/database/metadata/tables": {
          async function* responses() {
            for (const line of lines as IdLine[]) {
              yield { old_id: line.id, new_id: line.id + TABLE_OFFSET };
            }
          }
          return ndjsonStreamResponse(responses());
        }
        case "/api/database/metadata/fields": {
          async function* responses() {
            for (const line of lines as IdLine[]) {
              if (fieldFailures.has(line.id)) {
                yield {
                  old_id: line.id,
                  error: "invalid_table_id",
                  detail: "test failure",
                };
                continue;
              }
              const newId = line.id + FIELD_OFFSET;
              const inserted =
                fieldInsertBehavior === "new" ||
                (fieldInsertBehavior === "alternate" &&
                  fieldInsertCounter++ % 2 === 0);
              yield inserted
                ? { old_id: line.id, new_id: newId }
                : { old_id: line.id, existing_id: newId };
            }
          }
          return ndjsonStreamResponse(responses());
        }
        case "/api/database/metadata/fields/finalize": {
          async function* responses() {
            for (const line of lines as IdLine[]) {
              yield { id: line.id, ok: true };
            }
          }
          return ndjsonStreamResponse(responses());
        }
        case "/api/database/field-values": {
          async function* responses() {
            for (const line of lines as FieldValuesLine[]) {
              yield { field_id: line.field_id, created: true };
            }
          }
          return ndjsonStreamResponse(responses());
        }
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    calls,
    stop: () => server.stop(),
    setFieldInsertBehavior: (behavior) => {
      fieldInsertBehavior = behavior;
      fieldInsertCounter = 0;
    },
    setFieldFailure: (oldId) => {
      fieldFailures.add(oldId);
    },
    setDatabaseFailure: (oldId) => {
      databaseFailures.add(oldId);
    },
  };
}

describe("uploadMetadata", () => {
  let mock: MockServerControl;

  beforeEach(() => {
    mock = startMockServer();
  });

  afterEach(async () => {
    await mock.stop();
  });

  it("runs the full pipeline and remaps ids across passes", async () => {
    const stats = await uploadMetadata({
      metadataFile: EXAMPLE_METADATA,
      fieldValuesFile: EXAMPLE_FIELD_VALUES,
      instanceUrl: mock.baseUrl,
      apiKey: "test-key",
      onWarning: () => {},
    });

    expect(stats).toEqual({
      databases: { mapped: 1, errors: 0 },
      tables: { mapped: 8, errors: 0 },
      fieldsInsert: { mapped: 71, errors: 0, inserted: 71, matched: 0 },
      fieldsFinalize: { mapped: 71, errors: 0 },
      fieldValues: { mapped: 4, errors: 0 },
    });

    const paths = mock.calls.map((call) => call.path);
    // The first three steps are strictly sequential (each feeds the next's
    // id map); finalize and field-values are kicked off concurrently once
    // the field id map is populated.
    expect(paths.slice(0, 3)).toEqual([
      "/api/database/metadata/databases",
      "/api/database/metadata/tables",
      "/api/database/metadata/fields",
    ]);
    expect(paths.slice(3).sort()).toEqual([
      "/api/database/field-values",
      "/api/database/metadata/fields/finalize",
    ]);

    for (const call of mock.calls) {
      expect(call.contentType).toBe("application/x-ndjson");
      expect(call.apiKey).toBe("test-key");
    }
  });

  it("rewrites db_id on tables using the step-1 mapping", async () => {
    await uploadMetadata({
      metadataFile: EXAMPLE_METADATA,
      instanceUrl: mock.baseUrl,
      apiKey: "k",
      onWarning: () => {},
    });
    const tableCall = mock.calls.find(
      (call) => call.path === "/api/database/metadata/tables",
    )!;
    const sampleDbNewId = 1 + DB_OFFSET;
    for (const line of tableCall.lines as TableLine[]) {
      expect(line.db_id).toBe(sampleDbNewId);
    }
  });

  it("rewrites table_id on fields using the step-3 mapping and strips fk/parent on insert", async () => {
    await uploadMetadata({
      metadataFile: EXAMPLE_METADATA,
      instanceUrl: mock.baseUrl,
      apiKey: "k",
      onWarning: () => {},
    });
    const fieldsCall = mock.calls.find(
      (call) => call.path === "/api/database/metadata/fields",
    )!;
    for (const line of fieldsCall.lines as FieldInsertLine[]) {
      expect(line.table_id).toBeGreaterThanOrEqual(TABLE_OFFSET + 1);
      expect(line.table_id).toBeLessThanOrEqual(TABLE_OFFSET + 8);
      expect(line).not.toHaveProperty("parent_id");
      expect(line).not.toHaveProperty("fk_target_field_id");
    }
  });

  it("sends remapped parent_id and fk_target_field_id in finalize", async () => {
    await uploadMetadata({
      metadataFile: EXAMPLE_METADATA,
      instanceUrl: mock.baseUrl,
      apiKey: "k",
      onWarning: () => {},
    });
    const finalizeCall = mock.calls.find(
      (call) => call.path === "/api/database/metadata/fields/finalize",
    )!;
    const lines = finalizeCall.lines as FinalizeLine[];

    for (const line of lines) {
      expect(line.id).toBeGreaterThanOrEqual(FIELD_OFFSET + 1);
      if (line.fk_target_field_id !== null) {
        expect(line.fk_target_field_id).toBeGreaterThanOrEqual(
          FIELD_OFFSET + 1,
        );
      }
    }

    const fkCount = lines.filter(
      (line) => line.fk_target_field_id !== null,
    ).length;
    expect(fkCount).toBeGreaterThan(0);
  });

  it("skips non-inserted rows in finalize (existing_id responses)", async () => {
    mock.setFieldInsertBehavior("existing");
    const stats = await uploadMetadata({
      metadataFile: EXAMPLE_METADATA,
      instanceUrl: mock.baseUrl,
      apiKey: "k",
      onWarning: () => {},
    });

    expect(stats.fieldsInsert.mapped).toBe(71);
    expect(stats.fieldsInsert.inserted).toBe(0);
    expect(stats.fieldsInsert.matched).toBe(71);
    expect(stats.fieldsFinalize.mapped).toBe(0);
    expect(stats.fieldsFinalize.errors).toBe(0);
  });

  it("rewrites field_id on field-values using the step-3 mapping", async () => {
    await uploadMetadata({
      metadataFile: EXAMPLE_METADATA,
      fieldValuesFile: EXAMPLE_FIELD_VALUES,
      instanceUrl: mock.baseUrl,
      apiKey: "k",
      onWarning: () => {},
    });
    const valuesCall = mock.calls.find(
      (call) => call.path === "/api/database/field-values",
    )!;
    for (const line of valuesCall.lines as FieldValuesLine[]) {
      expect(line.field_id).toBeGreaterThanOrEqual(FIELD_OFFSET + 1);
    }
  });

  it("skips downstream rows when the databases endpoint returns no_match for a row", async () => {
    mock.setDatabaseFailure(1);
    const warnings: string[] = [];
    const stats = await uploadMetadata({
      metadataFile: EXAMPLE_METADATA,
      fieldValuesFile: EXAMPLE_FIELD_VALUES,
      instanceUrl: mock.baseUrl,
      apiKey: "k",
      onWarning: (message) => warnings.push(message),
    });

    expect(stats).toEqual({
      databases: { mapped: 0, errors: 1 },
      tables: { mapped: 0, errors: 0 },
      fieldsInsert: { mapped: 0, errors: 0, inserted: 0, matched: 0 },
      fieldsFinalize: { mapped: 0, errors: 0 },
      fieldValues: { mapped: 0, errors: 0 },
    });
    expect(
      warnings.some((w) => w.includes("Database 1") && w.includes("no_match")),
    ).toBe(true);
    const tableCall = mock.calls.find(
      (call) => call.path === "/api/database/metadata/tables",
    );
    expect(tableCall?.lines ?? []).toEqual([]);
  });

  it("counts per-row errors without aborting the pipeline", async () => {
    mock.setFieldFailure(1);
    const warnings: string[] = [];
    const stats = await uploadMetadata({
      metadataFile: EXAMPLE_METADATA,
      fieldValuesFile: EXAMPLE_FIELD_VALUES,
      instanceUrl: mock.baseUrl,
      apiKey: "k",
      onWarning: (message) => warnings.push(message),
    });

    expect(stats.fieldsInsert.errors).toBe(1);
    expect(stats.fieldsInsert.mapped).toBe(70);
    expect(stats.fieldsFinalize.mapped).toBe(70);
    expect(warnings.some((w) => w.includes("Field 1"))).toBe(true);
  });

  it("delivers a framed request body to the server", async () => {
    await uploadMetadata({
      metadataFile: EXAMPLE_METADATA,
      instanceUrl: mock.baseUrl,
      apiKey: "k",
      onWarning: () => {},
    });
    // node:http picks Transfer-Encoding: chunked for unknown-length bodies and
    // Content-Length for bodies that fit in a single write buffer. Either is
    // fine — the point is that the bytes made it to the server intact.
    for (const call of mock.calls) {
      const hasFraming =
        call.transferEncoding === "chunked" || call.contentLength !== null;
      expect(hasFraming).toBe(true);
    }
  });

  it("skips the field-values step when the file is not provided", async () => {
    await uploadMetadata({
      metadataFile: EXAMPLE_METADATA,
      instanceUrl: mock.baseUrl,
      apiKey: "k",
      onWarning: () => {},
    });
    const paths = mock.calls.map((call) => call.path);
    expect(paths).not.toContain("/api/database/field-values");
  });
});
