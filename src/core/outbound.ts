import { isOutboundChatAllowed } from "./allowlist.js";
import { keyboardForSend, parseButtons, type ButtonSpec } from "./buttons.js";
import { canonicalId } from "./config.js";
import { replyTokenScopeOk, secretsEqual, verifyReplyToken } from "./crypto.js";
import type { AppDeps } from "./deps.js";
import { json, readLimitedBody, readLimitedBytes } from "./http.js";
import { cleanFileName, normalizePublicMediaUrl } from "./media.js";
import { scopeKey, type SendRecord } from "./store.js";
import type { SendMessageResult } from "./telegram.js";
import { splitTelegramText } from "./text.js";
import { TELEGRAM_CAPTION_LIMIT, TELEGRAM_TEXT_LIMIT, type InlineKeyboardMarkup, type ReplyClaims, type SendMediaKind } from "./types.js";

const MAX_TEXT_CHARS = TELEGRAM_TEXT_LIMIT * 8;

interface SendBody {
  chat_id?: unknown;
  text?: unknown;
  message_thread_id?: unknown;
  reply_to_message_id?: unknown;
  final?: unknown;
  wake_id?: unknown;
  disable_notification?: unknown;
  idempotency_key?: unknown;
  buttons?: unknown;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

export async function handleSend(request: Request, deps: AppDeps): Promise<Response> {
  const credential = await authenticate(request, deps);
  if (!credential.ok) return credential.response;
  const parsed = await readJson(request, deps.config.maxBodyBytes);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as SendBody;
  const chatId = normalizeId(body.chat_id);
  const text = typeof body.text === "string" ? body.text : "";
  const threadId = normalizeOptionalInt(body.message_thread_id);
  const replyTo = normalizeOptionalInt(body.reply_to_message_id);
  const final = body.final === true;
  if (body.disable_notification !== undefined && typeof body.disable_notification !== "boolean") {
    return json(400, { ok: false, error: "bad_disable_notification" });
  }
  if (body.idempotency_key !== undefined && (typeof body.idempotency_key !== "string" || !IDEMPOTENCY_KEY.test(body.idempotency_key))) {
    return json(400, { ok: false, error: "bad_idempotency_key" });
  }
  const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : null;
  const requestedWakeId = typeof body.wake_id === "string" && body.wake_id.length <= 80 ? body.wake_id : null;
  if (!chatId) return json(400, { ok: false, error: "bad_chat_id" });
  if (!text.trim()) return json(400, { ok: false, error: "empty_text" });
  if (text.length > MAX_TEXT_CHARS) return json(413, { ok: false, error: "text_too_large" });
  if (threadId === "invalid" || replyTo === "invalid") return json(400, { ok: false, error: "bad_message_id" });
  const parsedButtons = parseButtons(body.buttons);
  if (!parsedButtons.ok) return json(400, { ok: false, error: parsedButtons.error });

  const auth = await authorize(credential, deps, chatId, threadId, { allowClosed: true });
  if (!auth.ok) return auth.response;
  const keyboard = await keyboardFrom(deps, chatId, auth, parsedButtons.rows);
  if (!keyboard.ok) return keyboard.response;
  const reserved = await reserveSend(deps, auth, chatId, final, idempotencyKey);
  if (!reserved.ok) return reserved.response;

  // A progress line inside a wake goes out silently; the final answer notifies.
  // Operator sends (OUTBOUND_API_KEY, no wake) notify unless told otherwise.
  const silent = typeof body.disable_notification === "boolean"
    ? body.disable_notification
    : auth.wakeId !== null && !final;
  const scope = scopeKey(chatId, typeof threadId === "number" ? threadId : null);
  const parts = splitTelegramText(text);
  const messageIds: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? "";
    const input: {
      chat_id: string;
      text: string;
      message_thread_id?: number;
      reply_to_message_id?: number;
      disable_notification?: boolean;
      reply_markup?: InlineKeyboardMarkup;
    } = { chat_id: chatId, text: part, disable_notification: silent };
    if (typeof threadId === "number") input.message_thread_id = threadId;
    if (index === 0 && typeof replyTo === "number") input.reply_to_message_id = replyTo;
    // A split reply is several bubbles. The keyboard belongs on the last one.
    if (keyboard.markup && index === parts.length - 1) input.reply_markup = keyboard.markup;
    const sent = await deps.telegram.sendMessage(input);
    if (!sent.ok) return failSend(deps, { chatId, auth, scope, reserved, messageIds, sent, remember: true });
    messageIds.push(sent.messageId);
  }
  return succeedSend(deps, {
    chatId,
    auth,
    final,
    requestedWakeId,
    scope,
    reserved,
    messageIds,
    parts: parts.length,
    silent,
    remember: true,
  });
}

