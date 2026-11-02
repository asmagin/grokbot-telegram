import { describe, expect, it } from "vitest";
import { createLogger } from "../src/core/log.js";
import { verifyReplyToken } from "../src/core/crypto.js";
import { SCHEMA_VERSION } from "../src/core/types.js";
import { handleRequest } from "../src/core/handler.js";
import { buildDeps } from "../src/core/deps.js";
import { telegramMethodUrl } from "../src/core/telegram.js";
import { scopeKey } from "../src/core/store.js";
import {
  createFetchMock,
  createTestApp,
  dmUpdate,
  groupUpdate,
  NOW,
  postUpdate,
  testEnv,
  webhookRequest,
} from "./helpers.js";

describe("webhook ingress", () => {
  it("rejects a missing or wrong secret and accepts the real header", async () => {
    const app = createTestApp();
    const missing = await handleRequest(new Request("https://bridge.example/webhook", {
      method: "POST",
      body: JSON.stringify(dmUpdate("hi")),
    }), app.deps);
    expect(missing.status).toBe(401);

    const wrong = await postUpdate(app.deps, app.tasks, dmUpdate("hi"), "nope");
    expect(wrong.status).toBe(401);

    const ok = await postUpdate(app.deps, app.tasks, dmUpdate("hi"));
    expect(ok.status).toBe(200);
    expect(app.calls.filter((call) => call.url.startsWith("https://grok.example/hook"))).toHaveLength(1);
  });

  it("returns 503 when the webhook secret is not configured", async () => {
    const app = createTestApp({ env: testEnv({ TELEGRAM_WEBHOOK_SECRET: "" }) });
    const response = await postUpdate(app.deps, app.tasks, dmUpdate("hi"), "");
    expect(response.status).toBe(503);
  });

  it("rejects oversized and invalid JSON bodies", async () => {
    const app = createTestApp({ env: testEnv({ MAX_BODY_BYTES: "1024" }) });
    const big = await handleRequest(new Request("https://bridge.example/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret-value", "content-type": "application/json" },
      body: JSON.stringify(dmUpdate("x".repeat(2000))),
    }), app.deps);
    expect(big.status).toBe(413);

    const bad = await handleRequest(webhookRequest("{"), app.deps);
    expect(bad.status).toBe(400);
  });

  it("dedupes by update_id and does not forward the retry", async () => {
    const app = createTestApp();
    const first = await postUpdate(app.deps, app.tasks, dmUpdate("hi", 7));
    const second = await postUpdate(app.deps, app.tasks, dmUpdate("hi", 7));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(app.calls.filter((call) => call.url.startsWith("https://grok.example/hook"))).toHaveLength(1);
  });

  it("fail-closes an empty allowlist and logs the ids it saw", async () => {
    const logs: Record<string, unknown>[] = [];
    const mock = createFetchMock();
    const tasks: Promise<unknown>[] = [];
    const deps = buildDeps({
      env: testEnv({ ALLOWLIST_USER_IDS: "", ALLOWLIST_CHAT_IDS: "" }),
      fetchImpl: mock.fetchImpl,
      waitUntil: (promise) => tasks.push(promise),
      typingMode: "once",
      log: (event) => logs.push(event),
    });
    const response = await postUpdate(deps, tasks, dmUpdate("hi"));
    expect(response.status).toBe(200);
    expect(mock.calls).toHaveLength(0);
    expect(logs).toContainEqual(expect.objectContaining({
      reason: "not_allowlisted",
      chat_id: "42",
      user_id: "42",
    }));
  });

  it("drops group chatter unless the bot is addressed, and still keeps context", async () => {
    const app = createTestApp();
    await postUpdate(app.deps, app.tasks, groupUpdate({ text: "just chatting", updateId: 1, userId: 100 }));
    const mentioned = await postUpdate(app.deps, app.tasks, groupUpdate({
      text: "hey @testbot status?",
      updateId: 2,
      userId: 100,
      entities: [{ type: "mention", offset: 4, length: 8 }],
    }));
    expect(mentioned.status).toBe(200);
    const forwarded = app.calls.find((call) => call.url.startsWith("https://grok.example/hook"));
    const payload = forwarded?.body as { short_term: { text: string }[]; addressed_how: string };
    expect(payload.addressed_how).toBe("mention");
    expect(payload.short_term.map((item) => item.text)).toEqual(["just chatting"]);
  });

  it("wakes a group on a command or a reply to the bot, and ignores other bots", async () => {
    const app = createTestApp();
    await postUpdate(app.deps, app.tasks, groupUpdate({ text: "/ask summarize", updateId: 1, userId: 100 }));
    await postUpdate(app.deps, app.tasks, groupUpdate({
      text: "following up",
      updateId: 2,
      userId: 100,
      replyTo: {
        message_id: 3,
        text: "previous",
        chat: { id: -500, type: "supergroup" },
        from: { id: 999, is_bot: true, username: "TestBot" },
      },
    }));
    await postUpdate(app.deps, app.tasks, groupUpdate({ text: "/ask@otherbot no", updateId: 3, userId: 100 }));
    const botMessage = dmUpdate("I am a bot", 4);
    if (botMessage.message?.from) botMessage.message.from.is_bot = true;
    await postUpdate(app.deps, app.tasks, botMessage);
    const forwards = app.calls.filter((call) => call.url.startsWith("https://grok.example/hook"));
    expect(forwards).toHaveLength(2);
    const how = forwards.map((call) => (call.body as { addressed_how: string }).addressed_how);
    expect(how).toEqual(["command", "reply"]);
  });

  it("forwards a versioned payload with bearer auth, context, and a usable reply token", async () => {
    const app = createTestApp();
    const update = dmUpdate("hello there", 9);
    update.message!.reply_to_message = {
      message_id: 4,
      text: "z".repeat(4500),
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Ada" },
    };
    await postUpdate(app.deps, app.tasks, update);
    const call = app.calls.find((item) => item.url === "https://grok.example/hook");
    expect(call?.headers.authorization).toBe("Bearer sender-key-value");
    expect(call?.redirect).toBe("manual");
    const payload = call?.body as {
      schema_version: number;
      idempotency_key: string;
      addressed_how: string;
      message: { reply_to: { text: string } | null; text: string };
      reply: { token: string; send_url: string; typing_stop_url: string; heartbeat_url: string; chat_id: string };
    };
    expect(payload.schema_version).toBe(SCHEMA_VERSION);
    expect(payload.idempotency_key).toBe("9");
    expect(payload.addressed_how).toBe("private");
    expect(payload.message.reply_to?.text.length).toBe(4000);
    expect(payload.reply.send_url).toBe("https://bridge.example/send");
    expect(payload.reply.typing_stop_url).toBe("https://bridge.example/typing/stop");
    expect(payload.reply.heartbeat_url).toBe("https://bridge.example/typing/heartbeat");
    const verified = await verifyReplyToken("reply-token-secret-for-tests-only-0123456789", payload.reply.token, NOW);
    expect(verified.ok).toBe(true);
    expect(app.calls.some((item) => item.url.includes("/sendChatAction"))).toBe(true);
    expect(app.calls.some((item) => item.url.includes("/sendMessage"))).toBe(false);
  });

  it("does not follow redirects when forwarding", async () => {
    const mock = createFetchMock((call) => {
      if (call.url.startsWith("https://grok.example/hook")) return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
      return Response.json({ ok: true, result: { message_id: 1 } });
    });
    const tasks: Promise<unknown>[] = [];
    const deps = buildDeps({
      env: testEnv(),
      fetchImpl: mock.fetchImpl,
      waitUntil: (promise) => tasks.push(promise),
      typingMode: "once",
      log: () => undefined,
    });
    await postUpdate(deps, tasks, dmUpdate("hi", 3));
    expect(mock.calls.filter((call) => call.url.includes("169.254"))).toHaveLength(0);
    expect(mock.calls.filter((call) => call.url.startsWith("https://grok.example/hook"))).toHaveLength(1);
  });

  it("rate limits per chat", async () => {
    const app = createTestApp({ env: testEnv({ RATE_LIMIT_MAX: "2" }) });
    await postUpdate(app.deps, app.tasks, dmUpdate("one", 1));
    await postUpdate(app.deps, app.tasks, dmUpdate("two", 2));
    await postUpdate(app.deps, app.tasks, dmUpdate("three", 3));
    expect(app.calls.filter((call) => call.url.startsWith("https://grok.example/hook"))).toHaveLength(2);
  });

  it("answers a fast greeting locally only when enabled", async () => {
    const enabled = createTestApp({ env: testEnv({ FAST_GREETING: "true" }) });
    await postUpdate(enabled.deps, enabled.tasks, dmUpdate("ping", 1));
    expect(enabled.calls.some((call) => call.url.startsWith("https://grok.example/hook"))).toBe(false);
    const sent = enabled.calls.find((call) => call.url.endsWith("/sendMessage"));
    expect(sent?.body).toMatchObject({ text: "Pong.", chat_id: "42" });

    const disabled = createTestApp();
    await postUpdate(disabled.deps, disabled.tasks, dmUpdate("ping", 1));
    expect(disabled.calls.some((call) => call.url.startsWith("https://grok.example/hook"))).toBe(true);
  });

  it("does not put secrets or message text in the log line", async () => {
    const lines: string[] = [];
    const env = testEnv();
    const mock = createFetchMock();
    const tasks: Promise<unknown>[] = [];
    const deps = buildDeps({
      env,
      fetchImpl: mock.fetchImpl,
      waitUntil: (promise) => tasks.push(promise),
      typingMode: "once",
      log: createLogger(
        [env.TELEGRAM_WEBHOOK_SECRET, env.GROK_WEBHOOK_SENDER_KEY, env.REPLY_TOKEN_SECRET, env.TELEGRAM_BOT_TOKEN],
        (line) => lines.push(line),
      ),
    });
    await postUpdate(deps, tasks, dmUpdate("the secret phrase is swordfish", 4));
    const blob = lines.join("\n");
    expect(blob).not.toContain("webhook-secret-value");
    expect(blob).not.toContain("sender-key-value");
    expect(blob).not.toContain("reply-token-secret");
    expect(blob).not.toContain("123456:ABCDEFghij");
    expect(blob).not.toContain("swordfish");
    expect(blob).toContain("wake");
  });
});

