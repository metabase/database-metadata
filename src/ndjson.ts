export type PostNdjsonOptions<Req, Res> = {
  url: string;
  apiKey: string;
  requests: AsyncIterable<Req>;
  onResponse: (response: Res, index: number) => void | Promise<void>;
  onWarning?: (message: string) => void;
};

// Node's fetch RequestInit does not type `duplex` in lib.dom, but it is required
// when sending a streaming body.
type StreamingRequestInit = RequestInit & { duplex: "half" };

// The server (Clojure line-seq) splits requests on raw \n, \r, or \r\n. If any
// of those bytes escape into a serialized line, it gets cut mid-object and
// returns a malformed-json error against the tail fragment. `JSON.stringify`
// escapes control chars in strings, so a positive hit here means a value's
// toJSON() produced raw control chars — we sanitize defensively and warn so
// the user can chase the upstream bug.
const RAW_NEWLINE_PATTERN = /[\n\r]/g;

export async function postNdjson<Req, Res>({
  url,
  apiKey,
  requests,
  onResponse,
  onWarning,
}: PostNdjsonOptions<Req, Res>): Promise<void> {
  const iterator = requests[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let sentIndex = 0;

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
          return;
        }
        const raw = JSON.stringify(value);
        const safe = raw.includes("\n") || raw.includes("\r")
          ? sanitizeRawNewlines(raw, sentIndex, onWarning)
          : raw;
        sentIndex += 1;
        controller.enqueue(encoder.encode(safe + "\n"));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (typeof iterator.return === "function") {
        await iterator.return(reason);
      }
    },
  });

  const init: StreamingRequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-ndjson",
      "X-API-Key": apiKey,
    },
    body,
    duplex: "half",
  };
  const response = await fetch(url, init);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `POST ${url} failed: ${response.status} ${response.statusText} ${text}`.trim(),
    );
  }
  if (!response.body) {
    throw new Error(`POST ${url} returned an empty body`);
  }

  let index = 0;
  for await (const parsed of parseNdjsonStream<Res>(response.body)) {
    await onResponse(parsed, index);
    index += 1;
  }
}

export async function* parseNdjsonStream<T>(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  // Slice once per chunk (not per line) to keep parsing O(n) on large responses.
  let pending = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        const chunk = pending + decoder.decode(value, { stream: true });
        const lastNewline = chunk.lastIndexOf("\n");
        if (lastNewline === -1) {
          pending = chunk;
        } else {
          for (const line of splitLines(chunk.slice(0, lastNewline))) {
            yield JSON.parse(line) as T;
          }
          pending = chunk.slice(lastNewline + 1);
        }
      }
      if (done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
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
