import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI = "bin/cli.ts";
const EXAMPLE_INPUT = "examples/v1/metadata.json";
const EXAMPLE_FIELD_VALUES = "examples/v1/field-values.json";

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type UploadLine = { id: number };

function runCli(args: string[]): RunResult {
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", CLI, ...args],
    cwd: REPO_ROOT,
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? 0,
  };
}

describe("cli", () => {
  describe("help", () => {
    it("prints help and exits 1 with no args", () => {
      const { stdout, exitCode } = runCli([]);
      expect(stdout).toContain("Usage: database-metadata");
      expect(exitCode).toBe(1);
    });

    it("prints help and exits 0 with --help", () => {
      const { stdout, exitCode } = runCli(["--help"]);
      expect(stdout).toContain("Usage: database-metadata");
      expect(exitCode).toBe(0);
    });

    it("errors on an unknown command", () => {
      const { stderr, exitCode } = runCli(["bogus"]);
      expect(stderr).toContain("Unknown command: bogus");
      expect(exitCode).toBe(1);
    });
  });

  describe("extract-metadata", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "database-metadata-cli-"));
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    it("extracts the bundled example into YAML files", () => {
      const { stdout, exitCode } = runCli([
        "extract-metadata",
        EXAMPLE_INPUT,
        workdir,
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Extracted 1 databases, 8 tables, 71 fields");

      const dbDir = join(workdir, "Sample Database");
      expect(existsSync(dbDir)).toBe(true);
      expect(readdirSync(dbDir).length).toBeGreaterThan(0);
    });

    it("errors when arguments are missing", () => {
      const { stderr, exitCode } = runCli(["extract-metadata"]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain(
        "<input-file> and <output-folder> arguments are required",
      );
    });
  });

  describe("extract-field-values", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "database-metadata-values-cli-"));
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    it("extracts the bundled example field values", () => {
      const { stdout, exitCode } = runCli([
        "extract-field-values",
        EXAMPLE_INPUT,
        EXAMPLE_FIELD_VALUES,
        workdir,
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Extracted values for 4 fields");

      const statePath = join(
        workdir,
        "Sample Database/schemas/PUBLIC/tables/PEOPLE/STATE.yaml",
      );
      expect(existsSync(statePath)).toBe(true);
    });

    it("errors when arguments are missing", () => {
      const { stderr, exitCode } = runCli([
        "extract-field-values",
        EXAMPLE_INPUT,
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain(
        "<metadata-file>, <field-values-file>, and <output-folder> arguments are required",
      );
    });
  });

  describe("upload-metadata", () => {
    it("errors when <instance-url> is missing", () => {
      const { stderr, exitCode } = runCli(["upload-metadata"]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("<instance-url>");
    });

    it("errors when no api key is set", () => {
      const proc = Bun.spawnSync({
        cmd: ["bun", "run", CLI, "upload-metadata", "http://127.0.0.1:1"],
        cwd: REPO_ROOT,
        env: { ...process.env, METABASE_API_KEY: "" },
      });
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString()).toContain("API key is required");
    });

    it("uploads against a mock server end-to-end", async () => {
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          const body = await request.text();
          const inLines = body
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

          let response = "";
          switch (url.pathname) {
            case "/api/database/metadata/databases":
            case "/api/database/metadata/tables":
            case "/api/database/metadata/fields":
              for (const line of inLines) {
                const { id } = JSON.parse(line) as UploadLine;
                response += JSON.stringify({ old_id: id, new_id: id }) + "\n";
              }
              break;
            case "/api/database/metadata/fields/finalize":
              for (const line of inLines) {
                const { id } = JSON.parse(line) as UploadLine;
                response += JSON.stringify({ id, ok: true }) + "\n";
              }
              break;
            default:
              return new Response("not found", { status: 404 });
          }
          return new Response(response, {
            headers: { "Content-Type": "application/x-ndjson" },
          });
        },
      });
      try {
        // NB: must use async Bun.spawn — spawnSync would block the parent
        // event loop and deadlock with the in-process mock server.
        const proc = Bun.spawn({
          cmd: [
            "bun",
            "run",
            CLI,
            "upload-metadata",
            `http://127.0.0.1:${server.port}`,
            "--metadata",
            EXAMPLE_INPUT,
            "--no-field-values",
          ],
          cwd: REPO_ROOT,
          env: { ...process.env, METABASE_API_KEY: "ci-key" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdoutText, stderrText, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(exitCode).toBe(0);
        expect(stdoutText).toContain("Databases:");
        expect(stdoutText).toContain("Finalized:");
        expect(stdoutText).not.toContain("Values:");
        expect(stderrText).toBe("");
      } finally {
        await server.stop();
      }
    });
  });

  describe("download-metadata", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "download-metadata-cli-"));
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    it("errors when <instance-url> is missing", () => {
      const { stderr, exitCode } = runCli(["download-metadata"]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("<instance-url>");
    });

    // End-to-end streaming + path-override via a spawned CLI against a mock
    // server. Defaults-in-cwd behaviour is covered by library tests in
    // src/download-metadata.test.ts — attempting the same with cwd=tmpdir
    // inside bun:test reliably hangs Bun.spawn (unrelated to CLI logic).
    it("overrides output paths via flags and writes each file", async () => {
      const EXAMPLE_METADATA_PATH = join(REPO_ROOT, EXAMPLE_INPUT);
      const EXAMPLE_VALUES_PATH = join(REPO_ROOT, EXAMPLE_FIELD_VALUES);
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/api/database/metadata") {
            return new Response(Bun.file(EXAMPLE_METADATA_PATH));
          }
          if (url.pathname === "/api/database/field-values") {
            return new Response(Bun.file(EXAMPLE_VALUES_PATH));
          }
          return new Response("not found", { status: 404 });
        },
      });
      try {
        const metadataFile = join(workdir, "custom-metadata.json");
        const fieldValuesFile = join(workdir, "custom-values.json");
        const extractFolder = join(workdir, "custom-databases");
        const proc = Bun.spawn({
          cmd: [
            "bun",
            "run",
            CLI,
            "download-metadata",
            `http://127.0.0.1:${server.port}`,
            "--metadata",
            metadataFile,
            "--field-values",
            fieldValuesFile,
            "--extract",
            extractFolder,
          ],
          cwd: REPO_ROOT,
          env: { ...process.env, METABASE_API_KEY: "ci-key" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Metadata:");
        expect(stdout).toContain("Field values:");
        expect(stdout).toContain("Extracted to:");
        expect(existsSync(metadataFile)).toBe(true);
        expect(existsSync(fieldValuesFile)).toBe(true);
        expect(
          existsSync(
            join(
              extractFolder,
              "Sample Database/schemas/PUBLIC/tables/ORDERS.yaml",
            ),
          ),
        ).toBe(true);
      } finally {
        await server.stop();
      }
    });
  });

  describe("extract-spec", () => {
    let workdir: string;

    beforeEach(() => {
      workdir = mkdtempSync(join(tmpdir(), "database-metadata-cli-spec-"));
    });

    afterEach(() => {
      rmSync(workdir, { recursive: true, force: true });
    });

    it("copies the spec to --file", () => {
      const target = join(workdir, "spec.md");
      const { stdout, exitCode } = runCli(["extract-spec", "--file", target]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Spec extracted to");
      expect(existsSync(target)).toBe(true);
    });
  });
});
