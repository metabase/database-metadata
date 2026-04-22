import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildIndex,
  createFolder,
  escapeFilename,
  getFieldKey,
  getTablesFolder,
  getFieldFilename,
  writeYaml,
  type FieldID,
  type FieldKey,
  type RawMetadata,
} from "./lib.js";

type RawFieldValueEntry = {
  field_id: FieldID;
  values: unknown[];
  human_readable_values?: string[];
  has_more_values?: boolean;
};

type RawFieldValues = {
  field_values: RawFieldValueEntry[];
};

type FormattedValue = unknown | { value: unknown; label: string };

type FormattedFieldValues = {
  field_id: FieldKey;
  has_more_values: boolean;
  values: FormattedValue[];
};

export type ExtractFieldValuesOptions = {
  metadataFile: string;
  fieldValuesFile: string;
  outputFolder: string;
};

export type ExtractFieldValuesResult = {
  fieldsWithValues: number;
  fieldsSkipped: number;
  orphans: number;
};

function formatValues(entry: RawFieldValueEntry): FormattedValue[] {
  const labels = entry.human_readable_values ?? [];
  return entry.values.map((value, index) => {
    const label = labels[index];
    if (label !== undefined && label !== null && label !== "") {
      return { value, label };
    }
    return value;
  });
}

export function extractFieldValues({
  metadataFile,
  fieldValuesFile,
  outputFolder,
}: ExtractFieldValuesOptions): ExtractFieldValuesResult {
  const metadata = JSON.parse(
    readFileSync(metadataFile, "utf-8"),
  ) as RawMetadata;
  const rawFieldValues = JSON.parse(
    readFileSync(fieldValuesFile, "utf-8"),
  ) as RawFieldValues;

  const index = buildIndex(metadata);
  const { fieldsById, tablesById, databasesById } = index;

  let fieldsWithValues = 0;
  let fieldsSkipped = 0;
  let orphans = 0;
  const createdFolders = new Set<string>();

  for (const entry of rawFieldValues.field_values ?? []) {
    const field = fieldsById.get(entry.field_id);
    if (!field) {
      orphans += 1;
      console.warn(
        `Skipping field values for unknown field_id ${entry.field_id}`,
      );
      continue;
    }

    if (entry.values.length === 0) {
      fieldsSkipped += 1;
      continue;
    }

    const table = tablesById.get(field.table_id);
    const db = table && databasesById.get(table.db_id);
    const fieldKey = table && db && getFieldKey(db, table, field, fieldsById);
    if (!table || !db || !fieldKey) {
      orphans += 1;
      console.warn(
        `Skipping field values for field_id ${entry.field_id}: could not resolve field path`,
      );
      continue;
    }

    const tableFolder = join(
      getTablesFolder(outputFolder, db, table),
      escapeFilename(table.name),
    );
    if (!createdFolders.has(tableFolder)) {
      createFolder(tableFolder);
      createdFolders.add(tableFolder);
    }

    const payload: FormattedFieldValues = {
      field_id: fieldKey,
      has_more_values: entry.has_more_values ?? false,
      values: formatValues(entry),
    };

    writeYaml(join(tableFolder, `${getFieldFilename(fieldKey)}.yaml`), payload);
    fieldsWithValues += 1;
  }

  return { fieldsWithValues, fieldsSkipped, orphans };
}
