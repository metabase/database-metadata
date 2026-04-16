#!/usr/bin/env node

import { parseArgs } from "node:util";
import { extractMetadata } from "../src/extract-metadata.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mode: { type: "string", default: "default" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const command = positionals[0];

const HELP = `Usage: database-metadata <command> <input-file> <output-folder> [options]

Commands:
  extract-metadata    Extract metadata JSON into YAML files

Arguments:
  <input-file>        Path to the metadata JSON file
  <output-folder>     Output folder for YAML files

Options:
  --mode <mode>       Output mode: default or serdes (default: default)
  -h, --help          Show this help message

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

console.error(`Unknown command: ${command}`);
process.exit(1);
