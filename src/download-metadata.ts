import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { extractFieldValues } from "./extract-field-values.js";
import { extractMetadata } from "./extract-metadata.js";

export const DOWNLOAD_PATHS = {
  metadata: "/api/database/metadata",
  fieldValues: "/api/database/field-values",
} as const;

export type DownloadMetadataOptions = {
  instanceUrl: string;
  apiKey: string;
  metadataFile: string;
  fieldValuesFile?: string;
  extractFolder?: string;
};

export type DownloadMetadataResult = {
  metadataFile: string;
  fieldValuesFile?: string;
  extractFolder?: string;
};

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

async function streamDownload(
  url: string,
  apiKey: string,
  destination: string,
): Promise<void> {
  const response = await fetch(url, {
    headers: { "X-API-Key": apiKey },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `GET ${url} failed: ${response.status} ${response.statusText} ${text}`.trim(),
    );
  }
  if (!response.body) {
    throw new Error(`GET ${url} returned an empty body`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(destination),
  );
}

export async function downloadMetadata({
  instanceUrl,
  apiKey,
  metadataFile,
  fieldValuesFile,
  extractFolder,
}: DownloadMetadataOptions): Promise<DownloadMetadataResult> {
  await streamDownload(
    joinUrl(instanceUrl, DOWNLOAD_PATHS.metadata),
    apiKey,
    metadataFile,
  );

  if (fieldValuesFile) {
    await streamDownload(
      joinUrl(instanceUrl, DOWNLOAD_PATHS.fieldValues),
      apiKey,
      fieldValuesFile,
    );
  }

  if (extractFolder) {
    extractMetadata({ inputFile: metadataFile, outputFolder: extractFolder });
    if (fieldValuesFile) {
      extractFieldValues({
        metadataFile,
        fieldValuesFile,
        outputFolder: extractFolder,
      });
    }
  }

  return { metadataFile, fieldValuesFile, extractFolder };
}
