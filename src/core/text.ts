import { TELEGRAM_TEXT_LIMIT } from "./types.js";

/** Cut at `max` UTF-16 units without leaving half of a surrogate pair. */
export function truncateText(text: string, max = 4000): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

// C0/C1 controls (keeping tab and newline), bidi marks/overrides/isolates,
// invisible separators (ZWSP, word joiner, invisible operators), BOM, and Unicode
// tag characters, which a model reads but a person cannot see. ZWJ/ZWNJ stay:
// emoji sequences and some scripts need them.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;

/** Untrusted Telegram text, made safe to embed and capped. */
export function cleanText(text: string, max = 4000): string {
  return truncateText(text.replace(/\r\n?/g, "\n").replace(UNSAFE_CHARS, ""), max);
}

/** Single-line untrusted label such as a name or chat title. */
export function cleanLabel(text: string | undefined, max = 64): string | null {
  if (text === undefined) return null;
  return cleanText(text.replace(/[\r\n\t]+/g, " "), max).trim();
}

/**
 * Split on paragraph boundaries, then line boundaries, then a hard cut.
 * Never returns a piece longer than `limit`.
 */
export function splitTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.length === 0) return [];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    let drop = 2;
    if (cut < Math.floor(limit * 0.5)) {
      cut = window.lastIndexOf("\n");
      drop = 1;
    }
    if (cut < Math.floor(limit * 0.5)) {
      cut = limit;
      drop = 0;
      // Do not split a surrogate pair (emoji and other astral characters).
      const before = rest.charCodeAt(cut - 1);
      if (before >= 0xd800 && before <= 0xdbff) cut -= 1;
    }
    const part = rest.slice(0, cut);
    if (part.length === 0) {
      parts.push(rest.slice(0, limit));
      rest = rest.slice(limit);
      continue;
    }
    parts.push(part);
    rest = rest.slice(cut + drop);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

export function mediaKinds(message: {
  photo?: unknown;
  sticker?: unknown;
  video?: unknown;
  document?: unknown;
  voice?: unknown;
  audio?: unknown;
  animation?: unknown;
  video_note?: unknown;
  contact?: unknown;
  location?: unknown;
  venue?: unknown;
  poll?: unknown;
}): string[] {
  const kinds: string[] = [];
  if (message.photo) kinds.push("photo");
  if (message.sticker) kinds.push("sticker");
  if (message.video) kinds.push("video");
  if (message.document) kinds.push("document");
  if (message.voice) kinds.push("voice");
  if (message.audio) kinds.push("audio");
  if (message.animation) kinds.push("animation");
  if (message.video_note) kinds.push("video_note");
  if (message.contact) kinds.push("contact");
  if (message.location) kinds.push("location");
  if (message.venue) kinds.push("venue");
  if (message.poll) kinds.push("poll");
  return kinds;
}

const GREETING = /^(hi|hello|hey|yo)[.!?]*$/i;
const PING = /^ping[.!?]*$/i;
const THANKS = /^(thanks|thank you|thx|ty)[.!?]*$/i;

export function fastGreetingReply(text: string, botUsername: string): string | null {
  let trimmed = text.trim();
  if (botUsername) {
    const mention = new RegExp(`^@${botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[,:]?\\s*`, "i");
    trimmed = trimmed.replace(mention, "").trim();
  }
  if (GREETING.test(trimmed)) return "Hello.";
  if (PING.test(trimmed)) return "Pong.";
  if (THANKS.test(trimmed)) return "You're welcome.";
  return null;
}

export function joinUrl(base: string, prefix: string, path: string): string {
  const root = base.replace(/\/+$/, "");
  const cleanPrefix = prefix && prefix !== "/"
    ? (prefix.startsWith("/") ? prefix : `/${prefix}`).replace(/\/+$/, "")
    : "";
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${root}${cleanPrefix}${cleanPath}`;
}
