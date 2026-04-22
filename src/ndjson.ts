export type PostNdjsonOptions<Req, Res> = {
  url: string;
  apiKey: string;
  requests: AsyncIterable<Req>;
  onResponse: (response: Res, index: number) => void | Promise<void>;
  /** Max rows per HTTP request. Default 2000. */
  batchSize?: number;
};

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
  batchSize = DEFAULT_BATCH_SIZE,
}: PostNdjsonOptions<Req, Res>): Promise<void> {
  let globalIndex = 0;

  for await (const batch of batchAsyncIterable(requests, batchSize)) {
    const batchOffset = globalIndex;
    await postNdjsonBatch<Req, Res>({
      url,
      apiKey,
      batch,
      onResponse: (response, localIndex) =>
        onResponse(response, batchOffset + localIndex),
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
};

async function postNdjsonBatch<Req, Res>({
  url,
  apiKey,
  batch,
  onResponse,
}: PostBatchOptions<Req, Res>): Promise<void> {
  if (batch.length === 0) {
    return;
  }

  const body = new TextEncoder().encode(
    batch.map((value) => JSON.stringify(value)).join("\n") + "\n",
  );

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

export async function* parseNdjsonStream<T>(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  let pending = "";

  for await (const chunk of stream) {
    const buffer = pending + decoder.decode(chunk, { stream: true });
    const lastNewline = buffer.lastIndexOf("\n");
    if (lastNewline === -1) {
      pending = buffer;
      continue;
    }
    for (const line of buffer.slice(0, lastNewline).split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        yield JSON.parse(trimmed) as T;
      }
    }
    pending = buffer.slice(lastNewline + 1);
  }

  const trailing = pending.trim();
  if (trailing.length > 0) {
    yield JSON.parse(trailing) as T;
  }
}
