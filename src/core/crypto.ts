import { ATTACHMENT_KINDS, type AttachmentKind, type FileClaims, type ReplyClaims } from "./types.js";

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    diff |= l ^ r;
  }
  return diff === 0;
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

async function hmacSha256(secret: string, data: string | Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const sig = await crypto.subtle.sign("HMAC", key, bytes);
  return new Uint8Array(sig);
}

/**
 * Telegram allows 64 bytes of callback_data. Base64url of 48 bytes is exactly
 * 64 characters, so the signed blob cannot be larger than that. 16 bytes of
 * the HMAC (128 bits) plus a version and expiry leave 27 bytes for the action.
 */
export const CALLBACK_MAC_BYTES = 16;
export const CALLBACK_TOKEN_OVERHEAD = 1 + 4 + CALLBACK_MAC_BYTES;
export const CALLBACK_TOKEN_MAX_BYTES = 48;
export const CALLBACK_DATA_MAX_BYTES = CALLBACK_TOKEN_MAX_BYTES - CALLBACK_TOKEN_OVERHEAD;

const CALLBACK_DOMAIN = new TextEncoder().encode("cb1");

export type CallbackVersion = 1 | 2;

export type CallbackVerifyResult =
  | { ok: true; version: CallbackVersion; data: string; exp: number }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Sign button data so a tap is bound to one chat and, for version 1, one user.
 * Version 2 is bound to the chat only (operator sends, which have no wake user).
 * The user id and chat id are MAC inputs, not stored in the token: a tap from
 * another chat or person fails verification on any instance, with no store lookup.
 * Returns null when the data does not fit Telegram's callback_data limit.
 */
export async function signCallbackData(
  secret: string,
  input: { version: CallbackVersion; chatId: string; userId: string; exp: number; data: string },
): Promise<string | null> {
  if (!secret) return null;
  if (!Number.isSafeInteger(input.exp) || input.exp < 0 || input.exp > 0xffffffff) return null;
  const data = new TextEncoder().encode(input.data);
  if (data.length < 1 || data.length > CALLBACK_DATA_MAX_BYTES) return null;
  const boundUser = input.version === 1 ? input.userId : "";
  if (input.version === 1 && boundUser.length === 0) return null;
  const mac = await callbackMac(secret, input.version, input.chatId, boundUser, input.exp, data);
  if (!mac) return null;
  const token = new Uint8Array(CALLBACK_TOKEN_OVERHEAD + data.length);
  token[0] = input.version;
  writeUint32(token, 1, input.exp);
  token.set(mac, 5);
  token.set(data, CALLBACK_TOKEN_OVERHEAD);
  const encoded = bytesToBase64Url(token);
  if (encoded.length > 64) return null;
  return encoded;
}

export async function verifyCallbackData(
  secret: string,
  token: string,
  input: { chatId: string; userId: string; nowMs: number },
): Promise<CallbackVerifyResult> {
  if (!secret || token.length < 1 || token.length > 64) return { ok: false, reason: "malformed" };
  const raw = base64UrlToBytes(token);
  if (!raw || raw.length < CALLBACK_TOKEN_OVERHEAD + 1 || raw.length > CALLBACK_TOKEN_MAX_BYTES) {
    return { ok: false, reason: "malformed" };
  }
  const version = raw[0];
  if (version !== 1 && version !== 2) return { ok: false, reason: "malformed" };
  const exp = readUint32(raw, 1);
  const presented = raw.slice(5, 5 + CALLBACK_MAC_BYTES);
  const data = raw.slice(CALLBACK_TOKEN_OVERHEAD);
  if (input.nowMs >= exp * 1000) return { ok: false, reason: "expired" };
  const boundUser = version === 1 ? input.userId : "";
  const expected = await callbackMac(secret, version, input.chatId, boundUser, exp, data);
  if (!expected || !timingSafeEqual(expected, presented)) return { ok: false, reason: "bad_signature" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!text) return { ok: false, reason: "malformed" };
  return { ok: true, version, data: text, exp };
}

async function callbackMac(
  secret: string,
  version: CallbackVersion,
  chatId: string,
  userId: string,
  exp: number,
  data: Uint8Array,
): Promise<Uint8Array | null> {
  const chat = new TextEncoder().encode(chatId);
  const user = new TextEncoder().encode(userId);
  if (chat.length < 1 || chat.length > 32 || user.length > 32) return null;
  const message = new Uint8Array(CALLBACK_DOMAIN.length + 1 + 1 + chat.length + 1 + user.length + 4 + data.length);
  let offset = 0;
  message.set(CALLBACK_DOMAIN, offset);
  offset += CALLBACK_DOMAIN.length;
  message[offset] = version;
  offset += 1;
  message[offset] = chat.length;
  offset += 1;
  message.set(chat, offset);
  offset += chat.length;
  message[offset] = user.length;
  offset += 1;
  message.set(user, offset);
  offset += user.length;
  writeUint32(message, offset, exp);
  offset += 4;
  message.set(data, offset);
  const sig = await hmacSha256(secret, message);
  return sig.slice(0, CALLBACK_MAC_BYTES);
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000)
    + ((bytes[offset + 1] ?? 0) * 0x10000)
    + ((bytes[offset + 2] ?? 0) * 0x100)
    + (bytes[offset + 3] ?? 0)
  );
}

