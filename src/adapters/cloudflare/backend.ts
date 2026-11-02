import type { ContextMessage } from "../../core/types.js";
import {
  chatIdFromRateKey,
  chatIdFromScope,
  normalizeSendRecord,
  normalizeEditTail,
  type BurstPeek,
  type BurstStage,
  type PendingBurst,
  type Store,
} from "../../core/store.js";
import { normalizeScope, type TypingController } from "../../core/typing.js";

export interface DoId {
  toString(): string;
}

export interface DoNamespace {
  idFromName(name: string): DoId;
  get(id: DoId): {
    fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
  };
}

async function call(namespace: DoNamespace, name: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const stub = namespace.get(namespace.idFromName(name));
  const response = await stub.fetch("https://session.internal/op", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`durable_object_${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

function asBurstPeek(value: unknown): BurstPeek | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.generation !== "number" || typeof record.senderKey !== "string" || typeof record.flushAt !== "number") {
    return null;
  }
  return {
    generation: record.generation,
    senderKey: record.senderKey,
    flushAt: record.flushAt,
    size: typeof record.size === "number" ? record.size : 0,
  };
}

function asBurstStage(value: Record<string, unknown>): BurstStage {
  const stage: BurstStage = {
    joined: value.joined === true,
    generation: typeof value.generation === "number" ? value.generation : 0,
    delayMs: typeof value.delayMs === "number" ? value.delayMs : 0,
  };
  if (typeof value.overdueGeneration === "number") stage.overdueGeneration = value.overdueGeneration;
  return stage;
}

function asPendingBurst(value: unknown): PendingBurst | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.generation !== "number" || typeof record.senderKey !== "string" || typeof record.flushAt !== "number") {
    return null;
  }
  if (!Array.isArray(record.items) || !Array.isArray(record.shortTerm)) return null;
  return record as unknown as PendingBurst;
}

function chatObjectName(chatId: string): string {
  return `chat:${chatId}`;
}

export function createDurableBackend(original: DoNamespace, botId: string | null = null): { store: Store; typing: TypingController } {
  const namespace: DoNamespace = botId === null ? original : {
    idFromName: (name) => original.idFromName(`bot:${botId}:${name}`),
    get: (id) => ({
      async fetch(input, init) {
        const request = new Request(input, init);
        request.headers.set("x-bridge-bot", botId);
        return original.get(id).fetch(request);
      },
    }),
  };
  const store: Store = {
    async claimUpdate(updateId, now, ttlMs) {
      const result = await call(namespace, "dedupe", { op: "claim", updateId, now, ttlMs });
      return result.status === "duplicate" ? "duplicate" : "new";
    },
    async releaseUpdate(updateId) {
      await call(namespace, "dedupe", { op: "release", updateId });
    },
    async claimMessage(chatId, messageId, now, ttlMs) {
      // The chat's object serializes claims for its messages, so concurrent deliveries get one "new".
      const result = await call(namespace, chatObjectName(chatId), { op: "msg.claim", messageId, now, ttlMs });
      return result.status === "new" ? "new" : "duplicate";
    },
    async claimCallback(chatId, messageId, now, ttlMs) {
      const result = await call(namespace, chatObjectName(chatId), { op: "cb.claim", messageId, now, ttlMs });
      return result.status === "new" ? "new" : "duplicate";
    },
    async hitRate(bucketKey, now, windowMs, max) {
      const chatId = chatIdFromRateKey(bucketKey);
      const result = await call(namespace, chatObjectName(chatId), {
        op: "rate",
        bucketKey,
        now,
        windowMs,
        max,
      });
      return {
        allowed: result.allowed === true,
        count: typeof result.count === "number" ? result.count : 0,
      };
    },
    async pushContext(scope, message, limit) {
      const result = await call(namespace, chatObjectName(chatIdFromScope(scope)), {
        op: "context",
        scopeKey: scope,
        message,
        limit,
      });
      return Array.isArray(result.prior) ? (result.prior as ContextMessage[]) : [];
    },
    async getTyping(scope) {
      const result = await call(namespace, chatObjectName(chatIdFromScope(scope)), {
        op: "typing.get",
        scopeKey: scope,
      });
      return normalizeScope(result.scope);
    },
    async setTyping(key, scope) {
      await call(namespace, chatObjectName(chatIdFromScope(key)), {
        op: "typing.set",
        scopeKey: key,
        scope,
      });
    },
    async closeWake(wakeId, now, ttlMs) {
      await call(namespace, "dedupe", { op: "wake.close", wakeId, now, ttlMs });
    },
    async isWakeClosed(wakeId, now) {
      const result = await call(namespace, "dedupe", { op: "wake.closed", wakeId, now });
      return result.closed === true;
    },
    async claimSend(key, now, ttlMs) {
      const result = await call(namespace, "dedupe", { op: "send.claim", sendKey: key, now, ttlMs });
      if (result.claimed === true) return null;
      return normalizeSendRecord(result.record) ?? { state: "pending", message_ids: [] };
    },
    async finishSend(key, record, now, ttlMs) {
      await call(namespace, "dedupe", { op: "send.finish", sendKey: key, record, now, ttlMs });
    },
    async releaseSend(key) {
      await call(namespace, "dedupe", { op: "send.release", sendKey: key });
    },
    async noteOutbound(wakeId, messageIds, now, ttlMs) {
      await call(namespace, "dedupe", { op: "outbound.note", wakeId, messageIds: [...messageIds], now, ttlMs });
    },
    async ownsOutbound(wakeId, messageId, now) {
      const result = await call(namespace, "dedupe", { op: "outbound.owns", wakeId, messageId, now });
      return result.owns === true;
    },
    async getEditTail(wakeId, now) {
      const result = await call(namespace, "dedupe", { op: "outbound.tail", wakeId, now });
      return normalizeEditTail(result.tail);
    },
    async setEditTail(wakeId, tail, now, ttlMs) {
      await call(namespace, "dedupe", { op: "outbound.tail.set", wakeId, tail, now, ttlMs });
    },
    async claimEditLock(key, now, ttlMs) {
      const result = await call(namespace, "dedupe", { op: "edit.lock", lockKey: key, now, ttlMs });
      return typeof result.token === "string" ? result.token : null;
    },
    async releaseEditLock(key, token) {
      await call(namespace, "dedupe", { op: "edit.unlock", lockKey: key, token });
    },
    async peekBurst(scope) {
      const result = await call(namespace, chatObjectName(chatIdFromScope(scope)), {
        op: "burst.peek",
        scopeKey: scope,
      });
      return asBurstPeek(result.burst);
    },
    async stageBurst(input) {
      const result = await call(namespace, chatObjectName(chatIdFromScope(input.scopeKey)), {
        op: "burst.stage",
        scopeKey: input.scopeKey,
        item: input.item,
        shortTerm: input.shortTerm,
        senderKey: input.senderKey,
        now: input.now,
        debounceMs: input.debounceMs,
        maxItems: input.maxItems,
        create: input.create,
      });
      return asBurstStage(result);
    },
    async takeBurst(scope, generation) {
      const result = await call(namespace, chatObjectName(chatIdFromScope(scope)), {
        op: "burst.take",
        scopeKey: scope,
        generation,
      });
      return asPendingBurst(result.burst);
    },
  };

  // The chat's Durable Object owns typing state, the reaction, and the alarm, so they survive eviction.
  const typing: TypingController = {
    async start(input) {
      await call(namespace, chatObjectName(input.chatId), { op: "typing.start", start: input });
    },
    async stop(scope, wakeId) {
      const result = await call(namespace, chatObjectName(chatIdFromScope(scope)), {
        op: "typing.stop",
        scopeKey: scope,
        wakeId,
      });
      return { stopped: result.stopped === true, reason: result.stopped === true ? "stopped" : "none" };
    },
    async touch(scope, wakeId) {
      const result = await call(namespace, chatObjectName(chatIdFromScope(scope)), {
        op: "typing.touch",
        scopeKey: scope,
        wakeId,
      });
      return { active: result.active === true, extended: result.extended === true };
    },
  };

  return { store, typing };
}
