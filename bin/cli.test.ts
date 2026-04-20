import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI = "bin/cli.ts";
const EXAMPLE_INPUT = "examples/v1/metadata.json";

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

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
        "both <input-file> and <output-folder> arguments are required",
      );
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
