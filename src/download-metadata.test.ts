import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { downloadMetadata } from "./download-metadata.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const EXAMPLE_METADATA = join(REPO_ROOT, "examples/v1/metadata.json");
const EXAMPLE_FIELD_VALUES = join(REPO_ROOT, "examples/v1/field-values.json");

type MockServerControl = {
  baseUrl: string;
  apiKeysSeen: string[];
  stop: () => Promise<void>;
};

type MockServerOptions = {
  metadataStatus?: number;
  fieldValuesStatus?: number;
};

function startMockServer(options: MockServerOptions = {}): MockServerControl {
  const apiKeysSeen: string[] = [];
  const metadataStatus = options.metadataStatus ?? 200;
  const fieldValuesStatus = options.fieldValuesStatus ?? 200;

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      apiKeysSeen.push(request.headers.get("X-API-Key") ?? "");
      if (url.pathname === "/api/database/metadata") {
        if (metadataStatus !== 200) {
          return new Response("boom", { status: metadataStatus });
        }
        return new Response(Bun.file(EXAMPLE_METADATA));
      }
      if (url.pathname === "/api/database/field-values") {
        if (fieldValuesStatus !== 200) {
          return new Response("boom", { status: fieldValuesStatus });
        }
        return new Response(Bun.file(EXAMPLE_FIELD_VALUES));
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiKeysSeen,
    stop: () => server.stop(),
  };
}

describe("downloadMetadata", () => {
  let workdir: string;
  let mock: MockServerControl;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "download-metadata-"));
    mock = startMockServer();
  });

  afterEach(async () => {
    await mock.stop();
    rmSync(workdir, { recursive: true, force: true });
  });

  it("streams metadata.json to the configured path", async () => {
    const metadataFile = join(workdir, "nested", "metadata.json");
    const result = await downloadMetadata({
      instanceUrl: mock.baseUrl,
      apiKey: "test-key",
      metadataFile,
    });
    expect(result.metadataFile).toBe(metadataFile);
    expect(existsSync(metadataFile)).toBe(true);
    const downloaded = readFileSync(metadataFile, "utf8");
    const expected = readFileSync(EXAMPLE_METADATA, "utf8");
    expect(downloaded).toBe(expected);
    expect(mock.apiKeysSeen).toEqual(["test-key"]);
  });

  it("downloads field-values only when a path is given", async () => {
    const metadataFile = join(workdir, "metadata.json");
    const fieldValuesFile = join(workdir, "values.json");
    const result = await downloadMetadata({
      instanceUrl: mock.baseUrl,
      apiKey: "k",
      metadataFile,
      fieldValuesFile,
    });
    expect(result.fieldValuesFile).toBe(fieldValuesFile);
    expect(existsSync(fieldValuesFile)).toBe(true);
    expect(statSync(fieldValuesFile).size).toBeGreaterThan(0);
  });

  it("extracts YAML when an extract folder is given", async () => {
    const metadataFile = join(workdir, "metadata.json");
    const fieldValuesFile = join(workdir, "values.json");
    const extractFolder = join(workdir, "databases");
    const result = await downloadMetadata({
      instanceUrl: mock.baseUrl,
      apiKey: "k",
      metadataFile,
      fieldValuesFile,
      extractFolder,
    });
    expect(result.extractFolder).toBe(extractFolder);

    const ordersYaml = join(
      extractFolder,
      "Sample Database/schemas/PUBLIC/tables/ORDERS.yaml",
    );
    expect(existsSync(ordersYaml)).toBe(true);

    const stateValues = join(
      extractFolder,
      "Sample Database/schemas/PUBLIC/tables/PEOPLE/STATE.yaml",
    );
    expect(existsSync(stateValues)).toBe(true);
  });

  it("skips field-values extraction when no field-values path is given", async () => {
    const metadataFile = join(workdir, "metadata.json");
    const extractFolder = join(workdir, "databases");
    await downloadMetadata({
      instanceUrl: mock.baseUrl,
      apiKey: "k",
      metadataFile,
      extractFolder,
    });
    const ordersYaml = join(
      extractFolder,
      "Sample Database/schemas/PUBLIC/tables/ORDERS.yaml",
    );
    expect(existsSync(ordersYaml)).toBe(true);
    const stateValues = join(
      extractFolder,
      "Sample Database/schemas/PUBLIC/tables/PEOPLE/STATE.yaml",
    );
    expect(existsSync(stateValues)).toBe(false);
  });

  it("throws on non-200 metadata response and does not write the file", async () => {
    await mock.stop();
    mock = startMockServer({ metadataStatus: 401 });
    const metadataFile = join(workdir, "metadata.json");
    await expect(
      downloadMetadata({
        instanceUrl: mock.baseUrl,
        apiKey: "k",
        metadataFile,
      }),
    ).rejects.toThrow(/401/);
    expect(existsSync(metadataFile)).toBe(false);
  });

  it("throws on non-200 field-values response", async () => {
    await mock.stop();
    mock = startMockServer({ fieldValuesStatus: 500 });
    const metadataFile = join(workdir, "metadata.json");
    const fieldValuesFile = join(workdir, "values.json");
    await expect(
      downloadMetadata({
        instanceUrl: mock.baseUrl,
        apiKey: "k",
        metadataFile,
        fieldValuesFile,
      }),
    ).rejects.toThrow(/500/);
  });
});