interface MediaBody extends SendBody {
  kind?: unknown;
  url?: unknown;
  caption?: unknown;
  file_name?: unknown;
}

/**
 * Send one photo or document. JSON carries an https URL that Telegram downloads.
 * multipart/form-data uploads the file (field `file`), capped for serverless bodies.
 * final, reply_to, thread, typing, and idempotency match text /send, and a final
 * here consumes the same one-final slot.
 */
export async function handleSendMedia(request: Request, deps: AppDeps): Promise<Response> {
  const credential = await authenticate(request, deps);
  if (!credential.ok) return credential.response;
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const parsed = contentType.startsWith("multipart/form-data")
    ? await readMediaUpload(request, deps.config.maxMediaBytes)
    : await readMediaJson(request, deps.config.maxBodyBytes);
  if (!parsed.ok) return parsed.response;
  const media = parsed.value;

  const auth = await authorize(credential, deps, media.chatId, media.threadId, { allowClosed: true });
  if (!auth.ok) return auth.response;
  const keyboard = await keyboardFrom(deps, media.chatId, auth, media.buttons);
  if (!keyboard.ok) return keyboard.response;
  const reserved = await reserveSend(deps, auth, media.chatId, media.final, media.idempotencyKey);
  if (!reserved.ok) return reserved.response;

  const silent = typeof media.disableNotification === "boolean"
    ? media.disableNotification
    : auth.wakeId !== null && !media.final;
  const scope = scopeKey(media.chatId, media.threadId);
  const input: {
    chat_id: string;
    kind: SendMediaKind;
    url?: string;
    file?: { bytes: Uint8Array; filename: string; mime: string };
    caption?: string;
    message_thread_id?: number;
    reply_to_message_id?: number;
    disable_notification?: boolean;
    reply_markup?: InlineKeyboardMarkup;
  } = {
    chat_id: media.chatId,
    kind: media.kind,
    disable_notification: silent,
  };
  if (keyboard.markup) input.reply_markup = keyboard.markup;
  if (media.caption) input.caption = media.caption;
  if (media.threadId !== null) input.message_thread_id = media.threadId;
  if (media.replyTo !== null) input.reply_to_message_id = media.replyTo;
  if (media.source.type === "url") input.url = media.source.url;
  else input.file = media.source.file;

  const sent = await deps.telegram.sendMedia(input);
  if (!sent.ok) return failSend(deps, { chatId: media.chatId, auth, scope, reserved, messageIds: [], sent, remember: false });
  return succeedSend(deps, {
    chatId: media.chatId,
    auth,
    final: media.final,
    requestedWakeId: media.requestedWakeId,
    scope,
    reserved,
    messageIds: [sent.messageId],
    parts: 1,
    silent,
    kind: media.kind,
    remember: false,
  });
}

interface OpenSend {
  wakeId: string | null;
  expiresAtMs: number;
  closed: boolean;
}

interface ReservedSend {
  sendKey: string | null;
  sendTtlMs: number;
}

/** One final per wake, and at most one delivery per idempotency_key. Held for the token's life. */
async function reserveSend(
  deps: AppDeps,
  auth: OpenSend,
  chatId: string,
  final: boolean,
  idempotencyKey: string | null,
): Promise<{ ok: true } & ReservedSend | { ok: false; response: Response }> {
  const sendKey = auth.wakeId
    ? final ? `${auth.wakeId}:final` : idempotencyKey ? `${auth.wakeId}:key:${idempotencyKey}` : null
    : idempotencyKey ? `outbound:${chatId}:${idempotencyKey}` : null;
  const sendTtlMs = auth.wakeId ? Math.max(1000, auth.expiresAtMs - deps.now()) : deps.config.dedupeTtlMs;
  const existing = sendKey ? await deps.store.claimSend(sendKey, deps.now(), sendTtlMs) : null;
  if (existing) return { ok: false, response: repeatedSend(deps, chatId, auth.wakeId, existing) };
  if (auth.closed) {
    if (sendKey) await deps.store.releaseSend(sendKey);
    return { ok: false, response: json(401, { ok: false, error: "wake_closed" }) };
  }
  return { ok: true, sendKey, sendTtlMs };
}