describe("outbound /send and typing stop", () => {
  async function wakeToken(): Promise<{ token: string; wakeId: string; app: ReturnType<typeof createTestApp> }> {
    const app = createTestApp();
    await postUpdate(app.deps, app.tasks, dmUpdate("hello", 1));
    const call = app.calls.find((item) => item.url.startsWith("https://grok.example/hook"));
    const reply = (call?.body as { reply: { token: string; wake_id: string } }).reply;
    return { token: reply.token, wakeId: reply.wake_id, app };
  }

  it("splits a long reply, retries 429, and stops typing when final", async () => {
    const { token, app } = await wakeToken();
    let telegramPosts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/sendMessage")) {
        telegramPosts += 1;
        if (telegramPosts === 1) {
          return Response.json({
            ok: false,
            description: "Too Many Requests",
            parameters: { retry_after: 3 },
          }, { status: 429 });
        }
        return Response.json({ ok: true, result: { message_id: telegramPosts } });
      }
      return app.deps.fetchImpl(input, init);
    };
    const slept: number[] = [];
    const tasks: Promise<unknown>[] = [];
    const deps = buildDeps({
      env: testEnv(),
      store: app.deps.store,
      typing: app.deps.typing,
      fetchImpl,
      sleep: async (ms) => {
        slept.push(ms);
      },
      waitUntil: (promise) => tasks.push(promise),
      now: () => NOW,
      typingMode: "once",
      log: () => undefined,
    });
    const text = `${"a".repeat(3000)}\n\n${"b".repeat(2000)}`;
    const response = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: 42, text, reply_to_message_id: 11, final: true }),
    }), deps);
    expect(response.status).toBe(200);
    const body = await response.json() as { message_ids: number[] };
    expect(body.message_ids.length).toBe(2);
    expect(slept).toEqual([3000]);
    const again = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "42", text: "more" }),
    }), deps);
    expect(again.status).toBe(401);
    const closed = await again.json() as { error: string };
    expect(closed.error).toBe("wake_closed");
  });

  it("rejects expired, cross-chat, and unsigned sends", async () => {
    const app = createTestApp();
    await postUpdate(app.deps, app.tasks, dmUpdate("hello", 1));
    const token = (app.calls.find((call) => call.url.startsWith("https://grok.example/hook"))?.body as { reply: { token: string } }).reply.token;
    const later = buildDeps({
      env: testEnv(),
      store: app.deps.store,
      fetchImpl: app.deps.fetchImpl,
      typing: app.deps.typing,
      now: () => NOW + 3_600_000,
      typingMode: "once",
      log: () => undefined,
    });
    const expired = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "42", text: "late" }),
    }), later);
    expect(expired.status).toBe(401);

    const fresh = createTestApp();
    await postUpdate(fresh.deps, fresh.tasks, dmUpdate("hello", 2));
    const freshToken = (fresh.calls.find((call) => call.url.startsWith("https://grok.example/hook"))?.body as { reply: { token: string } }).reply.token;
    const scoped = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers: { authorization: `Bearer ${freshToken}`, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "-500", text: "wrong chat" }),
    }), fresh.deps);
    expect(scoped.status).toBe(403);
  });

  it("lets a reply token answer a group the user was allowed into, and blocks the outbound key there", async () => {
    const app = createTestApp();
    await postUpdate(app.deps, app.tasks, groupUpdate({
      text: "@testbot hi",
      updateId: 5,
      userId: 42,
      chatId: -999,
      entities: [{ type: "mention", offset: 0, length: 8 }],
    }));
    const token = (app.calls.find((call) => call.url.startsWith("https://grok.example/hook"))?.body as { reply: { token: string } }).reply.token;
    const sent = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "-999", text: "hello from the bot" }),
    }), app.deps);
    expect(sent.status).toBe(200);

    const keyed = createTestApp({ env: testEnv({ OUTBOUND_API_KEY: "outbound-key-value-for-tests-0123456789" }) });
    const denied = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers: { authorization: "Bearer outbound-key-value-for-tests-0123456789", "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "-999", text: "proactive" }),
    }), keyed.deps);
    expect(denied.status).toBe(403);
    const allowed = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers: { authorization: "Bearer outbound-key-value-for-tests-0123456789", "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "-500", text: "proactive" }),
    }), keyed.deps);
    expect(allowed.status).toBe(200);
  });

  it("lets an older wake's /typing/stop end only that wake, never a newer one", async () => {
    const app = createTestApp();
    await postUpdate(app.deps, app.tasks, dmUpdate("first", 1));
    await postUpdate(app.deps, app.tasks, dmUpdate("second", 2));
    const bodies = app.calls
      .filter((call) => call.url.startsWith("https://grok.example/hook"))
      .map((call) => call.body as { reply: { token: string; wake_id: string } });
    const first = bodies[0]?.reply;
    const second = bodies[1]?.reply;
    const stale = await handleRequest(new Request("https://bridge.example/typing/stop", {
      method: "POST",
      headers: { authorization: `Bearer ${first?.token}`, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "42" }),
    }), app.deps);
    expect(await stale.json()).toMatchObject({ stopped: true, reason: "stopped" });
    expect(Object.keys((await app.deps.store.getTyping(scopeKey("42", null)))?.wakes ?? {})).toEqual([second?.wake_id]);
    const again = await handleRequest(new Request("https://bridge.example/typing/stop", {
      method: "POST",
      headers: { authorization: `Bearer ${first?.token}`, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "42" }),
    }), app.deps);
    expect(await again.json()).toMatchObject({ stopped: false, reason: "none" });
    const current = await handleRequest(new Request("https://bridge.example/typing/stop", {
      method: "POST",
      headers: { authorization: `Bearer ${second?.token}`, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "42" }),
    }), app.deps);
    expect(await current.json()).toMatchObject({ stopped: true, reason: "stopped" });
    expect(first?.wake_id).not.toBe(second?.wake_id);
  });

  it("refuses to build a telegram URL from a token that could change the host", () => {
    expect(telegramMethodUrl("123456:ABCDEFghij", "sendMessage")).toBe(
      "https://api.telegram.org/bot123456:ABCDEFghij/sendMessage",
    );
    expect(telegramMethodUrl("https://evil.example", "sendMessage")).toBeNull();
    expect(telegramMethodUrl("123456:ABCDEFghij", "../getMe")).toBeNull();
  });
});

describe("health", () => {
  it("reports configuration without values", async () => {
    const app = createTestApp();
    const response = await handleRequest(new Request("https://bridge.example/healthz"), app.deps);
    const body = await response.json() as { ok: boolean; ready: boolean; configured: Record<string, boolean> };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.ready).toBe(true);
    expect(body.configured.allowlist).toBe(true);
    expect(JSON.stringify(body)).not.toContain("webhook-secret-value");
  });
});
