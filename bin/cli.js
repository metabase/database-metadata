#!/usr/bin/env node

import { parseArgs } from "node:util";
import { extractMetadata } from "../src/extract-metadata.js";
import { extractSpec } from "../src/extract-spec.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mode: { type: "string", default: "default" },
    file: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const command = positionals[0];

const HELP = `Usage: database-metadata <command> [arguments] [options]

Commands:
  extract-metadata <input-file> <output-folder>   Extract metadata JSON into YAML files
    --mode <mode>      Output mode: default or serdes (default: default)

  extract-spec                                    Copy the bundled spec.md into a target file
    --file <path>      Destination file (default: ./spec.md)

Options:
  -h, --help           Show this help message

Modes:
  default    One YAML per database + one per table with fields nested inside
  serdes     Separate YAML per database, table, and field, each with serdes/meta`;

if (values.help || !command) {
  console.log(HELP);
  process.exit(command ? 0 : 1);
}

if (command === "extract-metadata") {
  const inputFile = positionals[1];
  const outputFolder = positionals[2];

  if (!inputFile || !outputFolder) {
    console.error("Error: both <input-file> and <output-folder> arguments are required");
    process.exit(1);
  }

  const mode = values.mode;
  if (!["default", "serdes"].includes(mode)) {
    console.error(`Error: --mode must be one of: default, serdes`);
    process.exit(1);
  }

  const stats = extractMetadata({ inputFile, outputFolder, mode });
  console.log(
    `Extracted ${stats.databases} databases, ${stats.tables} tables, ${stats.fields} fields`,
  );
  process.exit(0);
}

if (command === "extract-spec") {
  const { target } = extractSpec({ file: values.file ?? "spec.md" });
  console.log(`Spec extracted to ${target}`);
  process.exit(0);
}

console.error(`Unknown command: ${command}`);
process.exit(1);
