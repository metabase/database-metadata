#!/usr/bin/env node

import { parseArgs } from "node:util";

import { extractFieldValues } from "../src/extract-field-values.js";
import { extractMetadata } from "../src/extract-metadata.js";
import { extractSpec } from "../src/extract-spec.js";

type ParsedValues = {
  file?: string;
  help?: boolean;
};

const HELP = `Usage: database-metadata <command> [arguments] [options]

Commands:
  extract-metadata <input-file> <output-folder>   Extract metadata JSON into YAML files
                                                  Writes one YAML per database + one per table
                                                  with fields nested inside.

  extract-field-values <metadata-file> <field-values-file> <output-folder>
                                                  Extract field values JSON into YAML files
                                                  placed next to each table YAML, one per
                                                  field that has sampled values.

  extract-spec                                    Copy the bundled spec.md into a target file
    --file <path>      Destination file (default: ./spec.md)

Options:
  -h, --help           Show this help message`;

function parseArguments() {
  return parseArgs({
    allowPositionals: true,
    options: {
      file: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

function handleExtractMetadata(positionals: string[]): void {
  const inputFile = positionals[1];
  const outputFolder = positionals[2];

  if (!inputFile || !outputFolder) {
    console.error(
      "Error: <input-file> and <output-folder> arguments are required",
    );
    process.exit(1);
  }

  const stats = extractMetadata({ inputFile, outputFolder });
  console.log(
    `Extracted ${stats.databases} databases, ${stats.tables} tables, ${stats.fields} fields`,
  );
  process.exit(0);
}

function handleExtractFieldValues(positionals: string[]): void {
  const metadataFile = positionals[1];
  const fieldValuesFile = positionals[2];
  const outputFolder = positionals[3];

  if (!metadataFile || !fieldValuesFile || !outputFolder) {
    console.error(
      "Error: <metadata-file>, <field-values-file>, and <output-folder> arguments are required",
    );
    process.exit(1);
  }

  const stats = extractFieldValues({
    metadataFile,
    fieldValuesFile,
    outputFolder,
  });
  console.log(
    `Extracted values for ${stats.fieldsWithValues} fields (${stats.fieldsSkipped} skipped, ${stats.orphans} orphans)`,
  );
  process.exit(0);
}

function handleExtractSpec(values: ParsedValues): void {
  const { target } = extractSpec({ file: values.file ?? "spec.md" });
  console.log(`Spec extracted to ${target}`);
  process.exit(0);
}

function main(): void {
  const { values, positionals } = parseArguments();
  const command = positionals[0];

  if (values.help || !command) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  switch (command) {
    case "extract-metadata":
      return handleExtractMetadata(positionals);
    case "extract-field-values":
      return handleExtractFieldValues(positionals);
    case "extract-spec":
      return handleExtractSpec(values);
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main();
