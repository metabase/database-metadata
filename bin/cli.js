#!/usr/bin/env node

import { parseArgs } from "node:util";
import { extractMetadata } from "../src/extract-metadata.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    level: { type: "string", default: "table" },
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
  --level <level>     Nesting level: database, table, or field (default: table)
  -h, --help          Show this help message

Levels:
  database    One YAML per database (tables and fields nested inside)
  table       One YAML per database + one per table (fields nested in tables)
  field       One YAML per database + one per table + one per field`;

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

  const level = values.level;
  if (!["database", "table", "field"].includes(level)) {
    console.error(`Error: --level must be one of: database, table, field`);
    process.exit(1);
  }

  const stats = extractMetadata({ inputFile, outputFolder, level });
  console.log(
    `Extracted ${stats.databases} databases, ${stats.tables} tables, ${stats.fields} fields`,
  );
  process.exit(0);
}

console.error(`Unknown command: ${command}`);
process.exit(1);
