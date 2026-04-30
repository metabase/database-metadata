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

import { extractTableMetadata } from "./extract-table-metadata.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const EXAMPLE_INPUT = join(REPO_ROOT, "examples/v1/table_metadata.json");

describe("extractTableMetadata", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "database-metadata-extract-"));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it("extracts the bundled sample database to YAML", () => {
    const stats = extractTableMetadata({
      inputFile: EXAMPLE_INPUT,
      outputFolder: workdir,
    });

    expect(stats).toEqual({ databases: 1, tables: 8, fields: 71 });

    const dbPath = join(workdir, "Sample Database", "Sample Database.yaml");
    expect(existsSync(dbPath)).toBe(true);

    const ordersPath = join(
      workdir,
      "Sample Database",
      "schemas",
      "PUBLIC",
      "tables",
      "ORDERS.yaml",
    );
    expect(existsSync(ordersPath)).toBe(true);
  });

  it("strips numeric ids and uses natural-key db_id on tables", () => {
    extractTableMetadata({ inputFile: EXAMPLE_INPUT, outputFolder: workdir });
    const tablePath = join(
      workdir,
      "Sample Database",
      "schemas",
      "PUBLIC",
      "tables",
      "ORDERS.yaml",
    );
    const table = yaml.load(readFileSync(tablePath, "utf8")) as Record<
      string,
      unknown
    >;

    expect(table.id).toBeUndefined();
    expect(table.db_id).toBe("Sample Database");
    expect(Array.isArray(table.fields)).toBe(true);
  });

  it("rewrites fk_target_field_id as a natural-key tuple", () => {
    extractTableMetadata({ inputFile: EXAMPLE_INPUT, outputFolder: workdir });
    const tablePath = join(
      workdir,
      "Sample Database",
      "schemas",
      "PUBLIC",
      "tables",
      "ORDERS.yaml",
    );
    const table = yaml.load(readFileSync(tablePath, "utf8")) as {
      fields: Array<Record<string, unknown>>;
    };

    const userId = table.fields.find((f) => f.name === "USER_ID");
    expect(userId).toBeDefined();
    expect(userId!.fk_target_field_id).toEqual([
      "Sample Database",
      "PUBLIC",
      "PEOPLE",
      "ID",
    ]);
  });

  it("escapes slashes in entity names", () => {
    const input = join(workdir, "input.json");
    writeFileSync(
      input,
      JSON.stringify({
        databases: [{ id: 1, name: "weird/name" }],
        tables: [],
        fields: [],
      }),
    );
    const out = join(workdir, "out");
    extractTableMetadata({ inputFile: input, outputFolder: out });

    expect(
      existsSync(join(out, "weird__SLASH__name", "weird__SLASH__name.yaml")),
    ).toBe(true);
  });

  it("regenerates output that matches the bundled examples", () => {
    extractTableMetadata({ inputFile: EXAMPLE_INPUT, outputFolder: workdir });

    const checkedIn = readFileSync(
      join(
        REPO_ROOT,
        "examples/v1/databases/Sample Database/schemas/PUBLIC/tables/ORDERS.yaml",
      ),
      "utf8",
    );
    const generated = readFileSync(
      join(workdir, "Sample Database/schemas/PUBLIC/tables/ORDERS.yaml"),
      "utf8",
    );
    expect(generated).toBe(checkedIn);
  });
});
