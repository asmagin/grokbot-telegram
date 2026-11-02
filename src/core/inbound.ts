import { classifyAddress, messageText, senderUser, topicThreadId } from "./address.js";
import { isAllowlisted } from "./allowlist.js";
import { callbackButtonText } from "./buttons.js";
import { canonicalId } from "./config.js";
import { secretsEqual, verifyCallbackData } from "./crypto.js";
import { safeErrorMessage } from "./log.js";
import { runInBackground, type AppDeps } from "./deps.js";
import { forwardToGrok } from "./grok.js";
import { json, readLimitedBody } from "./http.js";
import { buildCallbackWakeEvent, buildWakeEvent, toContextMessage } from "./payload.js";
import { MESSAGE_CLAIM_TTL_MS, rateChatKey, rateUserKey, scopeKey } from "./store.js";
import { cleanLabel, cleanText, fastGreetingReply } from "./text.js";
import { TELEGRAM_SECRET_HEADER, type TelegramMessage, type TelegramUpdate, type TypingStart } from "./types.js";

export async function handleWebhook(request: Request, deps: AppDeps): Promise<Response> {
  // Empty, too short, or outside Telegram's secret_token charset all fail closed.
  if (!deps.config.telegramWebhookSecret) {
    deps.log({ event: "webhook_rejected", reason: "not_configured" });
    return json(503, { ok: false, error: "webhook_secret_not_configured" });
  }
  const provided = request.headers.get(TELEGRAM_SECRET_HEADER) ?? "";
  const secretOk = await secretsEqual(deps.config.telegramWebhookSecret, provided);
  if (!secretOk) {
    deps.log({ event: "webhook_rejected", reason: "bad_secret" });
    return json(401, { ok: false, error: "unauthorized" });
  }

  const body = await readLimitedBody(request, deps.config.maxBodyBytes);
  if (!body.ok) {
    deps.log({ event: "webhook_rejected", reason: "body_too_large" });
    return body.response;
  }
  let update: TelegramUpdate;
  try {
    update = JSON.parse(body.text) as TelegramUpdate;
  } catch {
    deps.log({ event: "webhook_rejected", reason: "bad_json" });
    return json(400, { ok: false, error: "bad_json" });
  }
  if (!update || typeof update.update_id !== "number") {
    deps.log({ event: "webhook_rejected", reason: "bad_json" });
    return json(400, { ok: false, error: "bad_json" });
  }

  const now = deps.now();
  let claim: "new" | "duplicate";
  try {
    claim = await deps.store.claimUpdate(update.update_id, now, deps.config.dedupeTtlMs);
  } catch (err) {
    deps.log({
      event: "store_error",
      error: safeErrorMessage(err, []),
    });
    return json(500, { ok: false, error: "store_unavailable" });
  }
  if (claim === "duplicate") {
    deps.log({ event: "update_dropped", reason: "duplicate", update_id: update.update_id });
    return json(200, { ok: true });
  }

  try {
    return await handleClaimedUpdate(deps, update, now);
  } catch (err) {
    await deps.store.releaseUpdate(update.update_id).catch(() => undefined);
    deps.log({
      event: "webhook_failed",
      update_id: update.update_id,
      error: err instanceof Error ? err.name : "error",
    });
    return json(500, { ok: false, error: "internal_error" });
  }
}

