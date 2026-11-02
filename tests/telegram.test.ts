import { describe, expect, it } from "vitest";
import { createTelegramClient } from "../src/core/telegram.js";
import { splitTelegramText } from "../src/core/text.js";

describe("telegram client", () => {
  it("replies with reply_parameters that tolerate a deleted parent", async () => {
    const bodies: unknown[] = [];
    const client = createTelegramClient({
      token: "123456:ABCDEFghij",
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, result: { message_id: 5 } });
      },
    });
    await client.sendMessage({ chat_id: "42", text: "hi", reply_to_message_id: 9 });
    expect(bodies[0]).toEqual({
      chat_id: "42",
      text: "hi",
      reply_parameters: { message_id: 9, allow_sending_without_reply: true },
    });
  });

  it("never retries a send that may have been posted, and says so", async () => {
    const cases: [string, () => Response, boolean][] = [
      ["timeout", () => { throw new DOMException("timed out", "TimeoutError"); }, true],
      ["reset", () => { throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); }, true],
      ["5xx", () => Response.json({ ok: false, error_code: 500, description: "Internal" }, { status: 500 }), true],
      ["unreadable 200", () => new Response("not json", { status: 200 }), true],
      ["refused", () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); }, false],
      ["400", () => Response.json({ ok: false, error_code: 400, description: "Bad Request" }, { status: 400 }), false],
    ];
    for (const [label, respond, ambiguous] of cases) {
      let posts = 0;
      const client = createTelegramClient({
        token: "123456:ABCDEFghij",
        sleep: async () => undefined,
        fetchImpl: async () => {
          posts += 1;
          return respond();
        },
      });
      const result = await client.sendMessage({ chat_id: "42", text: "hi" });
      expect({ label, posts, ambiguous: !result.ok && result.ambiguous === true }).toEqual({ label, posts: 1, ambiguous });
    }
  });

  it("does not retry early when retry_after is longer than the in-request cap", async () => {
    let posts = 0;
    const slept: number[] = [];
    const client = createTelegramClient({
      token: "123456:ABCDEFghij",
      sleep: async (ms) => {
        slept.push(ms);
      },
      fetchImpl: async () => {
        posts += 1;
        return Response.json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 30 } }, { status: 429 });
      },
    });
    const result = await client.sendMessage({ chat_id: "42", text: "hi" });
    expect(posts).toBe(1);
    expect(slept).toEqual([]);
    expect(result).toMatchObject({ ok: false, status: 429, retryAfter: 30 });
  });

  it("gives up after the bounded number of short retries", async () => {
    let posts = 0;
    const client = createTelegramClient({
      token: "123456:ABCDEFghij",
      sleep: async () => undefined,
      fetchImpl: async () => {
        posts += 1;
        return Response.json({ ok: false, parameters: { retry_after: 1 } }, { status: 429 });
      },
    });
    const result = await client.sendMessage({ chat_id: "42", text: "hi" });
    expect(posts).toBe(3);
    expect(result.ok).toBe(false);
  });
});

describe("progress calls", () => {
  function recorder(response: () => Response = () => Response.json({ ok: true, result: true })) {
    const calls: { url: string; body: unknown }[] = [];
    const client = createTelegramClient({
      token: "123456:ABCDEFghij",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return response();
      },
    });
    return { client, calls };
  }

  it("sets one small reaction and clears it with an empty list", async () => {
    const { client, calls } = recorder();
    expect(await client.setMessageReaction({ chat_id: "-500", message_id: 7, emoji: "👀" })).toEqual({ ok: true });
    await client.setMessageReaction({ chat_id: "-500", message_id: 7, emoji: null });
    expect(calls.map((call) => call.body)).toEqual([
      { chat_id: "-500", message_id: 7, reaction: [{ type: "emoji", emoji: "👀" }], is_big: false },
      { chat_id: "-500", message_id: 7, reaction: [], is_big: false },
    ]);
    expect(calls[0]?.url.endsWith("/setMessageReaction")).toBe(true);
  });

  it("reports a refused reaction once, without retrying", async () => {
    const { client, calls } = recorder(() =>
      Response.json({ ok: false, error_code: 400, description: "Bad Request: REACTION_INVALID" }, { status: 400 }));
    const result = await client.setMessageReaction({ chat_id: "42", message_id: 7, emoji: "👀" });
    expect(result).toEqual({ ok: false, status: 400, description: "Bad Request: REACTION_INVALID" });
    expect(calls).toHaveLength(1);
  });

  it("sends a draft with an integer chat id and empty text", async () => {
    const { client, calls } = recorder();
    await client.sendMessageDraft({ chat_id: "42", draft_id: 11 });
    expect(calls[0]?.body).toEqual({ chat_id: 42, draft_id: 11, text: "" });
  });

  it("edits text in place and treats 'message is not modified' as success", async () => {
    const bodies: unknown[] = [];
    let mode: "ok" | "same" = "ok";
    const client = createTelegramClient({
      token: "123456:ABCDEFghij",
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (mode === "same") {
          return Response.json({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }, { status: 400 });
        }
        return Response.json({ ok: true, result: { message_id: 5 } });
      },
    });
    expect(await client.editMessageText({ chat_id: "42", message_id: 5, text: "next" })).toEqual({ ok: true, messageId: 5 });
    mode = "same";
    expect(await client.editMessageText({ chat_id: "42", message_id: 5, text: "next" })).toEqual({
      ok: true,
      messageId: 5,
      notModified: true,
    });
    expect(bodies[0]).toEqual({ chat_id: "42", message_id: 5, text: "next" });
    expect(bodies).toHaveLength(2);
  });

  it("returns a long edit rate limit without retrying", async () => {
    let posts = 0;
    const client = createTelegramClient({
      token: "123456:ABCDEFghij",
      sleep: async () => undefined,
      fetchImpl: async () => {
        posts += 1;
        return Response.json({
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 30",
          parameters: { retry_after: 30 },
        }, { status: 429 });
      },
    });
    const result = await client.editMessageText({ chat_id: "42", message_id: 5, text: "next" });
    expect(posts).toBe(1);
    expect(result).toMatchObject({ ok: false, status: 429, retryAfter: 30 });
  });

  it("passes disable_notification through to sendMessage", async () => {
    const { client, calls } = recorder(() => Response.json({ ok: true, result: { message_id: 1 } }));
    await client.sendMessage({ chat_id: "42", text: "quiet", disable_notification: true });
    expect(calls[0]?.body).toEqual({ chat_id: "42", text: "quiet", disable_notification: true });
  });
});

describe("splitting", () => {
  it("never splits a surrogate pair on a hard cut", () => {
    const text = "a".repeat(4095) + "😀" + "b".repeat(10);
    const parts = splitTelegramText(text);
    expect(parts.every((part) => part.length <= 4096)).toBe(true);
    expect(parts.join("")).toBe(text);
    for (const part of parts) {
      const last = part.charCodeAt(part.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });
});
