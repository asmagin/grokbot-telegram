import { transcriptAddressesBot } from "./address.js";
import type { SpeechConfig } from "./config.js";
import type { Logger } from "./log.js";
import { listSpeechFiles, type SpeechFile } from "./media.js";
import { cleanText } from "./text.js";
import type { TelegramClient } from "./telegram.js";
import {
  TELEGRAM_GET_FILE_MAX_BYTES,
  type TelegramMessage,
  type TranscriptError,
  type TranscriptFields,
} from "./types.js";

/**
 * xAI speech-to-text. One HTTPS multipart POST, no SDK and no local decode,
 * so it fits a Vercel function. The response includes `text` and `language`.
 * OGG, MP3, MP4, M4A, WAV, and WebM cover Telegram voice (OGG/Opus), common
 * audio, and video notes (MP4).
 */
export const XAI_STT_URL = "https://api.x.ai/v1/stt";
export const XAI_TRANSCRIBE_MODEL = "grok-voice-transcribe-2.0";

/** Wall clock for every speech file on one update. Leaves room inside the 60s function. */
export const SPEECH_BUDGET_MS = 35_000;
const DOWNLOAD_TIMEOUT_MS = 12_000;
const PROVIDER_TIMEOUT_MS = 15_000;

const NONE: TranscriptFields = { transcript: null, transcript_language: null, transcript_error: null };

/**
 * Transcribe when the message will wake the bot, and also when a group voice
 * note or video note might be addressed only by a spoken username. Audio is
 * not used for that check: it can carry an @mention in its caption.
 */
export function shouldTranscribe(message: TelegramMessage, addressed: boolean, username: string): boolean {
  const files = listSpeechFiles(message);
  if (files.length === 0) return false;
  if (addressed) return true;
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) return false;
  return files.some((file) => file.kind === "voice" || file.kind === "video_note");
}

export async function transcribeMessage(options: {
  message: TelegramMessage;
  speech: SpeechConfig;
  telegram: TelegramClient;
  fetchImpl: typeof fetch;
  log: Logger;
  chatId: string;
  username: string;
  now?: () => number;
}): Promise<{ byFileId: Map<string, TranscriptFields>; mentioned: boolean }> {
  const now = options.now ?? Date.now;
  const files = listSpeechFiles(options.message);
  const byFileId = new Map<string, TranscriptFields>();
  const deadline = now() + SPEECH_BUDGET_MS;
  for (const file of files) {
    const fields = now() >= deadline
      ? failure("timeout")
      : await transcribeOne(file, options, deadline, now).catch(() => failure("provider_error"));
    byFileId.set(file.fileId, fields);
    options.log({
      event: "transcribe",
      chat_id: options.chatId,
      kind: file.kind,
      reason: fields.transcript_error,
      bytes: file.fileSize,
      duration: file.duration,
    });
  }
  const mentioned = files.some((file) => {
    if (file.kind !== "voice" && file.kind !== "video_note") return false;
    const text = byFileId.get(file.fileId)?.transcript;
    return Boolean(text && transcriptAddressesBot(text, options.username));
  });
  return { byFileId, mentioned };
}

function failure(error: TranscriptError): TranscriptFields {
  return { transcript: null, transcript_language: null, transcript_error: error };
}

async function transcribeOne(
  file: SpeechFile,
  options: {
    speech: SpeechConfig;
    telegram: TelegramClient;
    fetchImpl: typeof fetch;
  },
  deadline: number,
  now: () => number,
): Promise<TranscriptFields> {
  if (file.fileSize !== null && file.fileSize > TELEGRAM_GET_FILE_MAX_BYTES) return failure("unavailable");
  if (file.fileSize !== null && file.fileSize > options.speech.maxBytes) return failure("too_large");
  if (file.duration !== null && file.duration > options.speech.maxSeconds) return failure("too_long");
  const format = speechFormat(file);
  if (!format) return failure("unsupported");
  if (now() >= deadline) return failure("timeout");

  const downloaded = await downloadSpeech(options.telegram, file.fileId, options.speech.maxBytes);
  if (!downloaded.ok) return failure(downloaded.error);
  if (now() >= deadline) return failure("timeout");

  const provider = await callXaiStt(options.fetchImpl, options.speech.apiKey, downloaded.bytes, format);
  if (!provider.ok) return failure(provider.error);
  const transcript = cleanText(provider.text).trim();
  if (!transcript) return failure("empty");
  return { ...NONE, transcript, transcript_language: provider.language };
}

