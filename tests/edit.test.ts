import { describe, expect, it } from "vitest";
import { buildDeps } from "../src/core/deps.js";
import { handleRequest } from "../src/core/handler.js";
import { scopeKey } from "../src/core/store.js";
import { TELEGRAM_TEXT_LIMIT } from "../src/core/types.js";
import {
  createFetchMock,
  defaultResponse,
  dmUpdate,
  groupUpdate,
  NOW,
  postUpdate,
  testEnv,
  type RecordedCall,
} from "./helpers.js";

interface Reply {
  token: string;
  wake_id: string;
  chat_id: string;
  edit_url: string;
  send_url: string;
}

function app(options: {
  env?: Record<string, string>;
  handler?: (call: RecordedCall) => Response | Promise<Response> | undefined;
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  const mock = createFetchMock(async (call) => {
    const custom = await options.handler?.(call);
    return custom ?? defaultResponse(call, mock.calls.length);
  });
  const tasks: Promise<unknown>[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps = buildDeps({
    env: options.env ?? testEnv(),
    fetchImpl: mock.fetchImpl,
    now: () => NOW,
    sleep: options.sleep ?? (async () => undefined),
    waitUntil: (promise) => tasks.push(promise),
    typingMode: "once",
    log: (event) => logs.push(event),
  });
  return {
    deps,
    tasks,
    calls: mock.calls,
    logs,
    telegram: (method: string) => mock.calls.filter((call) => call.url.endsWith(`/${method}`)),
    replies: () => mock.calls
      .filter((call) => call.url.startsWith("https://grok.example/hook"))
      .map((call) => (call.body as { reply: Reply }).reply),
    async send(reply: Reply, body: Record<string, unknown>, path = "/send"): Promise<Response> {
      return handleRequest(new Request(`https://bridge.example${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${reply.token}`, "content-type": "application/json" },
        body: JSON.stringify({ chat_id: reply.chat_id, ...body }),
      }), deps);
    },
  };
}

function methodOf(call: RecordedCall): string {
  return call.url.slice(call.url.lastIndexOf("/") + 1);
}

