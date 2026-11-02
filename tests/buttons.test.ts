import { describe, expect, it } from "vitest";
import { MAX_BUTTON_DATA_BYTES, normalizeButtonUrl, parseButtons } from "../src/core/buttons.js";
import { signCallbackData, signReplyToken, verifyCallbackData, verifyReplyToken } from "../src/core/crypto.js";
import { handleRequest } from "../src/core/handler.js";
import type { InlineKeyboardMarkup, WakeEvent } from "../src/core/types.js";
import { createTestApp, dmUpdate, groupUpdate, NOW, postUpdate, testEnv, webhookRequest } from "./helpers.js";

const SECRET = "reply-token-secret-for-tests-only-0123456789";

function wakes(calls: { url: string; body: unknown }[]): WakeEvent[] {
  return calls.filter((call) => call.url.startsWith("https://grok.example/hook")).map((call) => call.body as WakeEvent);
}

function callsEnding(calls: { url: string; body: unknown }[], method: string): { url: string; body: unknown }[] {
  return calls.filter((call) => call.url.endsWith(`/${method}`));
}

async function repliedToken(app: ReturnType<typeof createTestApp>): Promise<WakeEvent> {
  await postUpdate(app.deps, app.tasks, dmUpdate("deploy?", 1));
  const wake = wakes(app.calls).at(-1);
  if (!wake) throw new Error("no wake");
  return wake;
}

describe("button limits", () => {
  it("accepts callback and url buttons and rejects the shapes that do not fit", () => {
    expect(parseButtons(undefined)).toEqual({ ok: true, rows: null });
    expect(parseButtons([])).toEqual({ ok: true, rows: null });
    const ok = parseButtons([
      [{ text: "Approve", data: "approve" }, { text: "Cancel", data: "cancel" }],
      [{ text: "Docs", url: "https://example.com/docs#top" }],
    ]);
    expect(ok).toEqual({
      ok: true,
      rows: [
        [{ type: "callback", text: "Approve", data: "approve" }, { type: "callback", text: "Cancel", data: "cancel" }],
        [{ type: "url", text: "Docs", url: "https://example.com/docs#top" }],
      ],
    });
    expect(parseButtons([[{ text: "X", data: "a".repeat(MAX_BUTTON_DATA_BYTES) }]]).ok).toBe(true);
    expect(parseButtons([[{ text: "X", data: "a".repeat(MAX_BUTTON_DATA_BYTES + 1) }]])).toEqual({
      ok: false,
      error: "button_data_too_long",
    });
    expect(parseButtons([[{ text: "X", url: "http://example.com" }]])).toEqual({ ok: false, error: "bad_button_url" });
    expect(parseButtons([[{ text: "X", data: "ok", url: "https://example.com" }]])).toEqual({ ok: false, error: "bad_buttons" });
    expect(parseButtons([[{ text: "X" }]])).toEqual({ ok: false, error: "bad_buttons" });
    expect(parseButtons([[{ text: "ok\nthere", data: "x" }]])).toEqual({ ok: false, error: "bad_buttons" });
    expect(parseButtons([Array.from({ length: 9 }, () => ({ text: "A", data: "a" }))])).toEqual({ ok: false, error: "bad_buttons" });
    expect(normalizeButtonUrl("https://user:pass@example.com/a")).toBeNull();
    expect(normalizeButtonUrl("https://127.0.0.1/a")).toBeNull();
    expect(normalizeButtonUrl("https://api.telegram.org/bot")).toBeNull();
  });
});