async function downloadSpeech(
  telegram: TelegramClient,
  fileId: string,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: TranscriptError }> {
  const info = await telegram.getFile(fileId);
  if (!info.ok) return { ok: false, error: info.tooLarge ? "too_large" : "fetch_failed" };
  if (info.fileSize !== null && info.fileSize > maxBytes) return { ok: false, error: "too_large" };
  const downloaded = await telegram.downloadFile(info.filePath, DOWNLOAD_TIMEOUT_MS);
  if (!downloaded.ok) {
    if (downloaded.tooLarge) return { ok: false, error: "too_large" };
    if (downloaded.timeout) return { ok: false, error: "timeout" };
    return { ok: false, error: "fetch_failed" };
  }
  if (downloaded.contentLength !== null && downloaded.contentLength > maxBytes) {
    await downloaded.body.cancel().catch(() => undefined);
    return { ok: false, error: "too_large" };
  }
  try {
    const buffered = await readStreamLimited(downloaded.body, maxBytes);
    if (!buffered.ok) return { ok: false, error: "too_large" };
    if (buffered.bytes.byteLength === 0) return { ok: false, error: "empty" };
    return { ok: true, bytes: buffered.bytes };
  } catch {
    return { ok: false, error: "fetch_failed" };
  }
}

async function callXaiStt(
  fetchImpl: typeof fetch,
  apiKey: string,
  bytes: Uint8Array,
  format: { filename: string; mime: string },
): Promise<{ ok: true; text: string; language: string | null } | { ok: false; error: TranscriptError }> {
  const form = new FormData();
  // xAI requires the file field last in the multipart body.
  form.set("model", XAI_TRANSCRIBE_MODEL);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  form.set("file", new File([copy], format.filename, { type: format.mime }));
  let response: Response;
  try {
    response = await fetchImpl(XAI_STT_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      redirect: "manual",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { ok: false, error: timeout ? "timeout" : "provider_error" };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, error: "provider_error" };
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, error: "provider_error" };
  const parsed = parseProviderBody(data);
  if (!parsed) return { ok: false, error: "provider_error" };
  return { ok: true, text: parsed.text, language: parsed.language };
}

function parseProviderBody(data: unknown): { text: string; language: string | null } | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.text !== "string") return null;
  return { text: record.text, language: languageOf(record) };
}

function languageOf(record: Record<string, unknown>): string | null {
  if (typeof record.language === "string") return cleanLanguage(record.language);
  const languages = record.languages;
  if (Array.isArray(languages)) {
    for (const item of languages) {
      const raw = typeof item === "string"
        ? item
        : item && typeof item === "object" && typeof (item as { code?: unknown }).code === "string"
          ? (item as { code: string }).code
          : null;
      const code = raw ? cleanLanguage(raw) : null;
      if (code) return code;
    }
  }
  return null;
}

/** BCP-47 / ISO 639 code (`en`, `es-mx`) or a language name (`english`). */
function cleanLanguage(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(value)) return null;
  return value;
}

const FORMATS: Record<string, { mime: string; ext: string }> = {
  "audio/ogg": { mime: "audio/ogg", ext: "ogg" },
  "audio/opus": { mime: "audio/ogg", ext: "ogg" },
  "application/ogg": { mime: "audio/ogg", ext: "ogg" },
  "audio/mpeg": { mime: "audio/mpeg", ext: "mp3" },
  "audio/mp3": { mime: "audio/mpeg", ext: "mp3" },
  "audio/mp4": { mime: "audio/mp4", ext: "m4a" },
  "audio/m4a": { mime: "audio/mp4", ext: "m4a" },
  "audio/x-m4a": { mime: "audio/mp4", ext: "m4a" },
  "audio/wav": { mime: "audio/wav", ext: "wav" },
  "audio/x-wav": { mime: "audio/wav", ext: "wav" },
  "audio/wave": { mime: "audio/wav", ext: "wav" },
  "audio/webm": { mime: "audio/webm", ext: "webm" },
  "audio/flac": { mime: "audio/flac", ext: "flac" },
  "video/mp4": { mime: "video/mp4", ext: "mp4" },
  "video/webm": { mime: "video/webm", ext: "webm" },
  "video/mpeg": { mime: "video/mpeg", ext: "mpeg" },
};

/**
 * Fixed filename. The person's file name is untrusted and is not forwarded
 * to the provider. The extension is what the provider uses to detect the format.
 */
function speechFormat(file: SpeechFile): { filename: string; mime: string } | null {
  const mime = file.mime?.split(";")[0]?.trim().toLowerCase() ?? "";
  const known = FORMATS[mime] ?? formatFromName(file.fileName);
  if (!known) return null;
  const base = file.kind === "voice" ? "voice" : file.kind === "video_note" ? "note" : "audio";
  return { filename: `${base}.${known.ext}`, mime: known.mime };
}

function formatFromName(fileName: string | null): { mime: string; ext: string } | null {
  const ext = fileName?.toLowerCase().split(".").pop() ?? "";
  if (ext === "ogg" || ext === "opus") return FORMATS["audio/ogg"] ?? null;
  if (ext === "mp3") return FORMATS["audio/mpeg"] ?? null;
  if (ext === "m4a") return FORMATS["audio/mp4"] ?? null;
  if (ext === "mp4") return FORMATS["video/mp4"] ?? null;
  if (ext === "wav") return FORMATS["audio/wav"] ?? null;
  if (ext === "webm") return FORMATS["audio/webm"] ?? null;
  if (ext === "flac") return FORMATS["audio/flac"] ?? null;
  return null;
}

async function readStreamLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
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
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The lock is already gone after a cancel on some runtimes.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