/** Compare two strings without leaking the expected value through early length mismatches. */
export async function secretsEqual(expected: string, provided: string): Promise<boolean> {
  if (!expected || !provided) return false;
  const [left, right] = await Promise.all([sha256(expected), sha256(provided)]);
  return timingSafeEqual(left, right);
}

export async function signReplyToken(secret: string, claims: ReplyClaims): Promise<string> {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = bytesToBase64Url(await hmacSha256(secret, `v1.${payload}`));
  return `v1.${payload}.${sig}`;
}

export type VerifyResult =
  | { ok: true; claims: ReplyClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export async function verifyReplyToken(secret: string, token: string, nowMs: number): Promise<VerifyResult> {
  if (!secret) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) {
    return { ok: false, reason: "malformed" };
  }
  const payload = parts[1];
  // Compare the canonical encoding, so a signature with different unused low
  // bits in its last character (same decoded bytes) is not a second valid token.
  const expected = new TextEncoder().encode(bytesToBase64Url(await hmacSha256(secret, `v1.${payload}`)));
  const presented = new TextEncoder().encode(parts[2]);
  if (!timingSafeEqual(expected, presented)) {
    return { ok: false, reason: "bad_signature" };
  }
  const raw = base64UrlToBytes(payload);
  if (!raw) return { ok: false, reason: "malformed" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isReplyClaims(parsed)) return { ok: false, reason: "malformed" };
  if (nowMs >= parsed.exp * 1000) return { ok: false, reason: "expired" };
  return { ok: true, claims: parsed };
}

const FILE_TOKEN_PREFIX = "f1";
/** Separator is `~` so the token is one URL path segment with no dots. */
const FILE_TOKEN_SEP = "~";
const MAX_FILE_TOKEN_LENGTH = 4096;

export async function signFileToken(secret: string, claims: FileClaims): Promise<string> {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signed = `${FILE_TOKEN_PREFIX}${FILE_TOKEN_SEP}${payload}`;
  const sig = bytesToBase64Url(await hmacSha256(secret, signed));
  return `${signed}${FILE_TOKEN_SEP}${sig}`;
}

export async function verifyFileToken(secret: string, token: string, nowMs: number): Promise<
  | { ok: true; claims: FileClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" }
> {
  if (!secret || token.length > MAX_FILE_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const parts = token.split(FILE_TOKEN_SEP);
  if (parts.length !== 3 || parts[0] !== FILE_TOKEN_PREFIX || !parts[1] || !parts[2]) {
    return { ok: false, reason: "malformed" };
  }
  const payload = parts[1];
  const expected = new TextEncoder().encode(
    bytesToBase64Url(await hmacSha256(secret, `${FILE_TOKEN_PREFIX}${FILE_TOKEN_SEP}${payload}`)),
  );
  const presented = new TextEncoder().encode(parts[2]);
  if (!timingSafeEqual(expected, presented)) return { ok: false, reason: "bad_signature" };
  const raw = base64UrlToBytes(payload);
  if (!raw) return { ok: false, reason: "malformed" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isFileClaims(parsed)) return { ok: false, reason: "malformed" };
  if (nowMs >= parsed.exp * 1000) return { ok: false, reason: "expired" };
  return { ok: true, claims: parsed };
}

export function replyTokenScopeOk(
  claims: ReplyClaims,
  chatId: string,
  threadId: number | null,
): boolean {
  if (claims.chat_id !== chatId) return false;
  const claimed = claims.thread_id ?? null;
  const requested = threadId ?? null;
  return claimed === requested;
}

function isAttachmentKind(value: unknown): value is AttachmentKind {
  return typeof value === "string" && (ATTACHMENT_KINDS as readonly string[]).includes(value);
}

function isFileClaims(value: unknown): value is FileClaims {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    typeof record.chat_id === "string" &&
    /^-?\d+$/.test(record.chat_id) &&
    (record.thread_id === null || (typeof record.thread_id === "number" && Number.isSafeInteger(record.thread_id))) &&
    typeof record.wake_id === "string" &&
    record.wake_id.length > 0 &&
    record.wake_id.length <= 80 &&
    typeof record.exp === "number" &&
    Number.isFinite(record.exp) &&
    typeof record.file_id === "string" &&
    isPlausibleFileId(record.file_id) &&
    isAttachmentKind(record.kind) &&
    (record.mime === null || (typeof record.mime === "string" && record.mime.length <= 127)) &&
    (record.name === null || (typeof record.name === "string" && record.name.length <= 255))
  );
}

/** Telegram file_id alphabet. Reject anything that could change a URL or a header. */
export function isPlausibleFileId(value: string): boolean {
  return value.length >= 1 && value.length <= 512 && /^[A-Za-z0-9_-]+$/.test(value);
}

function isReplyClaims(value: unknown): value is ReplyClaims {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    typeof record.chat_id === "string" &&
    /^-?\d+$/.test(record.chat_id) &&
    (record.thread_id === null || (typeof record.thread_id === "number" && Number.isSafeInteger(record.thread_id))) &&
    typeof record.wake_id === "string" &&
    record.wake_id.length > 0 &&
    record.wake_id.length <= 80 &&
    typeof record.exp === "number" &&
    Number.isFinite(record.exp) &&
    (record.user_id === undefined || (typeof record.user_id === "string" && isBoundedId(record.user_id)))
  );
}

function isBoundedId(value: string): boolean {
  return value.length >= 1 && value.length <= 32 && /^-?\d+$/.test(value);
}
