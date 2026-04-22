import { Buffer } from "node:buffer";
import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

export type PostNdjsonOptions<Req, Res> = {
  url: string;
  apiKey: string;
  requests: AsyncIterable<Req>;
  onResponse: (response: Res, index: number) => void | Promise<void>;
  onRequestSent?: (line: string, index: number) => void;
  onWarning?: (message: string) => void;
  /** Max rows per HTTP request. Default 1000. */
  batchSize?: number;
};

// The server (Clojure line-seq) splits requests on raw \n, \r, or \r\n. If any
// of those bytes escape into a serialized line, it gets cut mid-object and
// returns a malformed-json error against the tail fragment. `JSON.stringify`
// escapes control chars in strings, so a positive hit here means a value's
// toJSON() produced raw control chars — we sanitize defensively and warn so
// the user can chase the upstream bug.
const RAW_NEWLINE_PATTERN = /[\n\r]/g;

// Coalesce outgoing lines into larger socket writes to amortize syscall cost.
const CHUNK_FLUSH_BYTES = 65536;

// Cap the rows-per-HTTP-POST so each request stays within one server-side DB
// transaction. The Metabase server batches inserts in groups of 2000 per DB
// transaction; sending more than that in one POST forces multiple transactions
// in a single request, during which the server stops reading body bytes long
// enough for Jetty's idle timeout to fire and drop the tail with EofException.
// 1000 leaves a comfortable margin below that threshold.
const DEFAULT_BATCH_SIZE = 1000;

const DEFAULT_PORTS = { "http:": 80, "https:": 443 } as const;

const httpKeepAlive = new HttpAgent({ keepAlive: true });
const httpsKeepAlive = new HttpsAgent({ keepAlive: true });

export async function postNdjson<Req, Res>({
  url,
  apiKey,
  requests,
  onResponse,
  onRequestSent,
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
      onRequestSent: onRequestSent
        ? (line, localIndex) => onRequestSent(line, batchOffset + localIndex)
        : undefined,
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
  onRequestSent?: (line: string, index: number) => void;
  onWarning?: (message: string) => void;
};

async function postNdjsonBatch<Req, Res>({
  url,
  apiKey,
  batch,
  onResponse,
  onRequestSent,
  onWarning,
}: PostBatchOptions<Req, Res>): Promise<void> {
  if (batch.length === 0) {
    return;
  }

  const parsed = new URL(url);
  const makeRequest = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  const agent = parsed.protocol === "https:" ? httpsKeepAlive : httpKeepAlive;
  const port = parsed.port
    ? Number(parsed.port)
    : DEFAULT_PORTS[parsed.protocol as keyof typeof DEFAULT_PORTS];

  const req = makeRequest({
    method: "POST",
    hostname: parsed.hostname,
    port,
    path: (parsed.pathname || "/") + (parsed.search || ""),
    headers: {
      "Content-Type": "application/x-ndjson",
      "X-API-Key": apiKey,
    },
    agent,
  });

  const responsePromise = new Promise<IncomingMessage>((resolve, reject) => {
    req.once("response", resolve);
    req.once("error", reject);
  });

  const counters = { sent: 0 };
  const writePromise = writeBatch(
    req,
    batch,
    counters,
    onRequestSent,
    onWarning,
  );

  let response: IncomingMessage;
  try {
    response = await responsePromise;
  } catch (error) {
    await writePromise.catch(() => {});
    throw error;
  }

  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    const text = await readAllText(response);
    await writePromise.catch(() => {});
    req.destroy();
    throw new Error(
      `POST ${url} failed: ${status} ${response.statusMessage ?? ""} ${text}`.trim(),
    );
  }

  let received = 0;
  try {
    for await (const parsedLine of parseNdjsonStream<Res>(response)) {
      await onResponse(parsedLine, received);
      received += 1;
    }
  } catch (error) {
    response.destroy();
    req.destroy();
    throw error;
  }

  await writePromise;

  if (received < counters.sent) {
    throw new Error(
      `POST ${url}: server acknowledged ${received} of ${counters.sent} sent rows — ${counters.sent - received} rows dropped by the server (likely a per-row error terminated the stream)`,
    );
  }
}

async function writeBatch<Req>(
  req: ClientRequest,
  batch: Req[],
  counters: { sent: number },
  onRequestSent: ((line: string, index: number) => void) | undefined,
  onWarning: ((message: string) => void) | undefined,
): Promise<void> {
  const encoder = new TextEncoder();
  let pendingBuffer = "";

  try {
    for (const value of batch) {
      const raw = JSON.stringify(value);
      const safe =
        raw.includes("\n") || raw.includes("\r")
          ? sanitizeRawNewlines(raw, counters.sent, onWarning)
          : raw;
      onRequestSent?.(safe, counters.sent);
      counters.sent += 1;
      pendingBuffer += safe + "\n";
      if (pendingBuffer.length >= CHUNK_FLUSH_BYTES) {
        await writeWithBackpressure(req, encoder.encode(pendingBuffer));
        pendingBuffer = "";
      }
    }
    if (pendingBuffer.length > 0) {
      await writeWithCallback(req, encoder.encode(pendingBuffer));
      pendingBuffer = "";
    }
    await new Promise<void>((resolve, reject) => {
      req.once("finish", resolve);
      req.once("error", reject);
      req.end();
    });
  } catch (error) {
    req.destroy(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

async function writeWithBackpressure(
  req: ClientRequest,
  chunk: Uint8Array,
): Promise<void> {
  if (req.write(chunk)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      req.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      req.off("drain", onDrain);
      reject(error);
    };
    req.once("drain", onDrain);
    req.once("error", onError);
  });
}

async function writeWithCallback(
  req: ClientRequest,
  chunk: Uint8Array,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    req.write(chunk, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readAllText(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
  } catch {
    // Best-effort read; if the socket drops mid-response, return what we have.
  }
  return Buffer.concat(chunks).toString("utf8");
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
  const context = raw.slice(
    Math.max(0, firstOffset - 40),
    Math.min(raw.length, firstOffset + 40),
  );
  onWarning?.(
    `Request #${index} had a raw \\n or \\r in its serialized JSON (first at offset ${firstOffset}); sanitizing. Context: …${context}…`,
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
