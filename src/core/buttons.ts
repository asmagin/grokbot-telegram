import { CALLBACK_DATA_MAX_BYTES, signCallbackData, type CallbackVersion } from "./crypto.js";
import { cleanLabel, cleanText } from "./text.js";
import type { InlineKeyboardMarkup, TelegramReplyMarkup } from "./types.js";

/** Telegram's own cap on an inline button label. */
export const MAX_BUTTON_TEXT_CHARS = 64;
export const MAX_BUTTON_ROWS = 8;
export const MAX_BUTTONS_PER_ROW = 8;
export const MAX_BUTTONS = 32;
/** Bytes of action data that fit in a signed callback_data. */
export const MAX_BUTTON_DATA_BYTES = CALLBACK_DATA_MAX_BYTES;
const MAX_BUTTON_URL_CHARS = 2048;

export type ButtonSpec =
  | { type: "callback"; text: string; data: string }
  | { type: "url"; text: string; url: string };

export type ButtonParseError = "bad_buttons" | "button_data_too_long" | "bad_button_url";
export type ButtonSignError = "buttons_require_user" | "buttons_unavailable";

/**
 * Parse the `buttons` field. Absent means no keyboard. Each button is a label
 * plus exactly one of `data` (a callback) or `url` (opened by Telegram).
 */
export function parseButtons(
  value: unknown,
): { ok: true; rows: ButtonSpec[][] | null } | { ok: false; error: ButtonParseError } {
  if (value === undefined || value === null) return { ok: true, rows: null };
  if (!Array.isArray(value)) return { ok: false, error: "bad_buttons" };
  if (value.length === 0) return { ok: true, rows: null };
  if (value.length > MAX_BUTTON_ROWS) return { ok: false, error: "bad_buttons" };
  const rows: ButtonSpec[][] = [];
  let total = 0;
  for (const rawRow of value) {
    if (!Array.isArray(rawRow) || rawRow.length === 0 || rawRow.length > MAX_BUTTONS_PER_ROW) {
      return { ok: false, error: "bad_buttons" };
    }
    const row: ButtonSpec[] = [];
    for (const rawButton of rawRow) {
      total += 1;
      if (total > MAX_BUTTONS) return { ok: false, error: "bad_buttons" };
      const parsed = parseButton(rawButton);
      if (!parsed.ok) return parsed;
      row.push(parsed.button);
    }
    rows.push(row);
  }
  return { ok: true, rows };
}

function parseButton(value: unknown): { ok: true; button: ButtonSpec } | { ok: false; error: ButtonParseError } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "bad_buttons" };
  const record = value as Record<string, unknown>;
  const text = validButtonText(record.text);
  if (!text) return { ok: false, error: "bad_buttons" };
  const hasData = Object.prototype.hasOwnProperty.call(record, "data");
  const hasUrl = Object.prototype.hasOwnProperty.call(record, "url");
  if (hasData === hasUrl) return { ok: false, error: "bad_buttons" };
  if (hasData) {
    if (typeof record.data !== "string" || record.data.length === 0) return { ok: false, error: "bad_buttons" };
    if (cleanText(record.data, MAX_BUTTON_TEXT_CHARS) !== record.data) return { ok: false, error: "bad_buttons" };
    if (new TextEncoder().encode(record.data).length > MAX_BUTTON_DATA_BYTES) {
      return { ok: false, error: "button_data_too_long" };
    }
    return { ok: true, button: { type: "callback", text, data: record.data } };
  }
  if (typeof record.url !== "string") return { ok: false, error: "bad_button_url" };
  const url = normalizeButtonUrl(record.url);
  if (!url) return { ok: false, error: "bad_button_url" };
  return { ok: true, button: { type: "url", text, url } };
}

function validButtonText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > MAX_BUTTON_TEXT_CHARS) return null;
  // Reject labels whose visible text would change once controls and bidi marks are gone.
  if (cleanLabel(text, MAX_BUTTON_TEXT_CHARS) !== text) return null;
  return text;
}

/**
 * https link a person can open. Fragments are kept (a docs anchor is a normal
 * button). Credentials, IP literals, and local names are not: the assistant
 * chooses this URL, and a wake should not be able to dress up an internal host.
 */
export function normalizeButtonUrl(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_BUTTON_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return null;
  }
  if (host === "api.telegram.org") return null;
  if (host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\d+$/.test(host)) return null;
  return url.toString();
}

/**
 * Turn parsed rows into Telegram's inline_keyboard. Callback buttons are signed
 * for `chatId`. A reply-token send (`bindToUser`) is signed for `ownerUserId`,
 * so only that person can produce a wake. An operator send is signed for the
 * chat, and the allowlist still decides who may tap.
 */
export async function keyboardForSend(options: {
  secret: string;
  chatId: string;
  ownerUserId: string | null;
  bindToUser: boolean;
  rows: ButtonSpec[][] | null;
  exp: number;
}): Promise<{ ok: true; markup: InlineKeyboardMarkup | null } | { ok: false; error: ButtonSignError }> {
  const rows = options.rows;
  if (!rows) return { ok: true, markup: null };
  const needsOwner = rows.some((row) => row.some((button) => button.type === "callback"));
  if (needsOwner && options.bindToUser && !options.ownerUserId) {
    return { ok: false, error: "buttons_require_user" };
  }
  if (needsOwner && !options.secret) return { ok: false, error: "buttons_unavailable" };
  const version: CallbackVersion = options.bindToUser ? 1 : 2;
  const inlineKeyboard: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const row of rows) {
    const built: InlineKeyboardMarkup["inline_keyboard"][number] = [];
    for (const button of row) {
      if (button.type === "url") {
        built.push({ text: button.text, url: button.url });
        continue;
      }
      const callbackData = await signCallbackData(options.secret, {
        version,
        chatId: options.chatId,
        userId: options.ownerUserId ?? "",
        exp: options.exp,
        data: button.data,
      });
      if (!callbackData) return { ok: false, error: "buttons_unavailable" };
      built.push({ text: button.text, callback_data: callbackData });
    }
    inlineKeyboard.push(built);
  }
  return { ok: true, markup: { inline_keyboard: inlineKeyboard } };
}

/** The label Telegram showed for this callback_data, if the message still has the keyboard. */
export function callbackButtonText(markup: TelegramReplyMarkup | undefined, callbackData: string): string | null {
  const rows = markup?.inline_keyboard;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      if (!button || typeof button !== "object") continue;
      if (button.callback_data === callbackData && typeof button.text === "string" && button.text.trim()) {
        return button.text;
      }
    }
  }
  return null;
}