describe("signed callback data", () => {
  const exp = Math.floor(NOW / 1000) + 1800;

  it("fits in 64 bytes and verifies only for the chat and owner it was signed for", async () => {
    const data = "a".repeat(MAX_BUTTON_DATA_BYTES);
    const token = await signCallbackData(SECRET, { version: 1, chatId: "42", userId: "42", exp, data });
    expect(token).not.toBeNull();
    expect(new TextEncoder().encode(token ?? "").length).toBeLessThanOrEqual(64);
    expect(await verifyCallbackData(SECRET, token ?? "", { chatId: "42", userId: "42", nowMs: NOW })).toMatchObject({
      ok: true,
      version: 1,
      data,
    });
    expect(await verifyCallbackData(SECRET, token ?? "", { chatId: "42", userId: "7", nowMs: NOW })).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verifyCallbackData(SECRET, token ?? "", { chatId: "-500", userId: "42", nowMs: NOW })).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verifyCallbackData(SECRET, token ?? "", { chatId: "42", userId: "42", nowMs: exp * 1000 })).toMatchObject({
      ok: false,
      reason: "expired",
    });
    expect(await verifyCallbackData(SECRET, "approve", { chatId: "42", userId: "42", nowMs: NOW })).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    const flipped = `${token?.slice(0, -1)}${token?.endsWith("A") ? "B" : "A"}`;
    expect(await verifyCallbackData(SECRET, flipped, { chatId: "42", userId: "42", nowMs: NOW })).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("lets any allowlisted tapper open a chat-bound token", async () => {
    const token = await signCallbackData(SECRET, { version: 2, chatId: "-500", userId: "", exp, data: "approve" });
    expect(await verifyCallbackData(SECRET, token ?? "", { chatId: "-500", userId: "99", nowMs: NOW })).toMatchObject({
      ok: true,
      version: 2,
      data: "approve",
    });
  });
});