async function handleClaimedUpdate(
  deps: AppDeps,
  update: TelegramUpdate,
  now: number,
): Promise<Response> {
  if (update.callback_query) return handleCallbackQuery(deps, update, now);

  if (update.channel_post || update.edited_channel_post) {
    deps.log({ event: "update_dropped", reason: "ignored_channel", update_id: update.update_id });
    return json(200, { ok: true });
  }

  const edited = Boolean(update.edited_message);
  const message = update.message ?? update.edited_message;
  if (!message?.chat || typeof message.chat.id !== "number") {
    deps.log({ event: "update_dropped", reason: "ignored_update", update_id: update.update_id });
    return json(200, { ok: true });
  }

  const chatId = String(message.chat.id);
  const sender = senderUser(message);
  const userId = sender ? String(sender.id) : null;

  if (message.migrate_to_chat_id) {
    deps.log({
      event: "update_dropped",
      reason: "chat_migrated",
      update_id: update.update_id,
      chat_id: chatId,
      migrate_to_chat_id: String(message.migrate_to_chat_id),
    });
    return json(200, { ok: true });
  }

  if (message.is_automatic_forward) {
    // A linked channel's post copied into its discussion group. Channel posts are not wakes.
    deps.log({ event: "update_dropped", reason: "ignored_automatic_forward", update_id: update.update_id, chat_id: chatId });
    return json(200, { ok: true });
  }

  if (sender?.is_bot) {
    deps.log({ event: "update_dropped", reason: "ignored_bot", update_id: update.update_id, chat_id: chatId });
    return json(200, { ok: true });
  }

  if (!isAllowlisted(userId, chatId, deps.config)) {
    deps.log({
      event: "update_dropped",
      reason: "not_allowlisted",
      update_id: update.update_id,
      chat_id: chatId,
      user_id: userId,
    });
    return json(200, { ok: true });
  }

  const threadId = topicThreadId(message);
  const scope = scopeKey(chatId, threadId);
  const contextMessage = toContextMessage(message);
  let shortTerm: Awaited<ReturnType<AppDeps["store"]["pushContext"]>> = [];
  if (contextMessage) {
    shortTerm = await deps.store.pushContext(scope, contextMessage, deps.config.contextLimit);
  }

  const address = classifyAddress(message, deps.config);
  if (!address.addressed || !address.how) {
    deps.log({
      event: "update_dropped",
      reason: "not_addressed",
      update_id: update.update_id,
      chat_id: chatId,
      user_id: userId,
    });
    return json(200, { ok: true });
  }

  const chatRate = await deps.store.hitRate(rateChatKey(chatId), now, deps.config.rateLimitWindowMs, deps.config.rateLimitMax);
  const userRate = userId
    ? await deps.store.hitRate(rateUserKey(chatId, userId), now, deps.config.rateLimitWindowMs, deps.config.rateLimitMax)
    : { allowed: true, count: 0 };
  if (!chatRate.allowed || !userRate.allowed) {
    deps.log({
      event: "update_dropped",
      reason: "rate_limited",
      update_id: update.update_id,
      chat_id: chatId,
      user_id: userId,
    });
    return json(200, { ok: true });
  }

  const greeting = deps.config.fastGreeting
    ? fastGreetingReply(messageText(message), deps.config.telegramBotUsername)
    : null;
  if (greeting) {
    if (!await claimMessage(deps, update.update_id, chatId, message.message_id, edited, now)) return json(200, { ok: true });
    deps.log({ event: "fast_greeting", update_id: update.update_id, chat_id: chatId });
    runInBackground(deps, "fast_greeting_failed", async () => {
      await deps.telegram.sendMessage({
        chat_id: chatId,
        text: greeting,
        reply_to_message_id: message.message_id,
        ...(threadId !== null ? { message_thread_id: threadId } : {}),
      });
    });
    return json(200, { ok: true });
  }

  const wake = await buildWakeEvent({
    config: deps.config,
    message,
    edited,
    updateId: update.update_id,
    addressedHow: address.how,
    command: address.command,
    shortTerm,
    nowMs: now,
  });
  if (!wake) {
    deps.log({
      event: "wake_skipped",
      level: "error",
      reason: "reply_not_configured",
      missing_or_invalid: ["REPLY_TOKEN_SECRET", "PUBLIC_BASE_URL"].filter((name) =>
        name === "REPLY_TOKEN_SECRET" ? !deps.config.replyTokenSecret : !deps.config.publicBaseUrl),
      update_id: update.update_id,
      chat_id: chatId,
    });
    return json(200, { ok: true });
  }

  if (!await claimMessage(deps, update.update_id, chatId, message.message_id, edited, now)) return json(200, { ok: true });

  // Typing is pointless once the reply token has expired, so the ceiling never outlives it.
  const tokenExpiry = Date.parse(wake.reply.expires_at);
  const session: TypingStart = {
    scopeKey: scope,
    chatId,
    threadId,
    refreshMs: deps.config.typingRefreshMs,
    wakeId: wake.reply.wake_id,
    messageId: message.message_id,
    reaction: deps.config.progressReaction,
    // Phase 3, off by default. sendMessageDraft only works in private chats.
    draft: deps.config.draftPlaceholder && message.chat.type === "private",
    startedAt: now,
    leaseMs: deps.config.typingLeaseMs,
    deadline: Number.isFinite(tokenExpiry)
      ? Math.min(now + deps.config.typingMaxMs, tokenExpiry)
      : now + deps.config.typingMaxMs,
  };

  deps.log({
    event: "wake",
    update_id: update.update_id,
    chat_id: chatId,
    user_id: userId,
    addressed_how: address.how,
    edited,
  });

  runInBackground(deps, "wake_background_failed", () => deliverWake(deps, message, session, wake, chatId, threadId, true));
  return json(200, { ok: true });
}

