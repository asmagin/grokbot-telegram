import { hasForwardMarker } from "./content.js";
import type { BurstItem } from "./store.js";
import { truncateText } from "./text.js";
import type { TelegramMessage } from "./types.js";

/** Forwards plus a comment, with room to drop the oldest if the burst runs long. */
export const BURST_MAX_ITEMS = 8;

/**
 * How long an abandoned burst can still be delivered when a later update
 * arrives. After this, the next update drops it. The waiter is expected to
 * flush within FORWARD_BURST_MS; this only covers a died wait.
 */
export const BURST_RECOVER_MS = 60_000;

/** Same person: user id, or the chat when the message was sent as a chat. */
export function burstSenderKey(message: TelegramMessage): string {
  if (message.sender_chat && typeof message.sender_chat.id === "number") {
    return `chat:${message.sender_chat.id}`;
  }
  if (message.from && typeof message.from.id === "number") return `user:${message.from.id}`;
  return "unknown";
}

/**
 * The comment, when the burst has one: the latest addressed message that is
 * not itself a forward. Otherwise the latest addressed forward. Null when
 * nothing in the burst addressed the bot (a group forward nobody followed).
 */
export function selectBurstPrimary(items: readonly BurstItem[]): BurstItem | null {
  const addressed = items.filter((item) => item.addressedHow);
  if (addressed.length === 0) return null;
  for (let index = addressed.length - 1; index >= 0; index -= 1) {
    const item = addressed[index];
    if (item && !hasForwardMarker(item.message)) return item;
  }
  return addressed[addressed.length - 1] ?? null;
}

const CLIP_STRING = 8000;
const CLIP_DEPTH = 6;
const CLIP_KEYS = 40;
const CLIP_ARRAY = 12;

function clipValue(value: unknown, depth: number): unknown {
  if (depth > CLIP_DEPTH) return undefined;
  if (typeof value === "string") return truncateText(value, CLIP_STRING);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, CLIP_ARRAY).map((item) => clipValue(item, depth + 1)).filter((item) => item !== undefined);
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value).slice(0, CLIP_KEYS)) {
    if (key.length > 64) continue;
    const clipped = clipValue(inner, depth + 1);
    if (clipped !== undefined) out[key] = clipped;
  }
  return out;
}

function clipRecord(value: unknown): unknown {
  return clipValue(value, 0);
}

/**
 * A bounded copy safe to hold for the debounce. Telegram text is at most 4096
 * characters; the cap is for a hostile body. Entity offsets still match the
 * prefix that remains.
 */
export function clipMessage(message: TelegramMessage, depth = 0): TelegramMessage {
  const chat = message.chat;
  const out: TelegramMessage = {
    message_id: message.message_id,
    chat: {
      id: chat.id,
      type: typeof chat.type === "string" ? truncateText(chat.type, 32) : "private",
      ...(typeof chat.title === "string" ? { title: truncateText(chat.title, 256) } : {}),
      ...(typeof chat.username === "string" ? { username: truncateText(chat.username, 64) } : {}),
    },
  };
  const copy = (key: keyof TelegramMessage) => {
    if (message[key] !== undefined) {
      (out as unknown as Record<string, unknown>)[key] = clipRecord(message[key]);
    }
  };
  copy("from");
  copy("date");
  copy("text");
  copy("caption");
  copy("entities");
  copy("caption_entities");
  copy("message_thread_id");
  copy("is_topic_message");
  copy("sender_chat");
  copy("photo");
  copy("sticker");
  copy("video");
  copy("document");
  copy("voice");
  copy("audio");
  copy("animation");
  copy("video_note");
  copy("contact");
  copy("location");
  copy("venue");
  copy("poll");
  copy("forward_origin");
  copy("forward_from");
  copy("forward_from_chat");
  copy("forward_from_message_id");
  copy("forward_signature");
  copy("forward_sender_name");
  copy("forward_date");
  if (depth === 0) {
    copy("quote");
    copy("external_reply");
    if (message.reply_to_message?.chat && typeof message.reply_to_message.message_id === "number") {
      out.reply_to_message = clipMessage(message.reply_to_message, 1);
    }
  }
  return out;
}
