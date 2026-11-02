import { isPlausibleBotToken } from "./config.js";
import { isPlausibleFileId } from "./crypto.js";
import { mayHaveBeenReceived } from "./http.js";
import { isSafeTelegramFilePath } from "./media.js";
import { TELEGRAM_GET_FILE_MAX_BYTES, type InlineKeyboardMarkup, type SendMediaKind } from "./types.js";

export interface SendMessageInput {
  chat_id: string;
  text: string;
  message_thread_id?: number;
  reply_to_message_id?: number;
  /** Telegram: "Sends the message silently. Users will receive a notification with no sound." */
  disable_notification?: boolean;
  reply_markup?: InlineKeyboardMarkup;
}

export type SendMessageResult =
  | { ok: true; messageId: number; notModified?: boolean }
  | {
    ok: false;
    description: string;
    status: number;
    retryAfter?: number;
    /** Telegram may have posted it anyway (timeout, reset, 5xx, unreadable 200). Never resend. */
    ambiguous?: boolean;
  };

export type CallResult = { ok: true } | { ok: false; description: string; status: number };

export interface TelegramClient {
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  /**
   * Replace the text of a message this bot sent. `notModified` means Telegram
   * already had that text (`message is not modified`), which is success.
   */
  editMessageText(input: { chat_id: string; message_id: number; text: string }): Promise<SendMessageResult>;
  /** One photo, document, voice note, or audio file. `url` is fetched by Telegram. `file` is uploaded by the bridge. */
  sendMedia(input: SendMediaInput): Promise<SendMessageResult>;
  /** Bot API getFile. Does not download bytes. */
  getFile(fileId: string): Promise<GetFileResult>;
  /**
   * Stream a file Telegram already described. The URL contains the bot token
   * and must never be returned, logged, or followed across a redirect.
   */
  downloadFile(filePath: string, timeoutMs?: number): Promise<DownloadResult>;
  sendChatAction(input: {
    chat_id: string;
    message_thread_id?: number;
  }): Promise<boolean>;
  /**
   * Set one emoji reaction, or clear the bot's reaction with `emoji: null`
   * (an empty `reaction` list). Bots can set at most one reaction per message.
   */
  setMessageReaction(input: {
    chat_id: string;
    message_id: number;
    emoji: string | null;
  }): Promise<CallResult>;
  /** Private chats only. Empty text shows Telegram's "Thinking…" placeholder for up to 30 seconds. */
  sendMessageDraft(input: {
    chat_id: string;
    draft_id: number;
    message_thread_id?: number;
    text?: string;
  }): Promise<CallResult>;
  /** Stop the client's loading spinner. `text` is a toast, not a modal. */
  answerCallbackQuery(input: { callback_query_id: string; text?: string }): Promise<CallResult>;
  /** Replace or clear the inline keyboard on a message the bot sent. */
  editMessageReplyMarkup(input: {
    chat_id: string;
    message_id: number;
    reply_markup: InlineKeyboardMarkup;
  }): Promise<CallResult>;
}

export interface SendMediaInput {
  chat_id: string;
  kind: SendMediaKind;
  url?: string;
  file?: { bytes: Uint8Array; filename: string; mime: string };
  caption?: string;
  message_thread_id?: number;
  reply_to_message_id?: number;
  disable_notification?: boolean;
  reply_markup?: InlineKeyboardMarkup;
}

export type GetFileResult =
  | { ok: true; filePath: string; fileSize: number | null }
  | { ok: false; description: string; status: number; tooLarge?: boolean };

export type DownloadResult =
  | { ok: true; body: ReadableStream<Uint8Array>; contentLength: number | null }
  | { ok: false; description: string; status: number; tooLarge?: boolean; timeout?: boolean };

/** Telegram returns this when editMessageText is asked to write the text it already has. */
export function isNotModified(description: string): boolean {
  return /message is not modified/i.test(description);
}

export function telegramMethodUrl(token: string, method: string): string | null {
  if (!isPlausibleBotToken(token)) return null;
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(method)) return null;
  return `https://api.telegram.org/bot${token}/${method}`;
}

/** Download URL. Null when the path is not a relative Telegram file path. */
export function telegramFileUrl(token: string, filePath: string): string | null {
  if (!isPlausibleBotToken(token)) return null;
  if (!isSafeTelegramFilePath(filePath)) return null;
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}

function mediaMethod(kind: SendMediaKind): string {
  switch (kind) {
    case "photo":
      return "sendPhoto";
    case "voice":
      return "sendVoice";
    case "audio":
      return "sendAudio";
    case "document":
      return "sendDocument";
  }
}

function mediaField(kind: SendMediaKind): string {
  switch (kind) {
    case "photo":
      return "photo";
    case "voice":
      return "voice";
    case "audio":
      return "audio";
    case "document":
      return "document";
  }
}

interface TelegramOk {
  ok: true;
  result?: { message_id?: number };
}