async function failSend(
  deps: AppDeps,
  options: {
    chatId: string;
    auth: OpenSend;
    scope: string;
    reserved: ReservedSend;
    messageIds: number[];
    sent: Extract<SendMessageResult, { ok: false }>;
    remember: boolean;
    /** Set when the failure is an editMessageText call rather than a new send. */
    edit?: boolean;
    /** The edit itself landed (or was already the requested text) before a later send failed. */
    edited?: boolean;
  },
): Promise<Response> {
  const { chatId, auth, scope, reserved, messageIds, sent } = options;
  if (options.remember) await rememberOutbound(deps, auth, messageIds);
  const ambiguous = sent.ambiguous === true;
  deps.log({
    event: ambiguous
      ? (options.edit ? "edit_ambiguous" : "send_ambiguous")
      : (options.edit ? "edit_failed" : "send_failed"),
    chat_id: chatId,
    status: sent.status,
    sent_parts: messageIds.length,
    wake_id: auth.wakeId,
  });
  // Never retried here. An ambiguous part may be in the chat, so a repeat of this key is refused;
  // a definite failure frees the key so the caller can send what is missing.
  if (reserved.sendKey) {
    // If this write fails the claim stays pending, which also refuses a repeat.
    await (ambiguous
      ? deps.store.finishSend(reserved.sendKey, { state: "ambiguous", message_ids: messageIds }, deps.now(), reserved.sendTtlMs)
      : deps.store.releaseSend(reserved.sendKey)
    ).catch((err: unknown) => {
      deps.log({ event: "send_record_failed", chat_id: chatId, error: err instanceof Error ? err.name : "error" });
    });
  }
  // Typing stays on: the answer did not get through. Anything that did clear typing on the clients.
  if (messageIds.length > 0) await afterMessage(deps, scope, auth.wakeId);
  const editCall = options.edit === true;
  return json(502, {
    ok: false,
    error: ambiguous
      ? (editCall ? "telegram_edit_ambiguous" : "telegram_send_ambiguous")
      : (editCall ? "telegram_edit_failed" : "telegram_send_failed"),
    ambiguous,
    description: sent.description,
    sent_parts: messageIds.length,
    message_ids: messageIds,
    ...(options.edited !== undefined ? { edited: options.edited } : {}),
    ...(sent.retryAfter !== undefined ? { retry_after: sent.retryAfter } : {}),
  });
}

async function succeedSend(
  deps: AppDeps,
  options: {
    chatId: string;
    auth: OpenSend;
    final: boolean;
    requestedWakeId: string | null;
    scope: string;
    reserved: ReservedSend;
    messageIds: number[];
    parts: number;
    silent: boolean;
    kind?: string;
    remember: boolean;
    /** Log `edit` when the delivery was an in-place update. Defaults to a new send. */
    via?: "send" | "edit";
    notModified?: boolean;
  },
): Promise<Response> {
  const { chatId, auth, final, requestedWakeId, scope, reserved, messageIds, silent } = options;
  // Recorded before anything else, so a repeat is answered with already_sent even if finishing up fails.
  if (reserved.sendKey) {
    try {
      await deps.store.finishSend(reserved.sendKey, { state: "sent", message_ids: messageIds }, deps.now(), reserved.sendTtlMs);
    } catch (err) {
      // The claim stays pending, so a repeat is refused rather than resent.
      deps.log({ event: "send_record_failed", chat_id: chatId, error: err instanceof Error ? err.name : "error" });
    }
  }
  if (options.remember) await rememberOutbound(deps, auth, messageIds);

  const wakeId = auth.wakeId ?? (final ? requestedWakeId : null);
  if (final && wakeId) {
    // Only now, after Telegram confirmed every part: end this wake's typing and reaction.
    try {
      const stopped = await deps.typing.stop(scope, wakeId);
      // This wake had already ended (lease ran out); other wakes here still need typing back.
      if (!stopped.stopped) await deps.typing.touch(scope, null);
      if (auth.wakeId) {
        const remainingMs = Math.max(1000, auth.expiresAtMs - deps.now());
        await deps.store.closeWake(auth.wakeId, deps.now(), remainingMs);
      }
    } catch (err) {
      deps.log({
        event: "send_finalize_failed",
        chat_id: chatId,
        error: err instanceof Error ? err.name : "error",
      });
    }
  } else {
    await afterMessage(deps, scope, auth.wakeId);
  }

  deps.log({
    event: options.via === "edit" ? "edit" : "send",
    chat_id: chatId,
    parts: options.parts,
    final,
    silent,
    wake_id: auth.wakeId,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.notModified ? { not_modified: true } : {}),
  });
  return json(200, {
    ok: true,
    message_ids: messageIds,
    ...(options.notModified ? { not_modified: true } : {}),
  });
}

