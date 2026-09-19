import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") {
    throw new HttpError(415, "Compressed request bodies are not supported");
  }
  const limit = 4096;
  const chunks: Buffer[] = [];
  let size = 0;
  // destroyOnReturn:false lets the route send 413 before closing the connection.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, "JSON body exceeds 4096 bytes");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}