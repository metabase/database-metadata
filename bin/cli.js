#!/usr/bin/env node

import { parseArgs } from "node:util";
import { extractMetadata } from "../src/extract-metadata.js";
import { extractSpec } from "../src/extract-spec.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const command = positionals[0];

const HELP = `Usage: database-metadata <command> [arguments] [options]

Commands:
  extract-metadata <input-file> <output-folder>   Extract metadata JSON into YAML files
                                                  Writes one YAML per database + one per table
                                                  with fields nested inside.

  extract-spec                                    Copy the bundled spec.md into a target file
    --file <path>      Destination file (default: ./spec.md)

Options:
  -h, --help           Show this help message`;

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

  const stats = extractMetadata({ inputFile, outputFolder });
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