const TOAST_NOT_YOURS = "That button isn't for you.";
const TOAST_EXPIRED = "That button expired.";
const TOAST_TAKEN = "Already chosen.";

/**
 * A button tap. The callback_data is a signature over the chat, the owner, the
 * expiry, and the action, so a tap from another chat or person cannot wake the
 * bot. The signature does not name the message, and Telegram does not require
 * the data to be one of that message's buttons, so the token also has to appear
 * on the keyboard Telegram attached to this message. The first accepted tap
 * claims that message; a second tap does not.
 */
async function handleCallbackQuery(
  deps: AppDeps,
  update: TelegramUpdate,
  now: number,
): Promise<Response> {
  const query = update.callback_query;
  const callbackId = query && typeof query.id === "string" && query.id.length > 0 && query.id.length <= 256
    ? query.id
    : null;
  if (!query || !callbackId) {
    deps.log({ event: "update_dropped", reason: "ignored_update", update_id: update.update_id });
    return json(200, { ok: true });
  }

  const answer = (text?: string) => answerCallback(deps, callbackId, text);
  const tapper = query.from;
  const message = query.message;
  if (!tapper || typeof tapper.id !== "number" || tapper.is_bot === true) {
    await answer();
    deps.log({
      event: "update_dropped",
      reason: tapper?.is_bot ? "ignored_bot" : "ignored_update",
      update_id: update.update_id,
    });
    return json(200, { ok: true });
  }
  if (!message?.chat || typeof message.chat.id !== "number" || !Number.isSafeInteger(message.message_id)) {
    await answer();
    deps.log({ event: "update_dropped", reason: "ignored_update", update_id: update.update_id });
    return json(200, { ok: true });
  }

  const chatId = canonicalId(String(message.chat.id));
  const userId = canonicalId(String(tapper.id));
  if (!chatId || !userId) {
    await answer();
    deps.log({ event: "update_dropped", reason: "ignored_update", update_id: update.update_id, chat_id: chatId });
    return json(200, { ok: true });
  }
  if (!isAllowlisted(userId, chatId, deps.config)) {
    await answer();
    deps.log({
      event: "update_dropped",
      reason: "not_allowlisted",
      update_id: update.update_id,
      chat_id: chatId,
      user_id: userId,
    });
    return json(200, { ok: true });
  }

  const data = typeof query.data === "string" ? query.data : "";
  if (!deps.config.replyTokenSecret || data.length < 1 || data.length > 64) {
    await answer();
    deps.log({
      event: "update_dropped",
      reason: deps.config.replyTokenSecret ? "callback_malformed" : "reply_not_configured",
      level: deps.config.replyTokenSecret ? "info" : "error",
      update_id: update.update_id,
      chat_id: chatId,
      user_id: userId,
    });
    return json(200, { ok: true });
  }

  const verified = await verifyCallbackData(deps.config.replyTokenSecret, data, { chatId, userId, nowMs: now });
  if (!verified.ok) {
    const reason = verified.reason === "expired"
      ? "callback_expired"
      : verified.reason === "bad_signature" ? "callback_rejected" : "callback_malformed";
    const toast = reason === "callback_expired" ? TOAST_EXPIRED : reason === "callback_rejected" ? TOAST_NOT_YOURS : undefined;
    await answer(toast);
    deps.log({ event: "update_dropped", reason, update_id: update.update_id, chat_id: chatId, user_id: userId });
    return json(200, { ok: true });
  }
  // Data we sign is already free of control characters. Anything else is not a token we issued.
  if (cleanText(verified.data, 64) !== verified.data) {
    await answer();
    deps.log({ event: "update_dropped", reason: "callback_malformed", update_id: update.update_id, chat_id: chatId, user_id: userId });
    return json(200, { ok: true });
  }

  // A valid token from another keyboard in this chat must not wake or claim this message.
  const rawLabel = callbackButtonText(message.reply_markup, data);
  if (rawLabel === null) {
    await answer();
    deps.log({
      event: "update_dropped",
      reason: "callback_not_on_message",
      update_id: update.update_id,
      chat_id: chatId,
      user_id: userId,
      message_id: message.message_id,
    });
    return json(200, { ok: true });
  }

  const chatRate = await deps.store.hitRate(rateChatKey(chatId), now, deps.config.rateLimitWindowMs, deps.config.rateLimitMax);
  const userRate = await deps.store.hitRate(rateUserKey(chatId, userId), now, deps.config.rateLimitWindowMs, deps.config.rateLimitMax);
  if (!chatRate.allowed || !userRate.allowed) {
    await answer();
    deps.log({
      event: "update_dropped",
      reason: "rate_limited",
      update_id: update.update_id,
      chat_id: chatId,
      user_id: userId,
    });
    return json(200, { ok: true });
  }

  const threadId = topicThreadId(message);
  const label = cleanLabel(rawLabel, 64) || verified.data;
  const wake = await buildCallbackWakeEvent({
    config: deps.config,
    chat: message.chat,
    threadId,
    from: tapper,
    messageId: message.message_id,
    date: typeof message.date === "number" ? message.date : null,
    messageText: messageText(message),
    label,
    data: verified.data,
    updateId: update.update_id,
    nowMs: now,
  });
  if (!wake) {
    await answer();
    deps.log({
      event: "wake_skipped",
      level: "error",
      reason: "reply_not_configured",
      update_id: update.update_id,
      chat_id: chatId,
    });
    return json(200, { ok: true });
  }

  const ttlMs = Math.max(1000, verified.exp * 1000 - now);
  const claim = await deps.store.claimCallback(chatId, message.message_id, now, ttlMs);
  if (claim === "duplicate") {
    await answer(TOAST_TAKEN);
    await clearKeyboard(deps, chatId, message.message_id);
    deps.log({
      event: "update_dropped",
      reason: "callback_duplicate",
      update_id: update.update_id,
      chat_id: chatId,
      user_id: userId,
      message_id: message.message_id,
    });
    return json(200, { ok: true });
  }

  await answer();
  await clearKeyboard(deps, chatId, message.message_id);

  const scope = scopeKey(chatId, threadId);
  const tokenExpiry = Date.parse(wake.reply.expires_at);
  // No reaction on the bot's own message. Typing is the acknowledgement; the callback answer stops the spinner.
  const session: TypingStart = {
    scopeKey: scope,
    chatId,
    threadId,
    refreshMs: deps.config.typingRefreshMs,
    wakeId: wake.reply.wake_id,
    messageId: null,
    reaction: null,
    draft: false,
    startedAt: now,
    leaseMs: deps.config.typingLeaseMs,
    deadline: Number.isFinite(tokenExpiry)
      ? Math.min(now + deps.config.typingMaxMs, tokenExpiry)
      : now + deps.config.typingMaxMs,
  };
  deps.log({
    event: "wake",
    update_id: update.update_id,
    chat_id: chatId,
    user_id: userId,
    addressed_how: "callback",
    edited: false,
    message_id: message.message_id,
  });
  runInBackground(deps, "wake_background_failed", () => deliverWake(deps, message, session, wake, chatId, threadId, false));
  return json(200, { ok: true });
}

