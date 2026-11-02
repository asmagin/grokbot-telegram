import { verifyFileToken } from "./crypto.js";
import type { AppDeps } from "./deps.js";
import { json } from "./http.js";
import { contentDisposition, downloadContentType } from "./media.js";
import { authenticate } from "./outbound.js";
import { TELEGRAM_GET_FILE_MAX_BYTES } from "./types.js";

/**
 * Stream a Telegram file to the holder of this wake's reply token.
 * The file URL alone is not enough: the bearer token must be the same wake,
 * chat, and topic the file was signed for. The bot token never leaves the bridge.
 */
export async function handleGetFile(request: Request, deps: AppDeps, token: string): Promise<Response> {
  const credential = await authenticate(request, deps);
  if (!credential.ok) return credential.response;
  if (credential.kind !== "token") {
    return json(403, { ok: false, error: "reply_token_required" });
  }
  if (!deps.config.replyTokenSecret) return json(401, { ok: false, error: "unauthorized" });

  const verified = await verifyFileToken(deps.config.replyTokenSecret, token, deps.now());
  if (!verified.ok) return json(401, { ok: false, error: verified.reason });
  const file = verified.claims;
  const claims = credential.claims;
  if (claims.chat_id !== file.chat_id || (claims.thread_id ?? null) !== (file.thread_id ?? null) || claims.wake_id !== file.wake_id) {
    return json(403, { ok: false, error: "scope" });
  }

  const info = await deps.telegram.getFile(file.file_id);
  if (!info.ok) {
    if (info.tooLarge) {
      return json(413, { ok: false, error: "file_too_large", limit: TELEGRAM_GET_FILE_MAX_BYTES });
    }
    deps.log({
      event: "file_fetch_failed",
      chat_id: file.chat_id,
      status: info.status,
      error: info.description === "bad_file_path" ? "bad_file_path" : "get_file",
    });
    return json(502, { ok: false, error: "telegram_file_failed" });
  }

  const downloaded = await deps.telegram.downloadFile(info.filePath);
  if (!downloaded.ok) {
    if (downloaded.tooLarge) {
      return json(413, { ok: false, error: "file_too_large", limit: TELEGRAM_GET_FILE_MAX_BYTES });
    }
    deps.log({
      event: "file_fetch_failed",
      chat_id: file.chat_id,
      status: downloaded.status,
      error: downloaded.description === "bad_file_path" || downloaded.description === "telegram_redirect"
        ? downloaded.description
        : "download",
    });
    return json(502, { ok: false, error: "telegram_file_failed" });
  }

  const headers = new Headers({
    "content-type": downloadContentType(file.kind, file.mime),
    "content-disposition": contentDisposition(file.kind, file.name),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });

  // Known length streams straight through. Unknown length is buffered up to the
  // getFile cap so an oversized body is a 413 instead of a truncated 200.
  if (downloaded.contentLength === null) {
    const buffered = await readStreamLimited(downloaded.body, TELEGRAM_GET_FILE_MAX_BYTES);
    if (!buffered.ok) {
      return json(413, { ok: false, error: "file_too_large", limit: TELEGRAM_GET_FILE_MAX_BYTES });
    }
    headers.set("content-length", String(buffered.bytes.byteLength));
    deps.log({ event: "file_fetch", chat_id: file.chat_id, kind: file.kind, bytes: buffered.bytes.byteLength });
    return new Response(buffered.bytes, { status: 200, headers });
  }

  headers.set("content-length", String(downloaded.contentLength));
  deps.log({ event: "file_fetch", chat_id: file.chat_id, kind: file.kind, bytes: downloaded.contentLength });
  return new Response(downloaded.body, { status: 200, headers });
}

async function readStreamLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
