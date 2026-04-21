import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import yaml from "js-yaml";

import { extractFieldValues } from "./extract-field-values.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const EXAMPLE_METADATA = join(REPO_ROOT, "examples/v1/metadata.json");
const EXAMPLE_FIELD_VALUES = join(REPO_ROOT, "examples/v1/field-values.json");

describe("extractFieldValues", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "database-metadata-values-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("writes one YAML per non-empty field values entry", () => {
    const stats = extractFieldValues({
      metadataFile: EXAMPLE_METADATA,
      fieldValuesFile: EXAMPLE_FIELD_VALUES,
      outputFolder: workdir,
    });

    expect(stats).toEqual({
      fieldsWithValues: 4,
      fieldsSkipped: 0,
      orphans: 0,
    });

    const statePath = join(
      workdir,
      "Sample Database",
      "schemas",
      "PUBLIC",
      "tables",
      "PEOPLE",
      "STATE.yaml",
    );
    expect(existsSync(statePath)).toBe(true);
  });

  it("emits bare scalars when human_readable_values is empty", () => {
    extractFieldValues({
      metadataFile: EXAMPLE_METADATA,
      fieldValuesFile: EXAMPLE_FIELD_VALUES,
      outputFolder: workdir,
    });

    const statePath = join(
      workdir,
      "Sample Database/schemas/PUBLIC/tables/PEOPLE/STATE.yaml",
    );
    const doc = yaml.load(readFileSync(statePath, "utf8")) as {
      field_id: unknown[];
      has_more_values: boolean;
      values: unknown[];
    };

    expect(doc.field_id).toEqual([
      "Sample Database",
      "PUBLIC",
      "PEOPLE",
      "STATE",
    ]);
    expect(doc.has_more_values).toBe(false);
    expect(doc.values.slice(0, 3)).toEqual(["AK", "AL", "AR"]);
  });

  it("emits {value, label} objects when human_readable_values is provided", () => {
    extractFieldValues({
      metadataFile: EXAMPLE_METADATA,
      fieldValuesFile: EXAMPLE_FIELD_VALUES,
      outputFolder: workdir,
    });

    const ratingPath = join(
      workdir,
      "Sample Database/schemas/PUBLIC/tables/PRODUCTS/RATING.yaml",
    );
    const doc = yaml.load(readFileSync(ratingPath, "utf8")) as {
      values: Array<{ value: number; label: string }>;
    };

    expect(doc.values[0]).toEqual({ value: 0, label: "Unrated" });
    expect(doc.values[5]).toEqual({ value: 5, label: "Excellent" });
  });

  it("skips entries with an empty values array", () => {
    const metadata = JSON.parse(readFileSync(EXAMPLE_METADATA, "utf8"));
    const fieldValues = {
      field_values: [
        {
          field_id: metadata.fields[0].id,
          values: [],
          human_readable_values: [],
          has_more_values: false,
        },
      ],
    };
    const fieldValuesFile = join(workdir, "field-values.json");
    writeFileSync(fieldValuesFile, JSON.stringify(fieldValues));

    const stats = extractFieldValues({
      metadataFile: EXAMPLE_METADATA,
      fieldValuesFile,
      outputFolder: join(workdir, "out"),
    });

    expect(stats).toEqual({
      fieldsWithValues: 0,
      fieldsSkipped: 1,
      orphans: 0,
    });
  });

  it("counts and skips orphaned field_ids", () => {
    const fieldValues = {
      field_values: [
        {
          field_id: 999999,
          values: ["x"],
          human_readable_values: [],
          has_more_values: false,
        },
      ],
    };
    const fieldValuesFile = join(workdir, "field-values.json");
    writeFileSync(fieldValuesFile, JSON.stringify(fieldValues));

    const stats = extractFieldValues({
      metadataFile: EXAMPLE_METADATA,
      fieldValuesFile,
      outputFolder: join(workdir, "out"),
    });

    expect(stats).toEqual({
      fieldsWithValues: 0,
      fieldsSkipped: 0,
      orphans: 1,
    });
  });

  it("joins nested JSON field paths with dots in the filename", () => {
    const metadataPath = join(workdir, "metadata.json");
    writeFileSync(
      metadataPath,
      JSON.stringify({
        databases: [{ id: 1, name: "DB", engine: "postgres" }],
        tables: [{ id: 10, db_id: 1, name: "EVENTS", schema: "PUBLIC" }],
        fields: [
          { id: 100, table_id: 10, name: "DATA", base_type: "type/Structured" },
          { id: 101, table_id: 10, name: "user", parent_id: 100 },
          { id: 102, table_id: 10, name: "name", parent_id: 101 },
        ],
      }),
    );

    const fieldValuesPath = join(workdir, "field-values.json");
    writeFileSync(
      fieldValuesPath,
      JSON.stringify({
        field_values: [
          {
            field_id: 102,
            values: ["alice", "bob"],
            has_more_values: false,
          },
        ],
      }),
    );

    const out = join(workdir, "out");
    extractFieldValues({
      metadataFile: metadataPath,
      fieldValuesFile: fieldValuesPath,
      outputFolder: out,
    });

    const nestedPath = join(
      out,
      "DB/schemas/PUBLIC/tables/EVENTS/DATA.user.name.yaml",
    );
    expect(existsSync(nestedPath)).toBe(true);

    const doc = yaml.load(readFileSync(nestedPath, "utf8")) as {
      field_id: unknown[];
    };
    expect(doc.field_id).toEqual([
      "DB",
      "PUBLIC",
      "EVENTS",
      "DATA",
      "user",
      "name",
    ]);
  });

  it("passes has_more_values through unchanged", () => {
    const fieldValues = {
      field_values: [
        {
          field_id: 1,
          values: ["foo"],
          human_readable_values: [],
          has_more_values: true,
        },
      ],
    };
    const fieldValuesFile = join(workdir, "field-values.json");
    writeFileSync(fieldValuesFile, JSON.stringify(fieldValues));

    extractFieldValues({
      metadataFile: EXAMPLE_METADATA,
      fieldValuesFile,
      outputFolder: workdir,
    });

    const statePath = join(
      workdir,
      "Sample Database/schemas/PUBLIC/tables/PEOPLE/STATE.yaml",
    );
    const doc = yaml.load(readFileSync(statePath, "utf8")) as {
      has_more_values: boolean;
    };
    expect(doc.has_more_values).toBe(true);
  });

  it("regenerates output that matches the bundled examples", () => {
    extractFieldValues({
      metadataFile: EXAMPLE_METADATA,
      fieldValuesFile: EXAMPLE_FIELD_VALUES,
      outputFolder: workdir,
    });

    for (const relative of [
      "Sample Database/schemas/PUBLIC/tables/PEOPLE/STATE.yaml",
      "Sample Database/schemas/PUBLIC/tables/PEOPLE/SOURCE.yaml",
      "Sample Database/schemas/PUBLIC/tables/PRODUCTS/CATEGORY.yaml",
      "Sample Database/schemas/PUBLIC/tables/PRODUCTS/RATING.yaml",
    ]) {
      const checkedIn = readFileSync(
        join(REPO_ROOT, "examples/v1/databases", relative),
        "utf8",
      );
      const generated = readFileSync(join(workdir, relative), "utf8");
      expect(generated).toBe(checkedIn);
    }
  });
});
