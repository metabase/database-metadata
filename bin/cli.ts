#!/usr/bin/env node

import { parseArgs } from "node:util";

import { downloadMetadata } from "../src/download-metadata.js";
import { extractFieldValues } from "../src/extract-field-values.js";
import { extractMetadata } from "../src/extract-metadata.js";
import { extractSpec } from "../src/extract-spec.js";
import {
  uploadMetadata,
  type UploadMetadataResult,
  type UploadStepStats,
} from "../src/upload-metadata.js";

type ParsedValues = {
  file?: string;
  help?: boolean;
  metadata?: string;
  "field-values"?: string;
  extract?: string;
  "no-field-values"?: boolean;
  "no-extract"?: boolean;
  "api-key"?: string;
};

const DEFAULT_PATHS = {
  metadata: ".metabase/metadata.json",
  fieldValues: ".metabase/field-values.json",
  extract: ".metabase/databases",
} as const;

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

  upload-metadata <instance-url>                  Stream metadata + field values to a target
                                                  Metabase instance via NDJSON.
    --metadata <path>       Override metadata.json path (default: .metabase/metadata.json)
    --field-values <path>   Override field-values.json path (default: .metabase/field-values.json)
    --no-field-values       Skip uploading field values
    --api-key <key>         API key. Defaults to METABASE_API_KEY env var.

  download-metadata <instance-url>                Stream metadata + field values from a
                                                  Metabase instance into .metabase/ and
                                                  extract the YAML tree by default.
    --metadata <path>       Override metadata.json path (default: .metabase/metadata.json)
    --field-values <path>   Override field-values.json path (default: .metabase/field-values.json)
    --extract <folder>      Override YAML extract folder (default: .metabase/databases)
    --no-field-values       Skip downloading field values
    --no-extract            Skip YAML extraction
    --api-key <key>         API key. Defaults to METABASE_API_KEY env var.

Options:
  -h, --help           Show this help message`;

function parseArguments() {
  return parseArgs({
    allowPositionals: true,
    options: {
      file: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      metadata: { type: "string" },
      "field-values": { type: "string" },
      extract: { type: "string" },
      "no-field-values": { type: "boolean", default: false },
      "no-extract": { type: "boolean", default: false },
      "api-key": { type: "string" },
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

async function handleUploadMetadata(
  positionals: string[],
  values: ParsedValues,
): Promise<void> {
  const instanceUrl = positionals[1];

  if (!instanceUrl) {
    console.error("Error: <instance-url> argument is required");
    process.exit(1);
  }

  const apiKey = values["api-key"] ?? process.env.METABASE_API_KEY;
  if (!apiKey) {
    console.error(
      "Error: API key is required (pass --api-key or set METABASE_API_KEY)",
    );
    process.exit(1);
  }

  const metadataFile = values.metadata ?? DEFAULT_PATHS.metadata;
  const fieldValuesFile = values["no-field-values"]
    ? undefined
    : (values["field-values"] ?? DEFAULT_PATHS.fieldValues);

  const stats = await uploadMetadata({
    metadataFile,
    fieldValuesFile,
    instanceUrl,
    apiKey,
  });
  console.log(formatUploadReport(stats, Boolean(fieldValuesFile)));
  process.exit(hasAnyErrors(stats) ? 1 : 0);
}

function formatStepLine(label: string, step: UploadStepStats): string {
  const total = step.mapped + step.errors;
  return `${label}  ${step.mapped}/${total} mapped (${step.errors} errors)`;
}

function formatFieldsLine(stats: UploadMetadataResult["fieldsInsert"]): string {
  const total = stats.mapped + stats.errors;
  return `Fields:     ${stats.mapped}/${total} mapped (${stats.inserted} inserted, ${stats.matched} matched, ${stats.errors} errors)`;
}

function formatFinalizeLine(
  finalize: UploadStepStats,
  insertedCount: number,
): string {
  const base = formatStepLine("Finalized: ", finalize);
  if (insertedCount === 0 && finalize.errors === 0) {
    return `${base} — no newly-inserted fields to finalize`;
  }
  return base;
}

function formatUploadReport(
  stats: UploadMetadataResult,
  fieldValuesRan: boolean,
): string {
  const lines = [
    formatStepLine("Databases: ", stats.databases),
    formatStepLine("Tables:    ", stats.tables),
    formatFieldsLine(stats.fieldsInsert),
    formatFinalizeLine(stats.fieldsFinalize, stats.fieldsInsert.inserted),
  ];
  if (fieldValuesRan) {
    lines.push(formatStepLine("Values:    ", stats.fieldValues));
  }
  return lines.join("\n");
}

function hasAnyErrors(stats: UploadMetadataResult): boolean {
  return Object.values(stats).some((step) => step.errors > 0);
}

async function handleDownloadMetadata(
  positionals: string[],
  values: ParsedValues,
): Promise<void> {
  const instanceUrl = positionals[1];

  if (!instanceUrl) {
    console.error("Error: <instance-url> argument is required");
    process.exit(1);
  }

  const apiKey = values["api-key"] ?? process.env.METABASE_API_KEY;
  if (!apiKey) {
    console.error(
      "Error: API key is required (pass --api-key or set METABASE_API_KEY)",
    );
    process.exit(1);
  }

  const metadataFile = values.metadata ?? DEFAULT_PATHS.metadata;
  const fieldValuesFile = values["no-field-values"]
    ? undefined
    : (values["field-values"] ?? DEFAULT_PATHS.fieldValues);
  const extractFolder = values["no-extract"]
    ? undefined
    : (values.extract ?? DEFAULT_PATHS.extract);

  const result = await downloadMetadata({
    instanceUrl,
    apiKey,
    metadataFile,
    fieldValuesFile,
    extractFolder,
  });
  const lines = [`Metadata:     ${result.metadataFile}`];
  if (result.fieldValuesFile) {
    lines.push(`Field values: ${result.fieldValuesFile}`);
  }
  if (result.extractFolder) {
    lines.push(`Extracted to: ${result.extractFolder}`);
  }
  console.log(lines.join("\n"));
  process.exit(0);
}

function handleExtractSpec(values: ParsedValues): void {
  const { target } = extractSpec({ file: values.file ?? "spec.md" });
  console.log(`Spec extracted to ${target}`);
  process.exit(0);
}

async function main(): Promise<void> {
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
    case "upload-metadata":
      return handleUploadMetadata(positionals, values);
    case "download-metadata":
      return handleDownloadMetadata(positionals, values);
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