describe("sending keyboards", () => {
  it("puts a signed keyboard on the last bubble and binds it to the wake's sender", async () => {
    const app = createTestApp();
    const wake = await repliedToken(app);
    const verified = await verifyReplyToken(SECRET, wake.reply.token, NOW);
    expect(verified.ok && verified.claims.user_id).toBe("42");
    const response = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers: { authorization: `Bearer ${wake.reply.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "42",
        text: `${"x".repeat(4097)}`,
        reply_to_message_id: wake.message.message_id,
        final: true,
        buttons: [[{ text: "Approve", data: "approve" }, { text: "Cancel", data: "cancel" }]],
      }),
    }), app.deps);
    expect(response.status).toBe(200);
    const sent = callsEnding(app.calls, "sendMessage");
    expect(sent).toHaveLength(2);
    expect(sent[0]?.body).not.toHaveProperty("reply_markup");
    const markup = (sent[1]?.body as { reply_markup?: InlineKeyboardMarkup }).reply_markup;
    expect(markup?.inline_keyboard[0]?.map((button) => button.text)).toEqual(["Approve", "Cancel"]);
    const callbackData = markup?.inline_keyboard[0]?.[0]?.callback_data ?? "";
    expect(callbackData).not.toBe("approve");
    expect(await verifyCallbackData(SECRET, callbackData, { chatId: "42", userId: "42", nowMs: NOW })).toMatchObject({
      ok: true,
      data: "approve",
    });
    expect(await verifyCallbackData(SECRET, callbackData, { chatId: "42", userId: "7", nowMs: NOW })).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a callback keyboard when the reply token has no user, and still allows a url button", async () => {
    const app = createTestApp();
    const token = await signReplyToken(SECRET, {
      v: 1,
      chat_id: "42",
      thread_id: null,
      wake_id: "wake-old",
      exp: Math.floor(NOW / 1000) + 1800,
    });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const denied = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers,
      body: JSON.stringify({ chat_id: "42", text: "Choose", buttons: [[{ text: "Approve", data: "approve" }]] }),
    }), app.deps);
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ error: "buttons_require_user" });
    const linked = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers,
      body: JSON.stringify({ chat_id: "42", text: "Docs", buttons: [[{ text: "Docs", url: "https://example.com/docs" }]] }),
    }), app.deps);
    expect(linked.status).toBe(200);
    const markup = (callsEnding(app.calls, "sendMessage").at(-1)?.body as { reply_markup: InlineKeyboardMarkup }).reply_markup;
    expect(markup.inline_keyboard[0]?.[0]).toEqual({ text: "Docs", url: "https://example.com/docs" });
  });

  it("attaches the keyboard to a photo and to an uploaded document", async () => {
    const app = createTestApp();
    const wake = await repliedToken(app);
    const headers = { authorization: `Bearer ${wake.reply.token}`, "content-type": "application/json" };
    const photo = await handleRequest(new Request("https://bridge.example/send/media", {
      method: "POST",
      headers,
      body: JSON.stringify({
        chat_id: "42",
        kind: "photo",
        url: "https://cdn.example/plot.png",
        caption: "Ship this build?",
        buttons: [[{ text: "Approve", data: "approve" }]],
      }),
    }), app.deps);
    expect(photo.status).toBe(200);
    const photoBody = callsEnding(app.calls, "sendPhoto").at(-1)?.body as { reply_markup?: InlineKeyboardMarkup; caption?: string };
    expect(photoBody.caption).toBe("Ship this build?");
    expect(photoBody.reply_markup?.inline_keyboard[0]?.[0]?.text).toBe("Approve");

    const form = new FormData();
    form.set("chat_id", "42");
    form.set("kind", "document");
    form.set("file", new File([Uint8Array.from([1])], "notes.txt", { type: "text/plain" }));
    form.set("buttons", JSON.stringify([[{ text: "Approve", data: "approve" }]]));
    const uploaded = await handleRequest(new Request("https://bridge.example/send/media", {
      method: "POST",
      headers: { authorization: `Bearer ${wake.reply.token}` },
      body: form,
    }), app.deps);
    expect(uploaded.status).toBe(200);
    const sent = callsEnding(app.calls, "sendDocument").at(-1)?.body as FormData;
    expect(JSON.parse(String(sent.get("reply_markup")))).toMatchObject({
      inline_keyboard: [[{ text: "Approve" }]],
    });
  });
});

describe("callback queries", () => {
  it("wakes once for the owner's Approve tap in a private chat and ignores a second tap", async () => {
    const app = createTestApp();
    const wake = await repliedToken(app);
    const sent = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers: { authorization: `Bearer ${wake.reply.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "42",
        text: "Deploy the preview?",
        final: true,
        buttons: [[{ text: "Approve", data: "approve" }, { text: "Cancel", data: "cancel" }]],
      }),
    }), app.deps);
    expect(sent.status).toBe(200);
    const ids = (await sent.json() as { message_ids: number[] }).message_ids;
    const messageId = ids[0] ?? 0;
    const markup = (callsEnding(app.calls, "sendMessage").at(-1)?.body as { reply_markup: InlineKeyboardMarkup }).reply_markup;
    const approve = markup.inline_keyboard[0]?.[0];
    expect(approve?.text).toBe("Approve");
    const before = wakes(app.calls).length;

    const tap = callbackUpdate({
      updateId: 50,
      data: approve?.callback_data ?? "",
      messageId,
      text: "Deploy the preview?",
      buttonText: "Approve",
    });
    const first = await postUpdate(app.deps, app.tasks, tap);
    expect(first.status).toBe(200);
    const callbackWakes = wakes(app.calls).slice(before);
    expect(callbackWakes).toHaveLength(1);
    const event = callbackWakes[0];
    expect(event?.addressed_how).toBe("callback");
    expect(event?.schema_version).toBe(4);
    expect(event?.edited).toBe(false);
    expect(event?.from?.id).toBe("42");
    expect(event?.chat).toMatchObject({ id: "42", type: "private" });
    expect(event?.message.message_id).toBe(messageId);
    expect(event?.message.text).toBe("Approve");
    expect(event?.callback).toEqual({
      data: "approve",
      text: "Approve",
      message_id: messageId,
      message_text: "Deploy the preview?",
    });
    expect(event?.reply.wake_id).not.toBe(wake.reply.wake_id);
    const reply = await verifyReplyToken(SECRET, event?.reply.token ?? "", NOW);
    expect(reply.ok && reply.claims.user_id).toBe("42");
    expect(reply.ok && reply.claims.chat_id).toBe("42");

    const answers = callsEnding(app.calls, "answerCallbackQuery");
    expect(answers.at(-1)?.body).toEqual({ callback_query_id: "cq-50" });
    expect(callsEnding(app.calls, "editMessageReplyMarkup").at(-1)?.body).toEqual({
      chat_id: "42",
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
    const reactions = callsEnding(app.calls, "setMessageReaction").map((call) => call.body as { message_id?: number });
    expect(reactions.some((reaction) => reaction.message_id === messageId)).toBe(false);

    const again = await postUpdate(app.deps, app.tasks, callbackUpdate({
      updateId: 51,
      data: approve?.callback_data ?? "",
      messageId,
      text: "Deploy the preview?",
      buttonText: "Approve",
    }));
    expect(again.status).toBe(200);
    expect(wakes(app.calls)).toHaveLength(before + 1);
    expect(callsEnding(app.calls, "answerCallbackQuery").at(-1)?.body).toEqual({
      callback_query_id: "cq-51",
      text: "Already chosen.",
    });
  });

  it("toasts a different person, drops a forged or cross-chat tap, and still enforces the allowlist", async () => {
    const app = createTestApp();
    await postUpdate(app.deps, app.tasks, groupUpdate({
      text: "@testbot choose",
      updateId: 2,
      entities: [{ type: "mention", offset: 0, length: 8 }],
    }));
    const wake = wakes(app.calls).at(-1);
    expect(wake?.chat.id).toBe("-500");
    const sent = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers: { authorization: `Bearer ${wake?.reply.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "-500",
        text: "Deploy the preview?",
        final: true,
        buttons: [[{ text: "Approve", data: "approve" }]],
      }),
    }), app.deps);
    expect(sent.status).toBe(200);
    const messageId = ((await sent.json()) as { message_ids: number[] }).message_ids[0] ?? 0;
    const callbackData = ((callsEnding(app.calls, "sendMessage").at(-1)?.body as { reply_markup: InlineKeyboardMarkup })
      .reply_markup.inline_keyboard[0]?.[0]?.callback_data) ?? "";
    const before = wakes(app.calls).length;

    const stranger = await postUpdate(app.deps, app.tasks, callbackUpdate({
      updateId: 60,
      data: callbackData,
      messageId,
      chatId: -500,
      chatType: "supergroup",
      userId: 99,
      text: "Deploy the preview?",
      buttonText: "Approve",
    }));
    expect(stranger.status).toBe(200);
    expect(wakes(app.calls)).toHaveLength(before);
    expect(callsEnding(app.calls, "answerCallbackQuery").at(-1)?.body).toMatchObject({ text: "That button isn't for you." });

    const forged = await postUpdate(app.deps, app.tasks, callbackUpdate({
      updateId: 61,
      data: "approve",
      messageId,
      chatId: -500,
      chatType: "supergroup",
      userId: 42,
      text: "Deploy the preview?",
      buttonText: "Approve",
    }));
    expect(forged.status).toBe(200);
    expect(wakes(app.calls)).toHaveLength(before);
    expect(callsEnding(app.calls, "answerCallbackQuery").at(-1)?.body).toEqual({ callback_query_id: "cq-61" });

    const replay = await postUpdate(app.deps, app.tasks, callbackUpdate({
      updateId: 62,
      data: callbackData,
      messageId,
      chatId: 42,
      userId: 42,
      text: "Deploy the preview?",
      buttonText: "Approve",
    }));
    expect(replay.status).toBe(200);
    expect(wakes(app.calls)).toHaveLength(before);
    expect(callsEnding(app.calls, "answerCallbackQuery").at(-1)?.body).toMatchObject({ text: "That button isn't for you." });

    const outsider = await handleRequest(webhookRequest(callbackUpdate({
      updateId: 63,
      data: callbackData,
      messageId,
      chatId: 7,
      userId: 7,
      text: "Deploy the preview?",
      buttonText: "Approve",
    })), app.deps);
    await Promise.all(app.tasks.splice(0));
    expect(outsider.status).toBe(200);
    expect(wakes(app.calls)).toHaveLength(before);
    expect(callsEnding(app.calls, "answerCallbackQuery").at(-1)?.body).toEqual({ callback_query_id: "cq-63" });

    const owner = await postUpdate(app.deps, app.tasks, callbackUpdate({
      updateId: 64,
      data: callbackData,
      messageId,
      chatId: -500,
      chatType: "supergroup",
      userId: 42,
      text: "Deploy the preview?",
      buttonText: "Approve",
      threadId: 15,
    }));
    expect(owner.status).toBe(200);
    const tap = wakes(app.calls).at(-1);
    expect(tap?.addressed_how).toBe("callback");
    expect(tap?.from?.id).toBe("42");
    expect(tap?.chat.id).toBe("-500");
    expect(tap?.callback?.data).toBe("approve");
    // The original send was not in a topic, so a topic flag on the tap is what the message carried.
    expect(tap?.reply.message_thread_id).toBe(15);
  });

  it("lets any allowlisted member tap a keyboard sent with the outbound key", async () => {
    const app = createTestApp({ env: testEnv({ OUTBOUND_API_KEY: "outbound-key-0123456789abcdef0123456789" }) });
    const sent = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers: { authorization: "Bearer outbound-key-0123456789abcdef0123456789", "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "-500",
        text: "Take the ticket?",
        buttons: [[{ text: "Approve", data: "approve" }]],
      }),
    }), app.deps);
    expect(sent.status).toBe(200);
    const messageId = ((await sent.json()) as { message_ids: number[] }).message_ids[0] ?? 0;
    const callbackData = ((callsEnding(app.calls, "sendMessage").at(-1)?.body as { reply_markup: InlineKeyboardMarkup })
      .reply_markup.inline_keyboard[0]?.[0]?.callback_data) ?? "";
    expect(await verifyCallbackData(SECRET, callbackData, { chatId: "-500", userId: "99", nowMs: NOW })).toMatchObject({
      ok: true,
      version: 2,
      data: "approve",
    });
    await postUpdate(app.deps, app.tasks, callbackUpdate({
      updateId: 70,
      data: callbackData,
      messageId,
      chatId: -500,
      chatType: "supergroup",
      userId: 99,
      text: "Take the ticket?",
      buttonText: "Approve",
    }));
    const tap = wakes(app.calls).at(-1);
    expect(tap?.from?.id).toBe("99");
    expect(tap?.callback).toMatchObject({ data: "approve", text: "Approve", message_text: "Take the ticket?" });
  });
});

function callbackUpdate(options: {
  updateId: number;
  data: string;
  messageId: number;
  text: string;
  buttonText: string;
  userId?: number;
  chatId?: number;
  chatType?: string;
  threadId?: number;
}): unknown {
  return {
    update_id: options.updateId,
    callback_query: {
      id: `cq-${options.updateId}`,
      from: { id: options.userId ?? 42, is_bot: false, first_name: "Ada", username: "ada" },
      data: options.data,
      message: {
        message_id: options.messageId,
        date: 1_700_000_100,
        text: options.text,
        from: { id: 999, is_bot: true, first_name: "Bot" },
        chat: { id: options.chatId ?? 42, type: options.chatType ?? "private" },
        ...(options.threadId !== undefined ? { message_thread_id: options.threadId, is_topic_message: true } : {}),
        reply_markup: {
          inline_keyboard: [[{ text: options.buttonText, callback_data: options.data }]],
        },
      },
    },
  };
}
