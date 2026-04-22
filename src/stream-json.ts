import { createReadStream } from "node:fs";
import { JSONParser } from "@streamparser/json-node";

type ParsedElement<T> = { value: T };

export async function* streamJsonElements<T>(
  filePath: string,
  jsonPath: string,
): AsyncGenerator<T> {
  const parser = new JSONParser({ paths: [jsonPath], keepStack: false });
  const fileStream = createReadStream(filePath);
  fileStream.pipe(parser);
  try {
    for await (const chunk of parser) {
      yield (chunk as ParsedElement<T>).value;
    }
  } finally {
    fileStream.unpipe(parser);
    fileStream.destroy();
    parser.destroy();
  }
}
