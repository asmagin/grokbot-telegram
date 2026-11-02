import { messageEntities, messageText } from "./address.js";
import { cleanLabel, cleanText } from "./text.js";
import type {
  TelegramEntity,
  TelegramMessage,
  WakeContact,
  WakeForwardOrigin,
  WakeLink,
  WakeLocation,
  WakePoll,
  WakePollOption,
  WakeQuote,
  WakeVenue,
} from "./types.js";

export const MAX_LINKS = 10;
export const MAX_LINK_URL = 2048;
export const MAX_LINK_TEXT = 200;
export const MAX_QUOTE = 1000;
export const MAX_POLL_QUESTION = 300;
export const MAX_POLL_OPTION = 100;
export const MAX_POLL_OPTIONS = 10;

const ORIGIN_TYPES = new Set(["user", "hidden_user", "chat", "channel"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function label(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = cleanLabel(value, max);
  return cleaned ? cleaned : null;
}

function unixDate(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function intIn(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

function finiteIn(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

/** Six decimal places is about 10 cm. Enough for a map, small in the payload. */
function coord(value: unknown, min: number, max: number): number | null {
  const n = finiteIn(value, min, max);
  if (n === null) return null;
  return Math.round(n * 1e6) / 1e6;
}

function personName(user: Record<string, unknown> | null): { sender_name: string | null; username: string | null } {
  if (!user) return { sender_name: null, username: null };
  const first = label(user.first_name, 64);
  const last = label(user.last_name, 64);
  const joined = [first, last].filter((part): part is string => Boolean(part)).join(" ");
  return {
    sender_name: joined ? label(joined, 128) : null,
    username: label(user.username, 32),
  };
}

function chatBits(chat: Record<string, unknown> | null): { chat_title: string | null; username: string | null } {
  if (!chat) return { chat_title: null, username: null };
  return {
    chat_title: label(chat.title, 128),
    username: label(chat.username, 32),
  };
}

export function parseOrigin(raw: unknown): WakeForwardOrigin | null {
  const record = asRecord(raw);
  if (!record || typeof record.type !== "string" || !ORIGIN_TYPES.has(record.type)) return null;
  const type = record.type as WakeForwardOrigin["type"];
  const date = unixDate(record.date);
  if (type === "user") {
    const person = personName(asRecord(record.sender_user));
    return { type, date, sender_name: person.sender_name, username: person.username, chat_title: null, message_id: null };
  }
  if (type === "hidden_user") {
    return {
      type,
      date,
      sender_name: label(record.sender_user_name, 128),
      username: null,
      chat_title: null,
      message_id: null,
    };
  }
  const chat = chatBits(asRecord(type === "channel" ? record.chat : record.sender_chat));
  const messageId = type === "channel" ? intIn(record.message_id, 0, Number.MAX_SAFE_INTEGER) : null;
  return {
    type,
    date,
    sender_name: label(record.author_signature, 128),
    username: chat.username,
    chat_title: chat.chat_title,
    message_id: messageId,
  };
}

/** True when Telegram marked the message as forwarded, even if the origin is incomplete. */
export function hasForwardMarker(message: TelegramMessage): boolean {
  if (message.forward_origin && typeof message.forward_origin === "object") return true;
  if (message.forward_from || message.forward_from_chat || message.forward_sender_name) return true;
  return typeof message.forward_date === "number";
}

/**
 * `forward_origin` when Telegram sent it, otherwise the legacy `forward_*` fields.
 * Returns null when nothing identifies a forward.
 */
export function parseForwardOrigin(message: TelegramMessage): WakeForwardOrigin | null {
  const current = parseOrigin(message.forward_origin);
  if (current) return current;
  if (message.forward_from) {
    const person = personName(asRecord(message.forward_from));
    return {
      type: "user",
      date: unixDate(message.forward_date),
      sender_name: person.sender_name,
      username: person.username,
      chat_title: null,
      message_id: null,
    };
  }
  if (message.forward_sender_name) {
    return {
      type: "hidden_user",
      date: unixDate(message.forward_date),
      sender_name: label(message.forward_sender_name, 128),
      username: null,
      chat_title: null,
      message_id: null,
    };
  }
  if (message.forward_from_chat) {
    const chat = message.forward_from_chat;
    const type: WakeForwardOrigin["type"] = chat.type === "channel" ? "channel" : "chat";
    return {
      type,
      date: unixDate(message.forward_date),
      sender_name: label(message.forward_signature, 128),
      username: label(chat.username, 32),
      chat_title: label(chat.title, 128),
      message_id: type === "channel" ? intIn(message.forward_from_message_id, 0, Number.MAX_SAFE_INTEGER) : null,
    };
  }
  if (typeof message.forward_date === "number") {
    return {
      type: "hidden_user",
      date: unixDate(message.forward_date),
      sender_name: null,
      username: null,
      chat_title: null,
      message_id: null,
    };
  }
  return null;
}

function normalizeLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = cleanText(raw, MAX_LINK_URL).trim();
  if (!cleaned || cleaned.length > MAX_LINK_URL) return null;
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return cleaned;
}

/** `url` and `text_link` entities. Offsets are UTF-16, matching JavaScript string indexes. */
export function extractLinks(text: string, entities: readonly TelegramEntity[] | undefined): WakeLink[] {
  if (!entities || !text) return [];
  const links: WakeLink[] = [];
  for (const entity of entities) {
    if (!entity || (entity.type !== "url" && entity.type !== "text_link")) continue;
    if (!Number.isSafeInteger(entity.offset) || !Number.isSafeInteger(entity.length)) continue;
    if (entity.offset < 0 || entity.length <= 0 || entity.offset + entity.length > text.length) continue;
    const visible = text.slice(entity.offset, entity.offset + entity.length);
    const url = normalizeLink(entity.type === "text_link" ? entity.url : visible);
    if (!url) continue;
    const shown = cleanText(visible, MAX_LINK_TEXT).trim();
    links.push({
      kind: entity.type,
      url,
      text: entity.type === "text_link" ? (shown || null) : null,
    });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

export function messageLinks(message: TelegramMessage): WakeLink[] {
  return extractLinks(messageText(message), messageEntities(message));
}

export function parseContact(raw: unknown): WakeContact | null {
  const record = asRecord(raw);
  if (!record) return null;
  const contact: WakeContact = {
    phone_number: label(record.phone_number, 32),
    first_name: label(record.first_name, 64),
    last_name: label(record.last_name, 64),
    user_id: intIn(record.user_id, 0, Number.MAX_SAFE_INTEGER) === null
      ? null
      : String(record.user_id),
  };
  if (!contact.phone_number && !contact.first_name && !contact.last_name && !contact.user_id) return null;
  return contact;
}

export function parseLocation(raw: unknown): WakeLocation | null {
  const record = asRecord(raw);
  if (!record) return null;
  const latitude = coord(record.latitude, -90, 90);
  const longitude = coord(record.longitude, -180, 180);
  if (latitude === null || longitude === null) return null;
  return {
    latitude,
    longitude,
    horizontal_accuracy: finiteIn(record.horizontal_accuracy, 0, 1_000_000),
    live_period: intIn(record.live_period, 0, 2_592_000),
  };
}

export function parseVenue(raw: unknown): WakeVenue | null {
  const record = asRecord(raw);
  if (!record) return null;
  const loc = parseLocation(record.location);
  const venue: WakeVenue = {
    title: label(record.title, 128),
    address: label(record.address, 200),
    latitude: loc?.latitude ?? null,
    longitude: loc?.longitude ?? null,
    foursquare_id: label(record.foursquare_id, 128),
    google_place_id: label(record.google_place_id, 128),
  };
  if (!venue.title && !venue.address && venue.latitude === null && !venue.foursquare_id && !venue.google_place_id) {
    return null;
  }
  return venue;
}

export function parsePoll(raw: unknown): WakePoll | null {
  const record = asRecord(raw);
  if (!record) return null;
  const question = cleanText(typeof record.question === "string" ? record.question : "", MAX_POLL_QUESTION).trim();
  if (!question) return null;
  const type: WakePoll["type"] = record.type === "quiz" || record.type === "regular" ? record.type : "unknown";
  const options: WakePollOption[] = [];
  const rawOptions = Array.isArray(record.options) ? record.options : [];
  for (const option of rawOptions) {
    const item = asRecord(option);
    if (!item) continue;
    const text = cleanText(typeof item.text === "string" ? item.text : "", MAX_POLL_OPTION).trim();
    if (!text) continue;
    options.push({ text, voter_count: intIn(item.voter_count, 0, 2_000_000_000) });
    if (options.length >= MAX_POLL_OPTIONS) break;
  }
  return {
    question,
    type,
    options,
    total_voter_count: intIn(record.total_voter_count, 0, 2_000_000_000),
    is_closed: record.is_closed === true,
    is_anonymous: record.is_anonymous === true,
    allows_multiple_answers: record.allows_multiple_answers === true,
    correct_option_id: intIn(record.correct_option_id, 0, MAX_POLL_OPTIONS),
  };
}

export function parseQuote(raw: unknown): WakeQuote | null {
  const record = asRecord(raw);
  if (!record) return null;
  const text = cleanText(typeof record.text === "string" ? record.text : "", MAX_QUOTE).trim();
  if (!text) return null;
  return {
    text,
    position: intIn(record.position, 0, 100_000),
    is_manual: record.is_manual === true,
  };
}

const MEDIA_KEYS = ["photo", "sticker", "video", "document", "voice", "audio", "animation", "video_note"] as const;

export function hasExternalMedia(record: Record<string, unknown>): boolean {
  return MEDIA_KEYS.some((key) => record[key] != null);
}

export interface ExternalReplyParts {
  origin: WakeForwardOrigin | null;
  chat_title: string | null;
  chat_username: string | null;
  message_id: number | null;
  contact: WakeContact | null;
  location: WakeLocation | null;
  venue: WakeVenue | null;
  poll: WakePoll | null;
  source: Record<string, unknown>;
}

export function parseExternalReply(raw: unknown): ExternalReplyParts | null {
  const record = asRecord(raw);
  if (!record) return null;
  const chat = asRecord(record.chat);
  const parts: ExternalReplyParts = {
    origin: parseOrigin(record.origin),
    chat_title: label(chat?.title, 128),
    chat_username: label(chat?.username, 32),
    message_id: intIn(record.message_id, 0, Number.MAX_SAFE_INTEGER),
    contact: parseContact(record.contact),
    location: parseLocation(record.location),
    venue: parseVenue(record.venue),
    poll: parsePoll(record.poll),
    source: record,
  };
  const empty = !parts.origin
    && !parts.chat_title
    && !parts.chat_username
    && parts.message_id === null
    && !parts.contact
    && !parts.location
    && !parts.venue
    && !parts.poll
    && !hasExternalMedia(record);
  return empty ? null : parts;
}