interface TelegramErr {
  ok: false;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export function createTelegramClient(options: {
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  maxRetryAfterMs?: number;
}): TelegramClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? 2;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 5000;

  async function call(
    method: string,
    body: string | FormData,
    timeoutMs = 10_000,
    jsonBody = true,
  ): Promise<{ response: Response; json: unknown } | { error: string; ambiguous: boolean }> {
    const url = telegramMethodUrl(options.token, method);
    if (!url) return { error: "bot_token_not_configured", ambiguous: false };
    const headers = new Headers();
    // FormData sets its own multipart boundary. A manual content-type would drop it.
    if (jsonBody) headers.set("content-type", "application/json");
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return { error: "telegram_redirect", ambiguous: false };
      }
      const json: unknown = await response.json().catch(() => null);
      return { response, json };
    } catch (err) {
      return { error: "telegram_unreachable", ambiguous: mayHaveBeenReceived(err) };
    }
  }

  /**
   * Only a 429 is retried: Telegram did not post the message. Anything that may
   * have posted it is not. `makeBody` runs per attempt because a FormData body
   * can be read only once.
   */
  async function postWithRetry(
    method: string,
    makeBody: () => { body: string | FormData; json: boolean },
    timeoutMs: number,
  ): Promise<SendMessageResult> {
    let attempt = 0;
    while (true) {
      const made = makeBody();
      const result = await call(method, made.body, timeoutMs, made.json);
      if ("error" in result) {
        return result.ambiguous
          ? { ok: false, description: result.error, status: 0, ambiguous: true }
          : { ok: false, description: result.error, status: 0 };
      }
      const data = result.json as TelegramOk | TelegramErr | null;
      if (result.response.ok && data && data.ok === true) {
        const messageId = data.result?.message_id;
        return { ok: true, messageId: typeof messageId === "number" ? messageId : 0 };
      }
      const description = data && data.ok === false && data.description ? data.description : "telegram_error";
      const status = result.response.status;
      const retryAfter = data && data.ok === false ? data.parameters?.retry_after : undefined;
      const waitMs = Math.max(0, (retryAfter ?? 1) * 1000);
      // Only wait in-request for short limits. Retrying before retry_after just earns another 429.
      if (status === 429 && attempt < maxRetries && waitMs <= maxRetryAfterMs) {
        await sleep(waitMs);
        attempt += 1;
        continue;
      }
      const failure: SendMessageResult = { ok: false, description: description.slice(0, 300), status };
      if (status === 429 && typeof retryAfter === "number") failure.retryAfter = retryAfter;
      // A 5xx, or a 200 we could not read, can follow a message that was posted.
      if (status >= 500 || (result.response.ok && data === null)) failure.ambiguous = true;
      return failure;
    }
  }

  function replyFields(input: {
    message_thread_id?: number;
    reply_to_message_id?: number;
    disable_notification?: boolean;
    caption?: string;
    reply_markup?: InlineKeyboardMarkup;
  }): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    if (input.caption) payload.caption = input.caption;
    if (input.message_thread_id !== undefined) payload.message_thread_id = input.message_thread_id;
    if (input.disable_notification !== undefined) payload.disable_notification = input.disable_notification;
    if (input.reply_markup) payload.reply_markup = input.reply_markup;
    if (input.reply_to_message_id !== undefined) {
      // If the original message was deleted, still deliver the answer.
      payload.reply_parameters = {
        message_id: input.reply_to_message_id,
        allow_sending_without_reply: true,
      };
    }
    return payload;
  }

  return {
    async sendMessage(input) {
      const payload: Record<string, unknown> = {
        chat_id: input.chat_id,
        text: input.text,
        ...replyFields(input),
      };
      const body = JSON.stringify(payload);
      return postWithRetry("sendMessage", () => ({ body, json: true }), 10_000);
    },
    async editMessageText(input) {
      const payload = {
        chat_id: input.chat_id,
        message_id: input.message_id,
        text: input.text,
      };
      const body = JSON.stringify(payload);
      const result = await postWithRetry("editMessageText", () => ({ body, json: true }), 10_000);
      if (!result.ok && result.status === 400 && isNotModified(result.description)) {
        return { ok: true, messageId: input.message_id, notModified: true };
      }
      if (result.ok) return { ok: true, messageId: input.message_id };
      return result;
    },
    async sendMedia(input) {
      const method = mediaMethod(input.kind);
      const field = mediaField(input.kind);
      const extra = replyFields(input);
      if (input.file) {
        const file = input.file;
        return postWithRetry(method, () => {
          const form = new FormData();
          form.set("chat_id", input.chat_id);
          const bytes = new Uint8Array(file.bytes.byteLength);
          bytes.set(file.bytes);
          form.set(field, new Blob([bytes], { type: file.mime || "application/octet-stream" }), file.filename);
          for (const [key, value] of Object.entries(extra)) {
            // Telegram wants these objects as JSON strings inside multipart.
            if (key === "reply_parameters" || key === "reply_markup") form.set(key, JSON.stringify(value));
            else form.set(key, String(value));
          }
          return { body: form, json: false };
        }, 30_000);
      }
      if (!input.url) return { ok: false, description: "missing_media", status: 0 };
      const payload = { chat_id: input.chat_id, [field]: input.url, ...extra };
      const body = JSON.stringify(payload);
      // Telegram downloads the URL, so allow longer than a text send.
      return postWithRetry(method, () => ({ body, json: true }), 20_000);
    },
    async getFile(fileId) {
      if (!isPlausibleFileId(fileId)) return { ok: false, description: "bad_file_id", status: 0 };
      const result = await call("getFile", JSON.stringify({ file_id: fileId }));
      if ("error" in result) return { ok: false, description: result.error, status: 0 };
      const data = result.json as { ok?: boolean; description?: string; result?: { file_path?: string; file_size?: number } } | null;
      if (result.response.ok && data && data.ok === true && typeof data.result?.file_path === "string") {
        const fileSize = typeof data.result.file_size === "number" && Number.isSafeInteger(data.result.file_size)
          ? data.result.file_size
          : null;
        if (fileSize !== null && fileSize > TELEGRAM_GET_FILE_MAX_BYTES) {
          return { ok: false, description: "file_too_large", status: 413, tooLarge: true };
        }
        return { ok: true, filePath: data.result.file_path, fileSize };
      }
      const description = data && data.ok === false && data.description ? data.description : "telegram_error";
      const tooLarge = /file is too big/i.test(description);
      return {
        ok: false,
        description: description.slice(0, 300),
        status: result.response.status,
        ...(tooLarge ? { tooLarge: true } : {}),
      };
    },
    async downloadFile(filePath, timeoutMs = 50_000) {
      const url = telegramFileUrl(options.token, filePath);
      if (!url) return { ok: false, description: "bad_file_path", status: 0 };
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => undefined);
          return { ok: false, description: "telegram_redirect", status: response.status };
        }
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => undefined);
          return { ok: false, description: "telegram_file_failed", status: response.status };
        }
        const lengthHeader = response.headers.get("content-length");
        const contentLength = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
        if (contentLength !== null && contentLength > TELEGRAM_GET_FILE_MAX_BYTES) {
          await response.body.cancel().catch(() => undefined);
          return { ok: false, description: "file_too_large", status: 413, tooLarge: true };
        }
        return { ok: true, body: response.body, contentLength };
      } catch (err) {
        const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        return {
          ok: false,
          description: timeout ? "timeout" : "telegram_unreachable",
          status: 0,
          ...(timeout ? { timeout: true } : {}),
        };
      }
    },
    async sendChatAction(input) {
      const payload: Record<string, unknown> = {
        chat_id: input.chat_id,
        action: "typing",
      };
      if (input.message_thread_id !== undefined) payload.message_thread_id = input.message_thread_id;
      const result = await call("sendChatAction", JSON.stringify(payload));
      if ("error" in result) return false;
      const data = result.json as { ok?: boolean } | null;
      return result.response.ok && data?.ok === true;
    },
    async setMessageReaction(input) {
      return simpleCall("setMessageReaction", {
        chat_id: input.chat_id,
        message_id: input.message_id,
        reaction: input.emoji === null ? [] : [{ type: "emoji", emoji: input.emoji }],
        is_big: false,
      });
    },
    async sendMessageDraft(input) {
      // chat_id is documented as Integer here, not "Integer or String".
      const payload: Record<string, unknown> = {
        chat_id: Number(input.chat_id),
        draft_id: input.draft_id,
        text: input.text ?? "",
      };
      if (input.message_thread_id !== undefined) payload.message_thread_id = input.message_thread_id;
      return simpleCall("sendMessageDraft", payload);
    },
    async answerCallbackQuery(input) {
      const payload: Record<string, unknown> = { callback_query_id: input.callback_query_id };
      if (input.text) payload.text = input.text;
      return simpleCall("answerCallbackQuery", payload);
    },
    async editMessageReplyMarkup(input) {
      return simpleCall("editMessageReplyMarkup", {
        chat_id: input.chat_id,
        message_id: input.message_id,
        reply_markup: input.reply_markup,
      });
    },
  };

  /** One attempt, no retries: these calls are cosmetic and must never hold up a reply. */
  async function simpleCall(method: string, body: unknown): Promise<CallResult> {
    const result = await call(method, JSON.stringify(body));
    if ("error" in result) return { ok: false, description: result.error, status: 0 };
    const data = result.json as TelegramOk | TelegramErr | null;
    if (result.response.ok && data && data.ok === true) return { ok: true };
    const description = data && data.ok === false && data.description ? data.description : "telegram_error";
    return { ok: false, description: description.slice(0, 200), status: result.response.status };
  }
}
