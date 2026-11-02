export const SCHEMA_VERSION = 4 as const;

export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

export const TELEGRAM_TEXT_LIMIT = 4096;

/** Telegram Bot API getFile refuses anything larger than 20 MiB. */
export const TELEGRAM_GET_FILE_MAX_BYTES = 20 * 1024 * 1024;

/** Caption limit for sendPhoto and sendDocument. */
export const TELEGRAM_CAPTION_LIMIT = 1024;

export const ATTACHMENT_KINDS = [
  "photo",
  "document",
  "video",
  "animation",
  "audio",
  "voice",
  "video_note",
  "sticker",
] as const;

export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export type SendMediaKind = "photo" | "document";

export const DEFAULT_WAKE_COMMANDS = ["ask", "help"] as const;

/**
 * ReactionTypeEmoji values the Bot API reference allows. Compared without
 * U+FE0F, because the reference does not show variation selectors.
 */
export const TELEGRAM_REACTION_EMOJI: readonly string[] = [
  "❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩",
  "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆",
  "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈",
  "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄",
  "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡",
];

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date?: number;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  message_thread_id?: number;
  is_topic_message?: boolean;
  is_automatic_forward?: boolean;
  sender_chat?: TelegramChat;
  reply_to_message?: TelegramMessage;
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
  photo?: unknown[];
  sticker?: unknown;
  video?: unknown;
  document?: unknown;
  voice?: unknown;
  audio?: unknown;
  animation?: unknown;
  video_note?: unknown;
  contact?: unknown;
  location?: unknown;
  poll?: unknown;
  /** Present when this message carries an inline keyboard. */
  reply_markup?: TelegramReplyMarkup;
}

export interface TelegramInlineButton {
  text?: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramReplyMarkup {
  inline_keyboard?: TelegramInlineButton[][];
}

export interface TelegramCallbackQuery {
  id?: string;
  from?: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface PublicUser {
  id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  is_bot: boolean;
}

export interface ContextMessage {
  message_id: number;
  text: string;
  date: number | null;
  message_thread_id: number | null;
  from: PublicUser | null;
}

export interface ReplyTo {
  message_id: number;
  text: string;
  from: PublicUser | null;
}

export interface WakeReply {
  token: string;
  expires_at: string;
  wake_id: string;
  send_url: string;
  send_media_url: string;
  /** POST here to edit a message this wake already sent through send_url. */
  edit_url: string;
  typing_stop_url: string;
  heartbeat_url: string;
  chat_id: string;
  message_thread_id: number | null;
}

/**
 * A file on the waking message. `file_url` is a bridge URL. GET it with
 * `Authorization: Bearer <reply.token>`. The bot token stays on the bridge.
 * `unavailable: "too_large"` means Telegram's getFile limit (20 MiB).
 */
export interface WakeAttachment {
  kind: AttachmentKind;
  mime_type: string | null;
  file_name: string | null;
  file_size: number | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  file_url: string | null;
  unavailable: "too_large" | null;
}

/** Signed into the file URL. Not a reply token: the prefix is `f1`, not `v1`. */
export interface FileClaims {
  v: 1;
  chat_id: string;
  thread_id: number | null;
  wake_id: string;
  file_id: string;
  exp: number;
  kind: AttachmentKind;
  mime: string | null;
  name: string | null;
}

export interface WakeEvent {
  schema_version: typeof SCHEMA_VERSION;
  untrusted_content_notice: string;
  idempotency_key: string;
  update_id: number;
  timestamp: string;
  edited: boolean;
  addressed_how: AddressHow | "callback";
  command: string | null;
  chat: {
    id: string;
    type: string;
    title: string | null;
    username: string | null;
  };
  from: PublicUser | null;
  message: {
    message_id: number;
    text: string;
    date: number | null;
    message_thread_id: number | null;
    media: string[];
    attachments: WakeAttachment[];
    reply_to: ReplyTo | null;
  };
  /** Null when this wake is a message. An object when it is a button tap. */
  callback: WakeCallback | null;
  short_term: ContextMessage[];
  reply: WakeReply;
}

/** One wake inside a chat (and forum topic). Typing runs while a scope has any wake. */
export interface TypingWake {
  wakeId: string;
  /** The Telegram message that triggered the wake; the reaction target. */
  messageId: number | null;
  /** Emoji this wake set on `messageId` and must clear, or null when it owns no reaction. */
  reaction: string | null;
  /**
   * Private-chat sendMessageDraft preview. Not the progress message: a draft
   * has no message_id, so the answer cannot replace it. Progress-then-edit
   * uses /send and /send/edit.
   */
  draft: boolean;
  draftAt: number | null;
  startedAt: number;
  leaseMs: number;
  leaseUntil: number;
  /** Hard ceiling: the lease is never extended past this. */
  deadline: number;
}

export interface TypingScope {
  scopeKey: string;
  chatId: string;
  threadId: number | null;
  refreshMs: number;
  wakes: Record<string, TypingWake>;
}

export interface TypingStart {
  scopeKey: string;
  chatId: string;
  threadId: number | null;
  refreshMs: number;
  wakeId: string;
  messageId: number | null;
  /** Emoji to set on `messageId`, or null for none. */
  reaction: string | null;
  draft: boolean;
  startedAt: number;
  leaseMs: number;
  deadline: number;
}

export interface ReplyClaims {
  v: 1;
  chat_id: string;
  thread_id: number | null;
  wake_id: string;
  exp: number;
  /**
   * The person this wake is for. New wakes set it so a later button can be
   * bound to them without a store lookup. Tokens minted before that omit it.
   */
  user_id?: string;
}

/** One inline button the bridge sends to Telegram. */
export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/**
 * Set on a button-tap wake. Null on an ordinary message.
 * `message_text` is the bot message the button was attached to.
 */
export interface WakeCallback {
  data: string;
  text: string;
  message_id: number;
  message_text: string;
}

/** How a person addressed the bot in a message. Button taps are not in this set. */
export type AddressHow = "private" | "mention" | "command" | "reply";

export interface AddressResult {
  addressed: boolean;
  how: AddressHow | null;
  command: string | null;
}
