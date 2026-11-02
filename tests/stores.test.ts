import { describe, expect, it } from "vitest";
import { handleDoFetch } from "../src/adapters/cloudflare/do-storage.js";
import { MemoryStore, scopeKey } from "../src/core/store.js";
import type { ContextMessage, TypingScope } from "../src/core/types.js";
import { memoryStorage, testEnv } from "./helpers.js";

async function op(storage: ReturnType<typeof memoryStorage>, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await handleDoFetch(storage, testEnv(), new Request("https://do/op", {
    method: "POST",
    body: JSON.stringify(body),
  }));
  return await response.json() as Record<string, unknown>;
}

function ctx(id: number, date: number): ContextMessage {
  return { message_id: id, text: `m${id}`, date, message_thread_id: null, from: null };
}

describe("durable object dedupe storage", () => {
  it("keeps one key per update and prunes expired ones instead of one growing map", async () => {
    const storage = memoryStorage();
    for (let id = 1; id <= 5; id += 1) {
      expect(await op(storage, { op: "claim", updateId: id, now: 1000, ttlMs: 100 })).toEqual({ status: "new" });
    }
    expect(await op(storage, { op: "claim", updateId: 3, now: 1050, ttlMs: 100 })).toEqual({ status: "duplicate" });
    expect(await storage.get("seen")).toBeUndefined();
    expect((await storage.list({ prefix: "upd:" })).size).toBe(5);
    expect(await op(storage, { op: "claim", updateId: 6, now: 5000, ttlMs: 100 })).toEqual({ status: "new" });
    expect([...(await storage.list({ prefix: "upd:" })).keys()]).toEqual(["upd:0000000000000006"]);
    await op(storage, { op: "release", updateId: 6 });
    expect(await op(storage, { op: "claim", updateId: 6, now: 5001, ttlMs: 100 })).toEqual({ status: "new" });
  });

  it("still honors a legacy single-map entry until it expires", async () => {
    const storage = memoryStorage();
    await storage.put("seen", { "9": 2000 });
    expect(await op(storage, { op: "claim", updateId: 9, now: 1000, ttlMs: 100 })).toEqual({ status: "duplicate" });
    expect(await op(storage, { op: "claim", updateId: 9, now: 3000, ttlMs: 100 })).toEqual({ status: "new" });
    expect(await storage.get("seen")).toBeUndefined();
  });

  it("claims a message once per chat object, survives a new instance, and prunes expired claims", async () => {
    const storage = memoryStorage();
    expect(await op(storage, { op: "msg.claim", messageId: 11, now: 1000, ttlMs: 100 })).toEqual({ status: "new" });
    expect(await op(storage, { op: "msg.claim", messageId: 11, now: 1050, ttlMs: 100 })).toEqual({ status: "duplicate" });
    expect(await op(storage, { op: "msg.claim", messageId: 12, now: 1050, ttlMs: 100 })).toEqual({ status: "new" });
    // Malformed input fails closed rather than waking.
    expect(await op(storage, { op: "msg.claim", now: 1050, ttlMs: 100 })).toEqual({ status: "duplicate" });
    expect(await op(storage, { op: "msg.claim", messageId: 13, now: 5000, ttlMs: 100 })).toEqual({ status: "new" });
    expect([...(await storage.list({ prefix: "msg:" })).keys()]).toEqual(["msg:0000000000000013"]);
    expect(await op(storage, { op: "msg.claim", messageId: 11, now: 5000, ttlMs: 100 })).toEqual({ status: "new" });
  });

  it("claims one inline keyboard per bot message", async () => {
    const storage = memoryStorage();
    expect(await op(storage, { op: "cb.claim", messageId: 80, now: 1000, ttlMs: 100 })).toEqual({ status: "new" });
    expect(await op(storage, { op: "cb.claim", messageId: 80, now: 1050, ttlMs: 100 })).toEqual({ status: "duplicate" });
    expect(await op(storage, { op: "cb.claim", messageId: 81, now: 1050, ttlMs: 100 })).toEqual({ status: "new" });
    expect(await op(storage, { op: "cb.claim", now: 1050, ttlMs: 100 })).toEqual({ status: "duplicate" });
    expect(await op(storage, { op: "cb.claim", messageId: 80, now: 5000, ttlMs: 100 })).toEqual({ status: "new" });
  });

  it("claims a send once, keeps its outcome for the ttl, and frees it on release", async () => {
    const storage = memoryStorage();
    expect(await op(storage, { op: "send.claim", sendKey: "w1:final", now: 1000, ttlMs: 500 })).toEqual({ claimed: true });
    expect(await op(storage, { op: "send.claim", sendKey: "w1:final", now: 1001, ttlMs: 500 }))
      .toEqual({ claimed: false, record: { state: "pending", message_ids: [] } });
    await op(storage, { op: "send.finish", sendKey: "w1:final", record: { state: "sent", message_ids: [7, 8] }, now: 1002, ttlMs: 500 });
    expect(await op(storage, { op: "send.claim", sendKey: "w1:final", now: 1400, ttlMs: 500 }))
      .toEqual({ claimed: false, record: { state: "sent", message_ids: [7, 8] } });
    // Expired, and pruned alongside other keys.
    expect(await op(storage, { op: "send.claim", sendKey: "w2:final", now: 2000, ttlMs: 500 })).toEqual({ claimed: true });
    expect([...(await storage.list({ prefix: "send:" })).keys()]).toEqual(["send:w2:final"]);
    await op(storage, { op: "send.release", sendKey: "w2:final" });
    expect(await op(storage, { op: "send.claim", sendKey: "w2:final", now: 2001, ttlMs: 500 })).toEqual({ claimed: true });
    // No key: refuse rather than send.
    expect(await op(storage, { op: "send.claim", now: 2001, ttlMs: 500 })).toMatchObject({ claimed: false });
  });

  it("closes wakes per key with expiry", async () => {
    const storage = memoryStorage();
    await op(storage, { op: "wake.close", wakeId: "w1", now: 1000, ttlMs: 100 });
    expect(await op(storage, { op: "wake.closed", wakeId: "w1", now: 1050 })).toEqual({ closed: true });
    expect(await op(storage, { op: "wake.closed", wakeId: "w1", now: 1200 })).toEqual({ closed: false });
    expect(await storage.get("wakes")).toBeUndefined();
  });

  it("does not attach context older than a week", async () => {
    const storage = memoryStorage();
    const day = 86_400;
    await op(storage, { op: "context", scopeKey: "chat:1:thread:root", message: ctx(1, 1_000_000), limit: 10 });
    const result = await op(storage, { op: "context", scopeKey: "chat:1:thread:root", message: ctx(2, 1_000_000 + 8 * day), limit: 10 });
    expect(result.prior).toEqual([]);
  });
});