describe("POST /send/edit", () => {
  it("returns message ids from /send and edits that bubble without a second message", async () => {
    const bridge = app();
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("long job", 1));
    const reply = bridge.replies()[0]!;
    expect(reply.edit_url).toBe("https://bridge.example/send/edit");
    const progress = await bridge.send(reply, { text: "Pulling the numbers, about two minutes." });
    const posted = await progress.json() as { ok: boolean; message_ids: number[] };
    expect(posted.ok).toBe(true);
    expect(posted.message_ids).toHaveLength(1);
    const messageId = posted.message_ids[0]!;

    const mark = bridge.calls.length;
    const edited = await bridge.send(reply, { message_id: messageId, text: "Still pulling, one more minute." }, "/send/edit");
    expect(edited.status).toBe(200);
    expect(await edited.json()).toEqual({ ok: true, message_ids: [messageId] });
    const after = bridge.calls.slice(mark);
    expect(after.map(methodOf)).toEqual(["editMessageText", "sendChatAction"]);
    expect(after[0]?.body).toEqual({ chat_id: "42", message_id: messageId, text: "Still pulling, one more minute." });
    expect(bridge.telegram("sendMessage")).toHaveLength(1);
    expect(bridge.telegram("setMessageReaction")).toHaveLength(1);
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).not.toBeNull();
  });

  it("treats a final edit as the final reply and ignores a repeat", async () => {
    const bridge = app();
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("long job", 1));
    const reply = bridge.replies()[0]!;
    const progress = await bridge.send(reply, { text: "On it, about a minute." });
    const messageId = (await progress.json() as { message_ids: number[] }).message_ids[0]!;

    const mark = bridge.calls.length;
    const final = await bridge.send(reply, { message_id: messageId, text: "Sunny.", final: true }, "/send/edit");
    expect(final.status).toBe(200);
    expect(await final.json()).toEqual({ ok: true, message_ids: [messageId] });
    const after = bridge.calls.slice(mark).map(methodOf);
    expect(after).toEqual(["editMessageText", "setMessageReaction"]);
    expect(bridge.calls.at(-1)?.body).toEqual({ chat_id: "42", message_id: 11, reaction: [], is_big: false });
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).toBeNull();
    expect(bridge.logs).toContainEqual(expect.objectContaining({ event: "edit", final: true, wake_id: reply.wake_id }));

    const again = await bridge.send(reply, { message_id: messageId, text: "Sunny.", final: true }, "/send/edit");
    expect(await again.json()).toEqual({ ok: true, already_sent: true, message_ids: [messageId] });
    expect(bridge.telegram("editMessageText")).toHaveLength(1);

    const late = await bridge.send(reply, { text: "another" });
    expect(late.status).toBe(401);
    expect(await late.json()).toMatchObject({ error: "wake_closed" });
  });

  it("edits the first part of a long final answer and sends the rest", async () => {
    const bridge = app();
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("long job", 1));
    const reply = bridge.replies()[0]!;
    const progress = await bridge.send(reply, { text: "Working." });
    const messageId = (await progress.json() as { message_ids: number[] }).message_ids[0]!;
    const text = `${"a".repeat(TELEGRAM_TEXT_LIMIT)}TAIL`;
    const final = await bridge.send(reply, { message_id: messageId, text, final: true }, "/send/edit");
    expect(final.status).toBe(200);
    const body = await final.json() as { message_ids: number[] };
    expect(body.message_ids[0]).toBe(messageId);
    expect(body.message_ids).toHaveLength(2);
    expect(bridge.telegram("editMessageText")[0]?.body).toMatchObject({
      message_id: messageId,
      text: "a".repeat(TELEGRAM_TEXT_LIMIT),
    });
    expect(bridge.telegram("sendMessage").at(-1)?.body).toMatchObject({ text: "TAIL", disable_notification: false });
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).toBeNull();
  });

  it("resumes a split final after a definite overflow failure without posting the tail twice", async () => {
    let failOverflow = true;
    let seen = "";
    const bridge = app({
      handler: (call) => {
        if (call.url.endsWith("/editMessageText")) {
          const text = (call.body as { text?: string }).text ?? "";
          if (text === seen) {
            return Response.json({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }, { status: 400 });
          }
          seen = text;
          return undefined;
        }
        if (failOverflow && call.url.endsWith("/sendMessage") && (call.body as { text?: string }).text === "END") {
          return Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 });
        }
        return undefined;
      },
    });
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("long job", 1));
    const reply = bridge.replies()[0]!;
    const progress = await bridge.send(reply, { text: "Working." });
    const messageId = (await progress.json() as { message_ids: number[] }).message_ids[0]!;
    const middle = "b".repeat(TELEGRAM_TEXT_LIMIT);
    const text = `${"a".repeat(TELEGRAM_TEXT_LIMIT)}${middle}END`;
    const failed = await bridge.send(reply, { message_id: messageId, text, final: true }, "/send/edit");
    expect(failed.status).toBe(502);
    const failedBody = await failed.json() as { message_ids: number[]; edited: boolean };
    expect(failedBody.edited).toBe(true);
    expect(failedBody.message_ids[0]).toBe(messageId);
    expect(failedBody.message_ids).toHaveLength(2);
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).not.toBeNull();

    failOverflow = false;
    const retried = await bridge.send(reply, { message_id: messageId, text, final: true }, "/send/edit");
    expect(retried.status).toBe(200);
    const body = await retried.json() as { message_ids: number[]; not_modified?: boolean };
    expect(body.not_modified).toBe(true);
    expect(body.message_ids).toHaveLength(3);
    expect(body.message_ids[0]).toBe(messageId);
    const sentText = (call: { body: unknown }) => (call.body as { text?: string }).text;
    expect(bridge.telegram("sendMessage").filter((call) => sentText(call) === middle)).toHaveLength(1);
    expect(bridge.telegram("sendMessage").filter((call) => sentText(call) === "END")).toHaveLength(2);
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).toBeNull();
  });

  it("keeps typing when an edit is rate limited, and a later edit can still finish", async () => {
    let limited = true;
    const bridge = app({
      handler: (call) => limited && call.url.endsWith("/editMessageText")
        ? Response.json({
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 30",
          parameters: { retry_after: 30 },
        }, { status: 429 })
        : undefined,
    });
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("long job", 1));
    const reply = bridge.replies()[0]!;
    const progress = await bridge.send(reply, { text: "Working." });
    const messageId = (await progress.json() as { message_ids: number[] }).message_ids[0]!;
    const blocked = await bridge.send(reply, { message_id: messageId, text: "Done.", final: true }, "/send/edit");
    expect(blocked.status).toBe(502);
    expect(await blocked.json()).toMatchObject({ error: "telegram_edit_failed", ambiguous: false, retry_after: 30, edited: false });
    expect(bridge.telegram("setMessageReaction")).toHaveLength(1);
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).not.toBeNull();

    limited = false;
    const final = await bridge.send(reply, { message_id: messageId, text: "Done.", final: true }, "/send/edit");
    expect(final.status).toBe(200);
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).toBeNull();
  });

  it("counts an unchanged final edit as delivered and ends the wake", async () => {
    const bridge = app({
      handler: (call) => call.url.endsWith("/editMessageText")
        ? Response.json({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }, { status: 400 })
        : undefined,
    });
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("long job", 1));
    const reply = bridge.replies()[0]!;
    const progress = await bridge.send(reply, { text: "The whole answer." });
    const messageId = (await progress.json() as { message_ids: number[] }).message_ids[0]!;
    const final = await bridge.send(reply, { message_id: messageId, text: "The whole answer.", final: true }, "/send/edit");
    expect(await final.json()).toEqual({ ok: true, not_modified: true, message_ids: [messageId] });
    expect(bridge.telegram("setMessageReaction").at(-1)?.body).toMatchObject({ reaction: [] });
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).toBeNull();
  });

  it("refuses messages this wake did not send", async () => {
    const bridge = app();
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("one", 1));
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("two", 2));
    const [first, second] = bridge.replies();
    const progress = await bridge.send(first!, { text: "Working." });
    const messageId = (await progress.json() as { message_ids: number[] }).message_ids[0]!;

    const userMessage = await bridge.send(first!, { message_id: 11, text: "nope" }, "/send/edit");
    expect(userMessage.status).toBe(403);
    expect(await userMessage.json()).toEqual({ ok: false, error: "not_outbound" });

    const otherWake = await bridge.send(second!, { message_id: messageId, text: "stolen" }, "/send/edit");
    expect(otherWake.status).toBe(403);
    expect(bridge.telegram("editMessageText")).toHaveLength(0);
    expect(bridge.logs).toContainEqual(expect.objectContaining({ event: "edit_denied", wake_id: first!.wake_id }));

    const scoped = await bridge.send(first!, { message_id: messageId, text: "hi", chat_id: "-500" }, "/send/edit");
    expect(scoped.status).toBe(403);
    expect(await scoped.json()).toMatchObject({ error: "scope" });
  });

  it("does not let the outbound key edit, or a wake edit a proactive message", async () => {
    const bridge = app({ env: testEnv({ OUTBOUND_API_KEY: "outbound-key-value-for-tests-0123456789" }) });
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("hi", 1));
    const reply = bridge.replies()[0]!;
    const proactive = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers: { authorization: "Bearer outbound-key-value-for-tests-0123456789", "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "42", text: "proactive" }),
    }), bridge.deps);
    const proactiveId = (await proactive.json() as { message_ids: number[] }).message_ids[0]!;

    const byKey = await handleRequest(new Request("https://bridge.example/send/edit", {
      method: "POST",
      headers: { authorization: "Bearer outbound-key-value-for-tests-0123456789", "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "42", message_id: proactiveId, text: "changed" }),
    }), bridge.deps);
    expect(byKey.status).toBe(400);
    expect(await byKey.json()).toMatchObject({ error: "wake_id_required" });

    const byWake = await bridge.send(reply, { message_id: proactiveId, text: "changed" }, "/send/edit");
    expect(byWake.status).toBe(403);
    expect(bridge.telegram("editMessageText")).toHaveLength(0);
  });

  it("rejects a progress edit over 4096 characters and a text over the absolute cap", async () => {
    const bridge = app();
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("long job", 1));
    const reply = bridge.replies()[0]!;
    const progress = await bridge.send(reply, { text: "Working." });
    const messageId = (await progress.json() as { message_ids: number[] }).message_ids[0]!;
    const tooLong = await bridge.send(reply, { message_id: messageId, text: "b".repeat(TELEGRAM_TEXT_LIMIT + 1) }, "/send/edit");
    expect(tooLong.status).toBe(413);
    expect(await tooLong.json()).toEqual({ ok: false, error: "edit_too_long" });
    const huge = await bridge.send(reply, {
      message_id: messageId,
      text: "c".repeat(TELEGRAM_TEXT_LIMIT * 8 + 1),
      final: true,
    }, "/send/edit");
    expect(huge.status).toBe(413);
    expect(await huge.json()).toEqual({ ok: false, error: "text_too_large" });
    expect(bridge.telegram("editMessageText")).toHaveLength(0);
    const missing = await bridge.send(reply, { text: "x" }, "/send/edit");
    expect(missing.status).toBe(400);
  });

  it("ends only the finishing wake when two wakes share a chat", async () => {
    const bridge = app();
    const mention = [{ type: "mention", offset: 0, length: 8 }];
    await postUpdate(bridge.deps, bridge.tasks, groupUpdate({ text: "@testbot one", updateId: 1, chatId: -500, entities: mention }));
    await postUpdate(bridge.deps, bridge.tasks, groupUpdate({ text: "@testbot two", updateId: 2, chatId: -500, entities: mention }));
    const [first, second] = bridge.replies();
    const progress = await bridge.send(first!, { text: "Working on one." });
    const messageId = (await progress.json() as { message_ids: number[] }).message_ids[0]!;
    const scope = scopeKey("-500", null);
    await bridge.send(first!, { message_id: messageId, text: "One done.", final: true }, "/send/edit");
    expect(Object.keys((await bridge.deps.store.getTyping(scope))?.wakes ?? {})).toEqual([second!.wake_id]);
    expect(bridge.telegram("setMessageReaction").at(-1)?.body).toMatchObject({ message_id: 31, reaction: [] });
    expect(bridge.telegram("sendChatAction").length).toBeGreaterThan(0);
  });

  it("still finalizes by edit when the private-chat draft placeholder is on", async () => {
    const bridge = app({ env: testEnv({ TELEGRAM_DRAFT_PLACEHOLDER: "true" }) });
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("hello", 1));
    const reply = bridge.replies()[0]!;
    expect(bridge.telegram("sendMessageDraft").length).toBeGreaterThan(0);
    const progress = await bridge.send(reply, { text: "Working." });
    const messageId = (await progress.json() as { message_ids: number[] }).message_ids[0]!;
    const final = await bridge.send(reply, { message_id: messageId, text: "Done.", final: true }, "/send/edit");
    expect(final.status).toBe(200);
    expect(bridge.telegram("editMessageText")).toHaveLength(1);
    expect(bridge.telegram("sendMessageDraft").every((call) => (call.body as { text?: string }).text === "")).toBe(true);
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).toBeNull();
  });

  it("does not edit a photo this wake sent", async () => {
    const bridge = app({
      handler: (call) => call.url.endsWith("/sendPhoto")
        ? Response.json({ ok: true, result: { message_id: 90 } })
        : undefined,
    });
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("chart", 1));
    const reply = bridge.replies()[0]!;
    const photo = await bridge.send(reply, { kind: "photo", url: "https://cdn.example/plot.png" }, "/send/media");
    expect(await photo.json()).toEqual({ ok: true, message_ids: [90] });
    const edited = await bridge.send(reply, { message_id: 90, text: "caption" }, "/send/edit");
    expect(edited.status).toBe(403);
    expect(bridge.telegram("editMessageText")).toHaveLength(0);
  });

  it("lets a rate-limited progress edit finish before the final edit, so the answer stays", async () => {
    let progressAttempts = 0;
    let releaseRetry: () => void = () => undefined;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let markAsleep: () => void = () => undefined;
    const asleep = new Promise<void>((resolve) => {
      markAsleep = resolve;
    });
    const bridge = app({
      sleep: async () => {
        markAsleep();
        await retryGate;
      },
      handler: (call) => {
        if (!call.url.endsWith("/editMessageText")) return undefined;
        const text = (call.body as { text?: string }).text;
        if (text !== "Still working.") return undefined;
        progressAttempts += 1;
        if (progressAttempts === 1) {
          return Response.json({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 1 },
          }, { status: 429 });
        }
        return undefined;
      },
    });
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("long job", 1));
    const reply = bridge.replies()[0]!;
    const progress = await bridge.send(reply, { text: "Pulling the numbers." });
    const messageId = (await progress.json() as { message_ids: number[] }).message_ids[0]!;

    const progressEdit = bridge.send(reply, { message_id: messageId, text: "Still working." }, "/send/edit");
    await asleep;
    const finalEdit = bridge.send(reply, { message_id: messageId, text: "Sunny all week.", final: true }, "/send/edit");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.telegram("editMessageText").map((call) => (call.body as { text?: string }).text)).toEqual(["Still working."]);

    releaseRetry();
    const [progressResponse, finalResponse] = await Promise.all([progressEdit, finalEdit]);
    expect(progressResponse.status).toBe(200);
    expect(finalResponse.status).toBe(200);
    expect(bridge.telegram("editMessageText").map((call) => (call.body as { text?: string }).text)).toEqual([
      "Still working.",
      "Still working.",
      "Sunny all week.",
    ]);
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).toBeNull();
    const again = await bridge.send(reply, { message_id: messageId, text: "Sunny all week.", final: true }, "/send/edit");
    expect(await again.json()).toMatchObject({ already_sent: true });
    expect(bridge.telegram("editMessageText").map((call) => (call.body as { text?: string }).text).at(-1)).toBe("Sunny all week.");
  });

  it("drops a progress edit that was waiting when the final edit closed the wake", async () => {
    let releaseFinal: () => void = () => undefined;
    const finalGate = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    let markFinal: () => void = () => undefined;
    const finalInside = new Promise<void>((resolve) => {
      markFinal = resolve;
    });
    const bridge = app({
      handler: (call) => {
        if (!call.url.endsWith("/editMessageText")) return undefined;
        if ((call.body as { text?: string }).text !== "Sunny all week.") return undefined;
        markFinal();
        return finalGate.then(() => Response.json({ ok: true, result: { message_id: 1 } }));
      },
    });
    await postUpdate(bridge.deps, bridge.tasks, dmUpdate("long job", 1));
    const reply = bridge.replies()[0]!;
    const progress = await bridge.send(reply, { text: "Pulling the numbers." });
    const messageId = (await progress.json() as { message_ids: number[] }).message_ids[0]!;

    const finalEdit = bridge.send(reply, { message_id: messageId, text: "Sunny all week.", final: true }, "/send/edit");
    await finalInside;
    const progressEdit = bridge.send(reply, { message_id: messageId, text: "Still working." }, "/send/edit");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.telegram("editMessageText").map((call) => (call.body as { text?: string }).text)).toEqual(["Sunny all week."]);

    releaseFinal();
    expect((await finalEdit).status).toBe(200);
    const late = await progressEdit;
    expect(late.status).toBe(401);
    expect(await late.json()).toEqual({ ok: false, error: "wake_closed" });
    expect(bridge.telegram("editMessageText").map((call) => (call.body as { text?: string }).text)).toEqual(["Sunny all week."]);
    expect(await bridge.deps.store.getTyping(scopeKey("42", null))).toBeNull();
  });

  it("answers GET /send/edit with 405", async () => {
    const bridge = app();
    const response = await handleRequest(new Request("https://bridge.example/send/edit"), bridge.deps);
    expect(response.status).toBe(405);
  });
});
