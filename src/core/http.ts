export function json(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

export async function readLimitedBytes(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; response: Response }> {
  const declared = request.headers.get("content-length");
  if (declared) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      return { ok: false, response: json(413, { ok: false, error: "body_too_large" }) };
    }
  }
  // Content-Length can be absent (chunked) or wrong, so count while streaming
  // and stop reading as soon as the cap is passed.
  const tooLarge = { ok: false as const, response: json(413, { ok: false, error: "body_too_large" }) };
  if (!request.body) return { ok: true, bytes: new Uint8Array() };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return tooLarge;
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: buffer };
}

export async function readLimitedBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const read = await readLimitedBytes(request, maxBytes);
  if (!read.ok) return read;
  return { ok: true, text: new TextDecoder().decode(read.bytes) };
}

/** `/send/media` may carry a small upload. Every other route keeps the JSON cap. */
export function routeBodyLimit(
  rawUrl: string,
  config: { maxBodyBytes: number; maxMediaBytes: number; pathPrefix: string },
): number {
  const pathOnly = rawUrl.split("?")[0] ?? "/";
  const route = routePath(new URL(pathOnly, "http://localhost"), config.pathPrefix);
  if (route === "/send/media") return Math.max(config.maxBodyBytes, config.maxMediaBytes);
  return config.maxBodyBytes;
}

/**
 * Error codes that mean the request never reached the server: name lookup,
 * connect, or the TLS handshake failed before any body was written.
 */
const NEVER_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * True when a failed fetch may still have been received: a timeout, a reset,
 * or anything we cannot prove happened before the request went out.
 */
export function mayHaveBeenReceived(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && NEVER_SENT_CODES.has(code)) return false;
    current = (current as { cause?: unknown }).cause;
  }
  return true;
}

export function routePath(url: URL, prefix: string): string {
  let path = url.pathname || "/";
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (!prefix) return path;
  if (path === prefix) return "/";
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  return path;
}