describe("memory store bounds", () => {
  it("evicts old rate buckets, old scopes, and expired typing sessions", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 50; i += 1) await store.hitRate(`rate:chat:${i}`, 0, 1000, 5);
    await store.hitRate("rate:chat:x", 5000, 1000, 5);
    expect((store as unknown as { buckets: Map<string, unknown> }).buckets.size).toBe(1);

    for (let i = 0; i < 1100; i += 1) await store.pushContext(`chat:${i}:thread:root`, ctx(i, 1), 10);
    expect((store as unknown as { contexts: Map<string, unknown> }).contexts.size).toBe(1000);

    const session = (chat: string, startedAt: number): TypingScope => ({
      scopeKey: scopeKey(chat, null), chatId: chat, threadId: null, refreshMs: 3000,
      wakes: {
        [`w-${chat}`]: {
          wakeId: `w-${chat}`, messageId: 1, reaction: null, draft: false, draftAt: null,
          startedAt, leaseMs: 1000, leaseUntil: startedAt + 1000, deadline: startedAt + 1000,
        },
      },
    });
    await store.setTyping(scopeKey("1", null), session("1", 0));
    await store.setTyping(scopeKey("2", null), session("2", 5000));
    expect(await store.getTyping(scopeKey("1", null))).toBeNull();
    expect(await store.getTyping(scopeKey("2", null))).not.toBeNull();
  });
});
