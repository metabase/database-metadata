export type PostNdjsonOptions<Req, Res> = {
  url: string;
  apiKey: string;
  requests: AsyncIterable<Req>;
  onResponse: (response: Res, index: number) => void | Promise<void>;
  onWarning?: (message: string) => void;
  /** Max rows per HTTP request. Default 2000. */
  batchSize?: number;
};

// JSON.stringify escapes control characters in string values, so the
// serialized output should never contain a raw \n or \r. If it does (e.g. a
// value's custom toJSON returned raw control chars), the server's line-seq
// would split the line mid-object. Defensive: escape them before sending and
// warn the caller so the upstream bug can be chased.
const RAW_NEWLINE_PATTERN = /[\n\r]/g;

// Cap rows-per-HTTP-POST so each request stays within one server-side DB
// transaction. The Metabase NDJSON endpoints partition inserts in groups of
// 2000 per transaction; sending more than that per POST forces multiple
// transactions inside a single request, during which the server stops reading
// body bytes long enough for Jetty's idle timeout to drop the tail. Matching
// the server's 2000 keeps every POST to exactly one transaction with minimum
// round-trips.
const DEFAULT_BATCH_SIZE = 2000;

export async function postNdjson<Req, Res>({
  url,
  apiKey,
  requests,
  onResponse,
  onWarning,
  batchSize = DEFAULT_BATCH_SIZE,
}: PostNdjsonOptions<Req, Res>): Promise<void> {
  let globalIndex = 0;

  for await (const batch of batchAsyncIterable(requests, batchSize)) {
    const batchOffset = globalIndex;
    await postNdjsonBatch({
      url,
      apiKey,
      batch,
      onResponse: (response, localIndex) =>
        onResponse(response, batchOffset + localIndex),
      onWarning,
    });
    globalIndex += batch.length;
  }
}

async function* batchAsyncIterable<T>(
  source: AsyncIterable<T>,
  size: number,
): AsyncGenerator<T[]> {
  let current: T[] = [];
  for await (const item of source) {
    current.push(item);
    if (current.length >= size) {
      yield current;
      current = [];
    }
  }
  if (current.length > 0) {
    yield current;
  }
}

type PostBatchOptions<Req, Res> = {
  url: string;
  apiKey: string;
  batch: Req[];
  onResponse: (response: Res, index: number) => void | Promise<void>;
  onWarning?: (message: string) => void;
};

async function postNdjsonBatch<Req, Res>({
  url,
  apiKey,
  batch,
  onResponse,
  onWarning,
}: PostBatchOptions<Req, Res>): Promise<void> {
  if (batch.length === 0) {
    return;
  }

  const body = serializeBatch(batch, onWarning);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-ndjson",
      "X-API-Key": apiKey,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `POST ${url} failed: ${response.status} ${response.statusText} ${text}`.trim(),
    );
  }
  if (!response.body) {
    throw new Error(`POST ${url} returned an empty body`);
  }

  let received = 0;
  for await (const parsedLine of parseNdjsonStream<Res>(response.body)) {
    await onResponse(parsedLine, received);
    received += 1;
  }

  if (received < batch.length) {
    throw new Error(
      `POST ${url}: server acknowledged ${received} of ${batch.length} sent rows — ${batch.length - received} rows dropped by the server (likely a per-row error terminated the stream)`,
    );
  }
}

function serializeBatch<Req>(
  batch: Req[],
  onWarning: ((message: string) => void) | undefined,
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (let index = 0; index < batch.length; index += 1) {
    const raw = JSON.stringify(batch[index]);
    const safe =
      raw.includes("\n") || raw.includes("\r")
        ? sanitizeRawNewlines(raw, index, onWarning)
        : raw;
    const encoded = encoder.encode(safe + "\n");
    chunks.push(encoded);
    totalBytes += encoded.length;
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

export async function* parseNdjsonStream<T>(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  // Slice once per chunk (not per line) to keep parsing O(n) on large responses.
  let pending = "";

  for await (const chunk of stream) {
    const buffer = pending + decoder.decode(chunk, { stream: true });
    const lastNewline = buffer.lastIndexOf("\n");
    if (lastNewline === -1) {
      pending = buffer;
      continue;
    }
    for (const line of splitLines(buffer.slice(0, lastNewline))) {
      yield JSON.parse(line) as T;
    }
    pending = buffer.slice(lastNewline + 1);
  }

  const trailing = pending.trim();
  if (trailing.length > 0) {
    yield JSON.parse(trailing) as T;
  }
}

function sanitizeRawNewlines(
  raw: string,
  index: number,
  onWarning?: (message: string) => void,
): string {
  const firstOffset = raw.search(RAW_NEWLINE_PATTERN);
  onWarning?.(
    `Request #${index} had a raw \\n or \\r in its serialized JSON (offset ${firstOffset}); escaping before sending.`,
  );
  return raw.replace(RAW_NEWLINE_PATTERN, (char) =>
    char === "\n" ? "\\n" : "\\r",
  );
}

function* splitLines(block: string): Generator<string> {
  let start = 0;
  while (start <= block.length) {
    const newlineIndex = block.indexOf("\n", start);
    const end = newlineIndex === -1 ? block.length : newlineIndex;
    const line = block.slice(start, end).trim();
    if (line.length > 0) {
      yield line;
    }
    if (newlineIndex === -1) {
      return;
    }
    start = newlineIndex + 1;
  }
}
