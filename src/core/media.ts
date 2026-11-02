import { signFileToken } from "./crypto.js";
import { joinUrl, cleanText } from "./text.js";
import {
  TELEGRAM_GET_FILE_MAX_BYTES,
  type AttachmentKind,
  type FileClaims,
  type TelegramMessage,
  type WakeAttachment,
} from "./types.js";

const MIME = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,40}\/[A-Za-z0-9][A-Za-z0-9.+_-]{0,80}$/;

/** Types we will put on the streamed response. Anything else becomes octet-stream. */
const DOWNLOAD_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "audio/mpeg",
  "audio/ogg",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/json",
  "application/octet-stream",
  "text/plain",
]);

interface ParsedFile {
  file_id: string;
  file_size: number | null;
  file_name: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  is_animated: boolean;
  is_video: boolean;
}

function asInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function asMime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const mime = value.trim().toLowerCase();
  if (!MIME.test(mime) || mime.length > 127) return null;
  return mime;
}

/** Single-line file name with any directory prefix removed. */
export function cleanFileName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const single = cleanText(raw, 255).replace(/[\r\n\t]+/g, " ").trim();
  if (!single) return null;
  const base = single.split(/[/\\]/).filter(Boolean).pop()?.trim() ?? "";
  const safe = base.replace(/["\\]/g, "").trim();
  if (!safe || safe === "." || safe === "..") return null;
  return safe.slice(0, 255);
}

function parseFile(raw: unknown): ParsedFile | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const fileId = record.file_id;
  if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(fileId)) return null;
  return {
    file_id: fileId,
    file_size: asInt(record.file_size),
    file_name: cleanFileName(typeof record.file_name === "string" ? record.file_name : null),
    mime_type: asMime(record.mime_type),
    width: asInt(record.width),
    height: asInt(record.height),
    duration: asInt(record.duration),
    is_animated: record.is_animated === true,
    is_video: record.is_video === true,
  };
}

/**
 * Telegram lists photo sizes smallest-first, but that is not a guarantee.
 * Prefer the greatest file_size, then the greatest pixel area, then the last item.
 */
export function largestPhoto(raw: unknown): ParsedFile | null {
  if (!Array.isArray(raw)) return null;
  let best: { file: ParsedFile; size: number; area: number; index: number } | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const file = parseFile(raw[index]);
    if (!file) continue;
    const size = file.file_size ?? -1;
    const area = (file.width ?? 0) * (file.height ?? 0);
    if (
      !best
      || size > best.size
      || (size === best.size && area > best.area)
      || (size === best.size && area === best.area && index > best.index)
    ) {
      best = { file, size, area, index };
    }
  }
  return best?.file ?? null;
}

function defaultMime(kind: AttachmentKind, file: ParsedFile): string | null {
  if (file.mime_type) return file.mime_type;
  if (kind === "photo") return "image/jpeg";
  if (kind === "voice") return "audio/ogg";
  if (kind === "video_note") return "video/mp4";
  if (kind === "sticker") {
    if (file.is_video) return "video/webm";
    if (file.is_animated) return "application/gzip";
    return "image/webp";
  }
  return null;
}

function collect(message: TelegramMessage): { kind: AttachmentKind; file: ParsedFile }[] {
  const found: { kind: AttachmentKind; file: ParsedFile }[] = [];
  const photo = largestPhoto(message.photo);
  if (photo) found.push({ kind: "photo", file: photo });
  const singles: [AttachmentKind, unknown][] = [
    ["document", message.document],
    ["video", message.video],
    ["animation", message.animation],
    ["audio", message.audio],
    ["voice", message.voice],
    ["video_note", message.video_note],
    ["sticker", message.sticker],
  ];
  for (const [kind, raw] of singles) {
    const file = parseFile(raw);
    if (file) found.push({ kind, file });
  }
  return found;
}

export async function describeAttachments(
  message: TelegramMessage,
  options: {
    secret: string;
    publicBaseUrl: string;
    pathPrefix: string;
    chatId: string;
    threadId: number | null;
    wakeId: string;
    expSeconds: number;
  },
): Promise<WakeAttachment[]> {
  const attachments: WakeAttachment[] = [];
  for (const item of collect(message)) {
    const mime = defaultMime(item.kind, item.file);
    const name = item.kind === "photo" ? null : item.file.file_name;
    const tooLarge = item.file.file_size !== null && item.file.file_size > TELEGRAM_GET_FILE_MAX_BYTES;
    let fileUrl: string | null = null;
    if (!tooLarge) {
      const claims: FileClaims = {
        v: 1,
        chat_id: options.chatId,
        thread_id: options.threadId,
        wake_id: options.wakeId,
        file_id: item.file.file_id,
        exp: options.expSeconds,
        kind: item.kind,
        mime,
        name,
      };
      const token = await signFileToken(options.secret, claims);
      fileUrl = joinUrl(options.publicBaseUrl, options.pathPrefix, `/file/${token}`);
    }
    attachments.push({
      kind: item.kind,
      mime_type: mime,
      file_name: name,
      file_size: item.file.file_size,
      width: item.file.width,
      height: item.file.height,
      duration: item.file.duration,
      file_url: fileUrl,
      unavailable: tooLarge ? "too_large" : null,
    });
  }
  return attachments;
}

/**
 * https URL Telegram can fetch. The bridge does not fetch it.
 * Rejects credentials, IP literals, and localhost so a wake cannot aim this at
 * the bridge's own network or smuggle a bot token in an api.telegram.org URL.
 */
export function normalizePublicMediaUrl(raw: string): string | null {
  if (raw.length === 0 || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.hash) return null;
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return null;
  }
  if (host === "api.telegram.org") return null;
  if (host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\d+$/.test(host)) return null;
  return url.toString();
}

export function downloadContentType(kind: string, mime: string | null): string {
  if (mime && DOWNLOAD_TYPES.has(mime.toLowerCase())) return mime.toLowerCase();
  if (kind === "photo") return "image/jpeg";
  if (kind === "voice") return "audio/ogg";
  if (kind === "video" || kind === "video_note" || kind === "animation") return "video/mp4";
  if (kind === "sticker") return "image/webp";
  return "application/octet-stream";
}

export function contentDisposition(kind: string, fileName: string | null): string {
  const disposition = kind === "photo" ? "inline" : "attachment";
  const name = fileName && fileName.length > 0 ? fileName : (kind === "photo" ? "photo.jpg" : "file");
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "");
  const star = encodeURIComponent(name).replaceAll("'", "%27");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${star}`;
}

/** Relative Telegram file_path only. Never a URL, never `..`. */
export function isSafeTelegramFilePath(path: string): boolean {
  if (path.length < 1 || path.length > 512) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("..") || path.includes("//")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path);
}
