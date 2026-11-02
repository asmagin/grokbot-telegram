import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { fatalConfigProblems, loadConfig } from "../../core/config.js";
import { buildDeps, type AppDeps } from "../../core/deps.js";
import { handleRequest } from "../../core/handler.js";
import { routeBodyLimit } from "../../core/http.js";

export class BodyTooLargeError extends Error {
  constructor() {
    super("body_too_large");
    this.name = "BodyTooLargeError";
  }
}

/** Node does not cap request bodies, so stop buffering once `maxBytes` is passed. */
export async function nodeRequestToWeb(req: IncomingMessage, maxBytes = 1_000_000): Promise<Request> {
  const host = req.headers.host ?? "127.0.0.1";
  const url = `http://${host}${req.url ?? "/"}`;
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  const declared = Number(req.headers["content-length"] ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBytes) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  return new Request(url, { method, headers, body });
}

export async function writeNodeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const payload = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, headers);
  res.end(payload);
}

export interface NodeServer {
  port: number;
  url: string;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export async function startNodeServer(options: {
  env: Record<string, string | undefined>;
  port?: number;
  host?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  deps?: AppDeps;
  typingMode?: "interval" | "once";
}): Promise<NodeServer> {
  const pending = new Set<Promise<unknown>>();
  const deps = options.deps ?? buildDeps({
    env: options.env,
    typingMode: options.typingMode ?? "interval",
    fetchImpl: options.fetchImpl,
    now: options.now,
    waitUntil(promise) {
      pending.add(promise);
      promise.finally(() => pending.delete(promise)).catch(() => undefined);
    },
  });
  const server = createServer(async (req, res) => {
    try {
      const request = await nodeRequestToWeb(req, routeBodyLimit(req.url ?? "/", deps.config));
      const response = await handleRequest(request, deps);
      await writeNodeResponse(res, response);
    } catch (err) {
      if (err instanceof BodyTooLargeError && !res.headersSent) {
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ ok: false, error: "body_too_large" }));
        req.destroy();
        return;
      }
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "internal_error" }));
      } else {
        res.end();
      }
    }
  });
  // Slow-body clients should not hold sockets open for Node's 300 s default.
  // Long enough for a proxied Telegram file (up to 20 MiB) and still well under Node's 300 s default.
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    url: `http://${host}:${port}`,
    async drain() {
      const current = [...pending];
      await Promise.allSettled(current);
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

const entry = process.argv[1] ?? "";
const isMain = entry.length > 0 && (
  import.meta.url === pathToFileURL(entry).href
  || entry.endsWith("/server.ts")
  || entry.endsWith("/server.js")
  || entry.endsWith("\\server.ts")
  || entry.endsWith("\\server.js")
);
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  const config = loadConfig(process.env);
  const fatal = fatalConfigProblems(config);
  if (config.problems.length > 0) {
    console.error(JSON.stringify({ event: "config_problems", settings: config.problems }));
  }
  if (fatal.length > 0) {
    // Fail closed: without a valid webhook secret anyone could post fake updates.
    console.error(JSON.stringify({ event: "refusing_to_start", missing_or_invalid: fatal }));
    process.exit(1);
  }
  startNodeServer({ env: process.env, port, host: "0.0.0.0" }).then((server) => {
    console.log(JSON.stringify({ event: "listen", port: server.port }));
    // Let in-flight forwards finish before the platform kills the process.
    const shutdown = (signal: string) => {
      console.log(JSON.stringify({ event: "shutdown", signal }));
      const deadline = new Promise((resolve) => setTimeout(resolve, 20_000).unref());
      void Promise.race([Promise.all([server.close().catch(() => undefined), server.drain()]), deadline])
        .finally(() => process.exit(0));
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  }).catch((err: unknown) => {
    console.error(JSON.stringify({ event: "listen_failed", error: err instanceof Error ? err.name : "error" }));
    process.exitCode = 1;
  });
}