async function answerCallback(deps: AppDeps, callbackId: string, text?: string): Promise<void> {
  try {
    const result = await deps.telegram.answerCallbackQuery(text ? { callback_query_id: callbackId, text } : { callback_query_id: callbackId });
    if (!result.ok) deps.log({ event: "callback_answer_failed", status: result.status });
  } catch (err) {
    deps.log({ event: "callback_answer_failed", error: err instanceof Error ? err.name : "error" });
  }
}

async function clearKeyboard(deps: AppDeps, chatId: string, messageId: number): Promise<void> {
  try {
    const result = await deps.telegram.editMessageReplyMarkup({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
    if (!result.ok) deps.log({ event: "callback_keyboard_clear_failed", chat_id: chatId, status: result.status });
  } catch (err) {
    deps.log({ event: "callback_keyboard_clear_failed", chat_id: chatId, error: err instanceof Error ? err.name : "error" });
  }
}

/**
 * One Telegram message starts at most one wake. update_id dedupe covers
 * redelivery of the same update; this covers the same message arriving again
 * under another update_id, and edits: an edit of a message that already woke
 * the bot is ignored, and an edit of one that never did may wake it once.
 */
async function claimMessage(
  deps: AppDeps,
  updateId: number,
  chatId: string,
  messageId: number,
  edited: boolean,
  now: number,
): Promise<boolean> {
  const claim = await deps.store.claimMessage(chatId, messageId, now, MESSAGE_CLAIM_TTL_MS);
  if (claim === "new") return true;
  deps.log(edited
    ? { event: "edit_ignored", update_id: updateId, chat_id: chatId, message_id: messageId }
    : { event: "update_dropped", reason: "duplicate_message", update_id: updateId, chat_id: chatId, message_id: messageId });
  return false;
}

async function deliverWake(
  deps: AppDeps,
  message: TelegramMessage,
  session: TypingStart,
  wake: NonNullable<Awaited<ReturnType<typeof buildWakeEvent>>>,
  chatId: string,
  threadId: number | null,
  ack: boolean,
): Promise<void> {
  // Reaction, typing and the optional ack are cosmetic. A failure there must not stop the wake.
  try {
    await deps.typing.start(session);
  } catch (err) {
    deps.log({ event: "typing_failed", chat_id: chatId, error: safeErrorMessage(err, []) });
  }
  if (ack && deps.config.bridgeAck) {
    deps.log({ event: "bridge_ack", chat_id: chatId, update_id: wake.update_id });
    await deps.telegram.sendMessage({
      chat_id: chatId,
      text: "On it.",
      reply_to_message_id: message.message_id,
      ...(threadId !== null ? { message_thread_id: threadId } : {}),
    });
    // Telegram clears typing when the bot posts.
    await deps.typing.touch(session.scopeKey, null).catch(() => undefined);
  }
  const forwarded = await forwardToGrok(deps.config, wake, deps.fetchImpl);
  deps.log({
    event: "forward",
    update_id: wake.update_id,
    chat_id: chatId,
    status: forwarded.status,
    reason: forwarded.reason,
    ok: forwarded.ok,
  });
  if (forwarded.ok) return;
  if (forwarded.ambiguous) {
    // The routine may be working on it. Keep typing and the 👀 (the lease ends them), say nothing,
    // and never retry: a second POST could wake it twice.
    deps.log({
      event: "forward_ambiguous",
      update_id: wake.update_id,
      chat_id: chatId,
      status: forwarded.status,
      wake_id: wake.reply.wake_id,
    });
    return;
  }
  // Definitely not accepted, so nobody is going to reply. Do not leave typing or the reaction up.
  await deps.typing.stop(session.scopeKey, session.wakeId).catch(() => undefined);
  // deliverWake runs once per wake (update_id is deduped first), so this line is sent at most once.
  const text = deps.config.forwardFailureText;
  if (!text) return;
  const sent = await deps.telegram.sendMessage({
    chat_id: chatId,
    text,
    reply_to_message_id: message.message_id,
    disable_notification: true,
    ...(threadId !== null ? { message_thread_id: threadId } : {}),
  });
  deps.log({ event: "forward_failure_notice", chat_id: chatId, update_id: wake.update_id, ok: sent.ok });
  // Another wake in this chat may still be working; the notice just cleared its typing.
  if (sent.ok) await deps.typing.touch(session.scopeKey, null).catch(() => undefined);
}