/**
 * Message ids this wake may later edit. Photos and documents are left out:
 * editMessageText only replaces text. A failed record is logged and the send
 * still counts as delivered; the edit then fails closed with not_outbound.
 */
async function rememberOutbound(deps: AppDeps, auth: OpenSend, messageIds: readonly number[]): Promise<void> {
  if (!auth.wakeId) return;
  const ids = messageIds.filter((id) => Number.isSafeInteger(id) && id > 0);
  if (ids.length === 0) return;
  const ttlMs = Math.max(1000, auth.expiresAtMs - deps.now());
  try {
    await deps.store.noteOutbound(auth.wakeId, ids, deps.now(), ttlMs);
  } catch (err) {
    deps.log({ event: "outbound_record_failed", wake_id: auth.wakeId, error: err instanceof Error ? err.name : "error" });
  }
}

/** Longer than editMessageText plus its in-request 429 retries, so a live editor is not stolen. */
const EDIT_LOCK_TTL_MS = 60_000;
/** Stop waiting and leave the bubble alone. A Vercel invocation cannot sit here until the platform kills it. */
const EDIT_LOCK_WAIT_MS = 30_000;
const EDIT_LOCK_POLL_MS = 20;

function editLockKey(wakeId: string, messageId: number): string {
  return `${wakeId}:edit:${messageId}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One edit of this message at a time, including Telegram's 429 retry inside
 * editMessageText. Returns the owner token, or null when the wait runs out.
 */
async function acquireEditLock(deps: AppDeps, wakeId: string, messageId: number): Promise<string | null> {
  const key = editLockKey(wakeId, messageId);
  const started = Date.now();
  for (;;) {
    const token = await deps.store.claimEditLock(key, deps.now(), EDIT_LOCK_TTL_MS);
    if (token) return token;
    if (Date.now() - started >= EDIT_LOCK_WAIT_MS) return null;
    await delay(EDIT_LOCK_POLL_MS);
  }
}

interface EditBody {
  chat_id?: unknown;
  text?: unknown;
  message_id?: unknown;
  message_thread_id?: unknown;
  final?: unknown;
}

/**
 * Replace the text of a message this wake already sent. The reply token is
 * the caller. The message id has to be one `/send` recorded for this wake;
 * that check is the bridge's, not the caller's. `"final": true` takes the
 * same one-final slot as `/send` and `/send/media`, then clears typing and
 * the progress reaction. A longer final answer is split: the first piece
 * replaces this message and the rest are new messages.
 */
export async function handleSendEdit(request: Request, deps: AppDeps): Promise<Response> {
  const credential = await authenticate(request, deps);
  if (!credential.ok) return credential.response;
  const parsed = await readJson(request, deps.config.maxBodyBytes);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as EditBody;
  const chatId = normalizeId(body.chat_id);
  const text = typeof body.text === "string" ? body.text : "";
  const threadId = normalizeOptionalInt(body.message_thread_id);
  const messageId = normalizeOptionalInt(body.message_id);
  const final = body.final === true;
  if (!chatId) return json(400, { ok: false, error: "bad_chat_id" });
  if (!text.trim()) return json(400, { ok: false, error: "empty_text" });
  if (text.length > MAX_TEXT_CHARS) return json(413, { ok: false, error: "text_too_large" });
  if (threadId === "invalid" || messageId === "invalid" || messageId === null || messageId <= 0) {
    return json(400, { ok: false, error: "bad_message_id" });
  }

  const auth = await authorize(credential, deps, chatId, threadId, { allowClosed: true });
  if (!auth.ok) return auth.response;
  if (!auth.wakeId) return json(400, { ok: false, error: "wake_id_required" });
  const wakeId = auth.wakeId;
  const scope = scopeKey(chatId, typeof threadId === "number" ? threadId : null);
  let owned = false;
  try {
    owned = await deps.store.ownsOutbound(wakeId, messageId, deps.now());
  } catch (err) {
    deps.log({ event: "outbound_record_failed", chat_id: chatId, error: err instanceof Error ? err.name : "error" });
    return json(500, { ok: false, error: "internal_error" });
  }
  if (!owned) {
    deps.log({ event: "edit_denied", chat_id: chatId, wake_id: wakeId });
    return json(403, { ok: false, error: "not_outbound" });
  }

  const parts = splitTelegramText(text);
  // A progress edit stays one bubble. Only the final answer may spill into new messages.
  if (!final && parts.length > 1) return json(413, { ok: false, error: "edit_too_long" });

  // Held across the Telegram call. A progress edit delayed by a 429 retry must
  // not run after a final edit of this same message, or it would replace the
  // delivered answer and the final slot would refuse to write it back.
  const lockToken = await acquireEditLock(deps, wakeId, messageId);
  if (!lockToken) {
    deps.log({ event: "edit_lock_timeout", chat_id: chatId, wake_id: wakeId });
    return json(409, { ok: false, error: "edit_in_progress" });
  }
  try {
  // Recheck inside the lock. `auth.closed` was read before we waited.
  const closedNow = await deps.store.isWakeClosed(wakeId, deps.now());
  if (!final && closedNow) return json(401, { ok: false, error: "wake_closed" });
  const reserved = final
    ? await reserveSend(deps, { ...auth, closed: closedNow }, chatId, true, null)
    : { ok: true as const, sendKey: null, sendTtlMs: Math.max(1000, auth.expiresAtMs - deps.now()) };
  if (!reserved.ok) return reserved.response;

  const first = parts[0] ?? "";
  const edited = await deps.telegram.editMessageText({ chat_id: chatId, message_id: messageId, text: first });
  if (!edited.ok) {
    return failSend(deps, {
      chatId,
      auth,
      scope,
      reserved,
      messageIds: [],
      sent: edited,
      remember: false,
      edit: true,
      edited: false,
    });
  }

  // A final that had to be split may be retried. Skip overflow bubbles already posted
  // when Telegram reports the first piece is unchanged. A different first piece drops
  // that checkpoint (those bubbles are already in the chat).
  let resume: number[] = [];
  let hadTail = false;
  if (final) {
    let prior: { messageId: number; overflowIds: number[] } | null;
    try {
      prior = await deps.store.getEditTail(wakeId, deps.now());
    } catch (err) {
      deps.log({ event: "outbound_record_failed", chat_id: chatId, error: err instanceof Error ? err.name : "error" });
      if (reserved.sendKey) {
        await deps.store.releaseSend(reserved.sendKey).catch(() => undefined);
      }
      return json(502, {
        ok: false,
        error: "telegram_edit_failed",
        ambiguous: false,
        edited: true,
        description: "outbound_record_failed",
        sent_parts: 1,
        message_ids: [messageId],
      });
    }
    const sameTail = edited.notModified === true && prior?.messageId === messageId;
    if (prior && sameTail) resume = prior.overflowIds;
    hadTail = prior !== null && sameTail;
    if (prior && !sameTail) {
      deps.log({ event: "edit_tail_reset", chat_id: chatId, wake_id: wakeId });
      await deps.store.setEditTail(wakeId, null, deps.now(), reserved.sendTtlMs).catch((err: unknown) => {
        deps.log({ event: "outbound_record_failed", chat_id: chatId, error: err instanceof Error ? err.name : "error" });
      });
    }
  }

  const pending = parts.slice(1 + resume.length);
  const messageIds = [messageId, ...resume];
  for (const part of pending) {
    const input: {
      chat_id: string;
      text: string;
      message_thread_id?: number;
      disable_notification?: boolean;
    } = { chat_id: chatId, text: part, disable_notification: false };
    if (typeof threadId === "number") input.message_thread_id = threadId;
    const sent = await deps.telegram.sendMessage(input);
    if (!sent.ok) {
      const definite = sent.ambiguous !== true;
      if (definite && messageIds.length > 1) {
        await deps.store.setEditTail(
          wakeId,
          { messageId, overflowIds: messageIds.slice(1) },
          deps.now(),
          reserved.sendTtlMs,
        ).catch((err: unknown) => {
          deps.log({ event: "outbound_record_failed", chat_id: chatId, error: err instanceof Error ? err.name : "error" });
        });
      }
      return failSend(deps, {
        chatId,
        auth,
        scope,
        reserved,
        messageIds,
        sent,
        remember: true,
        edited: true,
      });
    }
    messageIds.push(sent.messageId);
  }

  if (hadTail) {
    await deps.store.setEditTail(wakeId, null, deps.now(), reserved.sendTtlMs).catch((err: unknown) => {
      deps.log({ event: "outbound_record_failed", chat_id: chatId, error: err instanceof Error ? err.name : "error" });
    });
  }
  return succeedSend(deps, {
    chatId,
    auth,
    final,
    requestedWakeId: null,
    scope,
    reserved,
    messageIds,
    parts: parts.length,
    silent: !final,
    remember: true,
    via: "edit",
    notModified: edited.notModified === true,
  });
  } finally {
    await deps.store.releaseEditLock(editLockKey(wakeId, messageId), lockToken).catch((err: unknown) => {
      deps.log({ event: "edit_lock_release_failed", chat_id: chatId, error: err instanceof Error ? err.name : "error" });
    });
  }
}

/** A repeat of a send we already own. Never sends again. */
function repeatedSend(deps: AppDeps, chatId: string, wakeId: string | null, record: SendRecord): Response {
  deps.log({ event: "send_repeated", chat_id: chatId, wake_id: wakeId, state: record.state });
  if (record.state === "sent") {
    return json(200, { ok: true, already_sent: true, message_ids: record.message_ids });
  }
  // In flight, cut off mid-send, or ambiguous: it may be in the chat. Do not send it again.
  return json(409, {
    ok: false,
    ambiguous: true,
    error: record.state === "pending" ? "send_in_progress" : "previous_send_ambiguous",
    message_ids: record.message_ids,
  });
}

/** A bot message cleared typing on the clients. Re-pulse now, and renew the lease of the wake that sent it. */
async function afterMessage(deps: AppDeps, scope: string, wakeId: string | null): Promise<void> {
  try {
    await deps.typing.touch(scope, wakeId);
  } catch (err) {
    deps.log({ event: "typing_touch_failed", error: err instanceof Error ? err.name : "error" });
  }
}

/** Renew this wake's lease without sending anything. */
export async function handleTypingHeartbeat(request: Request, deps: AppDeps): Promise<Response> {
  const credential = await authenticate(request, deps);
  if (!credential.ok) return credential.response;
  const parsed = await readJson(request, deps.config.maxBodyBytes);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as SendBody;
  const chatId = normalizeId(body.chat_id);
  const threadId = normalizeOptionalInt(body.message_thread_id);
  if (!chatId) return json(400, { ok: false, error: "bad_chat_id" });
  if (threadId === "invalid") return json(400, { ok: false, error: "bad_message_id" });

  const auth = await authorize(credential, deps, chatId, threadId);
  if (!auth.ok) return auth.response;
  if (!auth.wakeId) return json(400, { ok: false, error: "wake_id_required" });
  const result = await deps.typing.touch(scopeKey(chatId, threadId), auth.wakeId);
  deps.log({ event: "typing_heartbeat", chat_id: chatId, wake_id: auth.wakeId, active: result.extended });
  return json(200, { ok: true, active: result.extended });
}

export async function handleTypingStop(request: Request, deps: AppDeps): Promise<Response> {
  const credential = await authenticate(request, deps);
  if (!credential.ok) return credential.response;
  const parsed = await readJson(request, deps.config.maxBodyBytes);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as SendBody;
  const chatId = normalizeId(body.chat_id);
  const threadId = normalizeOptionalInt(body.message_thread_id);
  if (!chatId) return json(400, { ok: false, error: "bad_chat_id" });
  if (threadId === "invalid") return json(400, { ok: false, error: "bad_message_id" });

  const auth = await authorize(credential, deps, chatId, threadId);
  if (!auth.ok) return auth.response;
  if (!auth.wakeId) {
    return json(400, { ok: false, error: "wake_id_required" });
  }
  const stopped = await deps.typing.stop(scopeKey(chatId, threadId), auth.wakeId);
  deps.log({
    event: "typing_stop",
    chat_id: chatId,
    wake_id: auth.wakeId,
    stopped: stopped.stopped,
    reason: stopped.reason,
  });
  return json(200, { ok: true, stopped: stopped.stopped, reason: stopped.reason });
}

type Credential =
  | { ok: true; kind: "token"; claims: ReplyClaims }
  | { ok: true; kind: "key" };

/** Check the bearer before reading the body, so unauthenticated callers cannot make us buffer it. */
export async function authenticate(
  request: Request,
  deps: AppDeps,
): Promise<Credential | { ok: false; response: Response }> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const bearer = match?.[1] ?? "";
  if (!bearer) return { ok: false, response: json(401, { ok: false, error: "unauthorized" }) };

  if (deps.config.replyTokenSecret && bearer.startsWith("v1.")) {
    const verified = await verifyReplyToken(deps.config.replyTokenSecret, bearer, deps.now());
    if (!verified.ok) {
      return { ok: false, response: json(401, { ok: false, error: verified.reason }) };
    }
    return { ok: true, kind: "token", claims: verified.claims };
  }

  if (deps.config.outboundApiKey && await secretsEqual(deps.config.outboundApiKey, bearer)) {
    return { ok: true, kind: "key" };
  }

  return { ok: false, response: json(401, { ok: false, error: "unauthorized" }) };
}

interface AuthorizedSend {
  wakeId: string | null;
  expiresAtMs: number;
  closed: boolean;
  /** Person the wake was for. Null on an operator send, and on tokens minted before buttons. */
  userId: string | null;
  /** True when this send is a reply to a wake, so callback buttons belong to userId. */
  bindToUser: boolean;
}

async function authorize(
  credential: Credential,
  deps: AppDeps,
  chatId: string,
  threadId: number | null,
  options: { allowClosed?: boolean } = {},
): Promise<{ ok: true } & AuthorizedSend | { ok: false; response: Response }> {
  if (credential.kind === "token") {
    const claims = credential.claims;
    if (!replyTokenScopeOk(claims, chatId, threadId)) {
      return { ok: false, response: json(403, { ok: false, error: "scope" }) };
    }
    // /send still answers a repeat of a delivered send on a closed wake; it refuses anything new itself.
    const closed = await deps.store.isWakeClosed(claims.wake_id, deps.now());
    if (closed && !options.allowClosed) {
      return { ok: false, response: json(401, { ok: false, error: "wake_closed" }) };
    }
    return {
      ok: true,
      wakeId: claims.wake_id,
      expiresAtMs: claims.exp * 1000,
      closed,
      userId: claims.user_id ?? null,
      bindToUser: true,
    };
  }

  if (!isOutboundChatAllowed(chatId, deps.config)) {
    return { ok: false, response: json(403, { ok: false, error: "not_allowlisted" }) };
  }
  return { ok: true, wakeId: null, expiresAtMs: deps.now() + 60_000, closed: false, userId: null, bindToUser: false };
}

async function keyboardFrom(
  deps: AppDeps,
  chatId: string,
  auth: AuthorizedSend,
  rows: ButtonSpec[][] | null,
): Promise<{ ok: true; markup: InlineKeyboardMarkup | null } | { ok: false; response: Response }> {
  const keyboard = await keyboardForSend({
    secret: deps.config.replyTokenSecret,
    chatId,
    ownerUserId: auth.userId,
    bindToUser: auth.bindToUser,
    rows,
    exp: Math.floor(deps.now() / 1000) + deps.config.replyTokenTtlSeconds,
  });
  if (!keyboard.ok) return { ok: false, response: json(400, { ok: false, error: keyboard.error }) };
  return { ok: true, markup: keyboard.markup };
}

async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const body = await readLimitedBody(request, maxBytes);
  if (!body.ok) return body;
  try {
    return { ok: true, value: JSON.parse(body.text) as unknown };
  } catch {
    return { ok: false, response: json(400, { ok: false, error: "bad_json" }) };
  }
}

function normalizeId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return canonicalId(String(value));
  if (typeof value === "string") return canonicalId(value);
  return null;
}

function normalizeOptionalInt(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value);
  return "invalid";
}

interface MediaCommand {
  chatId: string;
  threadId: number | null;
  replyTo: number | null;
  final: boolean;
  requestedWakeId: string | null;
  idempotencyKey: string | null;
  disableNotification: boolean | undefined;
  kind: SendMediaKind;
  caption: string;
  buttons: ButtonSpec[][] | null;
  source: { type: "url"; url: string } | { type: "file"; file: { bytes: Uint8Array; filename: string; mime: string } };
}

function mediaKind(value: unknown): SendMediaKind | null {
  return value === "photo" || value === "document" ? value : null;
}

function sharedMediaFields(body: MediaBody): { ok: true; fields: Omit<MediaCommand, "kind" | "caption" | "source"> & { kind: SendMediaKind; caption: string } } | { ok: false; response: Response } {
  const chatId = normalizeId(body.chat_id);
  const threadId = normalizeOptionalInt(body.message_thread_id);
  const replyTo = normalizeOptionalInt(body.reply_to_message_id);
  const kind = mediaKind(body.kind);
  if (!chatId) return { ok: false, response: json(400, { ok: false, error: "bad_chat_id" }) };
  if (!kind) return { ok: false, response: json(400, { ok: false, error: "bad_kind" }) };
  if (threadId === "invalid" || replyTo === "invalid") return { ok: false, response: json(400, { ok: false, error: "bad_message_id" }) };
  if (body.disable_notification !== undefined && typeof body.disable_notification !== "boolean") {
    return { ok: false, response: json(400, { ok: false, error: "bad_disable_notification" }) };
  }
  if (body.idempotency_key !== undefined && (typeof body.idempotency_key !== "string" || !IDEMPOTENCY_KEY.test(body.idempotency_key))) {
    return { ok: false, response: json(400, { ok: false, error: "bad_idempotency_key" }) };
  }
  const caption = typeof body.caption === "string" ? body.caption : "";
  if (caption.length > TELEGRAM_CAPTION_LIMIT) {
    return { ok: false, response: json(413, { ok: false, error: "caption_too_large" }) };
  }
  const parsedButtons = parseButtons(body.buttons);
  if (!parsedButtons.ok) return { ok: false, response: json(400, { ok: false, error: parsedButtons.error }) };
  const final = body.final === true;
  return {
    ok: true,
    fields: {
      chatId,
      threadId,
      replyTo,
      final,
      requestedWakeId: typeof body.wake_id === "string" && body.wake_id.length <= 80 ? body.wake_id : null,
      idempotencyKey: typeof body.idempotency_key === "string" ? body.idempotency_key : null,
      disableNotification: typeof body.disable_notification === "boolean" ? body.disable_notification : undefined,
      kind,
      caption,
      buttons: parsedButtons.rows,
    },
  };
}

async function readMediaJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: MediaCommand } | { ok: false; response: Response }> {
  const parsed = await readJson(request, maxBytes);
  if (!parsed.ok) return parsed;
  const body = parsed.value as MediaBody;
  const shared = sharedMediaFields(body);
  if (!shared.ok) return shared;
  if (typeof body.url !== "string") return { ok: false, response: json(400, { ok: false, error: "bad_media_url" }) };
  const url = normalizePublicMediaUrl(body.url);
  if (!url) return { ok: false, response: json(400, { ok: false, error: "bad_media_url" }) };
  // file_name is not a Bot API field for a URL send. Telegram names the file from the URL.
  return { ok: true, value: { ...shared.fields, source: { type: "url", url } } };
}

async function readMediaUpload(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: MediaCommand } | { ok: false; response: Response }> {
  const read = await readLimitedBytes(request, maxBytes);
  if (!read.ok) return read;
  const contentType = request.headers.get("content-type") ?? "";
  let form: FormData;
  try {
    form = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": contentType },
      body: read.bytes,
    }).formData();
  } catch {
    return { ok: false, response: json(400, { ok: false, error: "bad_multipart" }) };
  }
  const text = (name: string): string | null => {
    const value = form.get(name);
    return typeof value === "string" ? value : null;
  };
  const finalRaw = text("final");
  const notifyRaw = text("disable_notification");
  if (finalRaw !== null && finalRaw !== "" && finalRaw !== "true" && finalRaw !== "false") {
    return { ok: false, response: json(400, { ok: false, error: "bad_final" }) };
  }
  if (notifyRaw !== null && notifyRaw !== "" && notifyRaw !== "true" && notifyRaw !== "false") {
    return { ok: false, response: json(400, { ok: false, error: "bad_disable_notification" }) };
  }
  const body: MediaBody = {
    chat_id: text("chat_id") ?? undefined,
    kind: text("kind") ?? undefined,
    caption: text("caption") ?? undefined,
    file_name: text("file_name") ?? undefined,
    message_thread_id: text("message_thread_id") ?? undefined,
    reply_to_message_id: text("reply_to_message_id") ?? undefined,
    wake_id: text("wake_id") ?? undefined,
    idempotency_key: text("idempotency_key") ?? undefined,
    final: finalRaw === "true",
    ...(notifyRaw === "true" || notifyRaw === "false" ? { disable_notification: notifyRaw === "true" } : {}),
  };
  const buttonsField = text("buttons");
  if (buttonsField !== null && buttonsField !== "") {
    try {
      body.buttons = JSON.parse(buttonsField) as unknown;
    } catch {
      return { ok: false, response: json(400, { ok: false, error: "bad_buttons" }) };
    }
  }
  const shared = sharedMediaFields(body);
  if (!shared.ok) return shared;
  const uploaded = form.get("file");
  if (!(uploaded instanceof File) || uploaded.size <= 0) {
    return { ok: false, response: json(400, { ok: false, error: "bad_file" }) };
  }
  if (uploaded.size > maxBytes) return { ok: false, response: json(413, { ok: false, error: "body_too_large" }) };
  const named = cleanFileName(typeof body.file_name === "string" ? body.file_name : null)
    ?? cleanFileName(uploaded.name)
    ?? (shared.fields.kind === "photo" ? "photo.jpg" : "file");
  const bytes = new Uint8Array(await uploaded.arrayBuffer());
  const mime = typeof uploaded.type === "string" && uploaded.type.length > 0 && uploaded.type.length <= 127
    ? uploaded.type
    : "application/octet-stream";
  return {
    ok: true,
    value: {
      ...shared.fields,
      source: { type: "file", file: { bytes, filename: named, mime } },
    },
  };
}
