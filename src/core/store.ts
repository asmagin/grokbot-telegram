import type { AddressHow, ContextMessage, TelegramMessage, TypingScope } from "./types.js";
import { scopeDeadline } from "./typing.js";

/** One Telegram update held while a forward burst is still open. */
export interface BurstItem {
  updateId: number;
  addressedHow: AddressHow | null;
  command: string | null;
  message: TelegramMessage;
}

/** Per chat and forum topic. The flush that still matches `generation` delivers it. */
export interface PendingBurst {
  generation: number;
  senderKey: string;
  flushAt: number;
  /** Context captured before the first item in the burst was part of it. */
  shortTerm: ContextMessage[];
  items: BurstItem[];
}

export interface BurstPeek {
  generation: number;
  senderKey: string;
  flushAt: number;
  size: number;
}

export interface BurstStage {
  joined: boolean;
  generation: number;
  delayMs: number;
  /** An older burst is past its flush time. Take this generation, then stage again. */
  overdueGeneration?: number;
}

export interface Store {
  claimUpdate(updateId: number, now: number, ttlMs: number): Promise<"new" | "duplicate">;
  /** Drop a claim so a failed handler can still be retried by Telegram. */
  releaseUpdate(updateId: number): Promise<void>;
  /**
   * Claim one Telegram message (chat + message_id) for a wake. Atomic: of any
   * number of concurrent claims, one gets "new". A redelivery under a new
   * update_id, or an edit of a message that already woke the bot, gets "duplicate".
   */
  claimMessage(chatId: string, messageId: number, now: number, ttlMs: number): Promise<"new" | "duplicate">;
  /**
   * Claim the inline keyboard on one bot message. The first accepted tap wins.
   * A second tap, including a different button on the same message, is "duplicate".
   */
  claimCallback(chatId: string, messageId: number, now: number, ttlMs: number): Promise<"new" | "duplicate">;
  hitRate(
    bucketKey: string,
    now: number,
    windowMs: number,
    max: number,
  ): Promise<{ allowed: boolean; count: number }>;
  /** Returns the previous buffer, capped at `limit`, not including `message`. */
  pushContext(scopeKey: string, message: ContextMessage, limit: number): Promise<ContextMessage[]>;
  /** The active wakes in one chat (and forum topic), or null when none. */
  getTyping(scopeKey: string): Promise<TypingScope | null>;
  setTyping(scopeKey: string, scope: TypingScope | null): Promise<void>;
  closeWake(wakeId: string, now: number, ttlMs: number): Promise<void>;
  /**
   * Claim an idempotent /send. Atomic set-if-absent: returns null when this
   * caller now owns `key` (stored as `pending`), or the record already there.
   */
  claimSend(key: string, now: number, ttlMs: number): Promise<SendRecord | null>;
  /** Record how a claimed send ended. Kept for `ttlMs` (the reply token's remaining life). */
  finishSend(key: string, record: SendRecord, now: number, ttlMs: number): Promise<void>;
  /** Drop a claim after a send that definitely did not go out, so it can be tried again. */
  releaseSend(key: string): Promise<void>;
  isWakeClosed(wakeId: string, now: number): Promise<boolean>;
  /**
   * Remember Telegram message ids this wake posted via `/send`, so `/send/edit`
   * can refuse every other id. Kept for the reply token's remaining life.
   */
  noteOutbound(wakeId: string, messageIds: readonly number[], now: number, ttlMs: number): Promise<void>;
  /** True when this wake posted `messageId` and the record has not expired. */
  ownsOutbound(wakeId: string, messageId: number, now: number): Promise<boolean>;
  /**
   * Overflow bubbles already posted for a final edit of `messageId` that still
   * has a tail to send. A retry of that edit skips these instead of duplicating them.
   */
  getEditTail(wakeId: string, now: number): Promise<EditTail | null>;
  setEditTail(wakeId: string, tail: EditTail | null, now: number, ttlMs: number): Promise<void>;
  /**
   * Exclusive lock for edits of one message. Returns an owner token when this
   * caller holds it, or null when another edit still holds it. An expired lock
   * can be taken. Release only with the same token, so a late release cannot
   * drop a lock someone else has since acquired.
   */
  claimEditLock(key: string, now: number, ttlMs: number): Promise<string | null>;
  releaseEditLock(key: string, token: string): Promise<void>;
  /** The open forward burst in this chat and topic, or null. */
  peekBurst(scopeKey: string): Promise<BurstPeek | null>;
  /**
   * Open a burst or append to the one from the same sender.
   * Read-modify-write stays inside this call so two updates cannot lose an item.
   */
  stageBurst(input: {
    scopeKey: string;
    item: BurstItem;
    shortTerm: ContextMessage[];
    senderKey: string;
    now: number;
    debounceMs: number;
    maxItems: number;
    create: boolean;
  }): Promise<BurstStage>;
  /**
   * Remove the burst when `generation` is still current. A newer message bumps
   * the generation, so the earlier waiter gets null and does not deliver.
   */
  takeBurst(scopeKey: string, generation: number): Promise<PendingBurst | null>;
}

/** Message ids already sent after an edited first chunk, when the rest of a final edit did not finish. */
export interface EditTail {
  messageId: number;
  overflowIds: number[];
}

/** Cap the allowlist so one busy wake cannot grow the record without bound. */
export const MAX_OUTBOUND_IDS = 64;

export function cleanMessageIds(ids: readonly unknown[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of ids) {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > MAX_OUTBOUND_IDS ? out.slice(out.length - MAX_OUTBOUND_IDS) : out;
}

export function normalizeEditTail(value: unknown): EditTail | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.messageId !== "number" || !Number.isSafeInteger(record.messageId) || record.messageId <= 0) {
    return null;
  }
  return { messageId: record.messageId, overflowIds: cleanMessageIds(Array.isArray(record.overflowIds) ? record.overflowIds : []) };
}

/**
 * One idempotent /send. `pending` while it is in flight (or if the instance
 * died mid-send), `sent` once Telegram accepted every part, `ambiguous` when
 * Telegram may or may not have posted it. Only `sent` is answered with
 * already_sent; the other two are never resent.
 */
export interface SendRecord {
  state: "pending" | "sent" | "ambiguous";
  message_ids: number[];
}

export function normalizeSendRecord(value: unknown): SendRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.state !== "pending" && record.state !== "sent" && record.state !== "ambiguous") return null;
  const ids = Array.isArray(record.message_ids)
    ? record.message_ids.filter((id): id is number => typeof id === "number")
    : [];
  return { state: record.state, message_ids: ids };
}

export function scopeKey(chatId: string, threadId: number | null): string {
  return `chat:${chatId}:thread:${threadId ?? "root"}`;
}

export function chatIdFromScope(key: string): string {
  const marker = ":thread:";
  const start = "chat:".length;
  const idx = key.lastIndexOf(marker);
  if (!key.startsWith("chat:") || idx < start) return "";
  return key.slice(start, idx);
}

export function rateChatKey(chatId: string): string {
  return `rate:chat:${chatId}`;
}

export function rateUserKey(chatId: string, userId: string): string {
  return `rate:chat:${chatId}:user:${userId}`;
}

export function chatIdFromRateKey(key: string): string {
  const prefix = "rate:chat:";
  if (!key.startsWith(prefix)) return "";
  const rest = key.slice(prefix.length);
  const userIdx = rest.indexOf(":user:");
  return userIdx === -1 ? rest : rest.slice(0, userIdx);
}

/**
 * How long a message that started a wake is remembered, so an edit of it does
 * not start another. Matches the age past which context is no longer attached.
 */
export const MESSAGE_CLAIM_TTL_MS = 7 * 24 * 3600 * 1000;

/** Context older than this (by Telegram message date) is not attached to wakes. */
export const CONTEXT_MAX_AGE_SECONDS = 7 * 24 * 3600;

/** Previous buffer for `message`: capped at `limit`, without itself or entries a week older than it. */
export function freshContext(previous: readonly ContextMessage[], message: ContextMessage, limit: number): ContextMessage[] {
  const cutoff = message.date === null ? null : message.date - CONTEXT_MAX_AGE_SECONDS;
  // Same message_id = a Telegram retry or an edit; never report the current message as prior context.
  const fresh = previous.filter((item) =>
    item.message_id !== message.message_id && (cutoff === null || item.date === null || item.date >= cutoff));
  return fresh.slice(-limit);
}

/** Bound memory in long-lived single-process deployments. */
const MAX_MEMORY_SCOPES = 1000;

interface Bucket {
  windowStart: number;
  count: number;
}

export class MemoryStore implements Store {
  private readonly updates = new Map<number, number>();
  private readonly messages = new Map<string, number>();
  private readonly callbacks = new Map<string, number>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly contexts = new Map<string, ContextMessage[]>();
  private readonly typing = new Map<string, TypingScope>();
  private readonly closedWakes = new Map<string, number>();
  private readonly sends = new Map<string, { until: number; record: SendRecord }>();
  private readonly outbound = new Map<string, { until: number; ids: number[]; tail: EditTail | null }>();
  private readonly editLocks = new Map<string, { until: number; token: string }>();
  private readonly bursts = new Map<string, PendingBurst>();

  async claimUpdate(updateId: number, now: number, ttlMs: number): Promise<"new" | "duplicate"> {
    this.pruneUpdates(now);
    const expiry = this.updates.get(updateId);
    if (expiry !== undefined && expiry > now) return "duplicate";
    this.updates.set(updateId, now + ttlMs);
    return "new";
  }

  async releaseUpdate(updateId: number): Promise<void> {
    this.updates.delete(updateId);
  }

  async claimMessage(chatId: string, messageId: number, now: number, ttlMs: number): Promise<"new" | "duplicate"> {
    for (const [key, expiry] of this.messages) {
      if (expiry <= now) this.messages.delete(key);
    }
    const key = `${chatId}:${messageId}`;
    const expiry = this.messages.get(key);
    if (expiry !== undefined && expiry > now) return "duplicate";
    this.messages.set(key, now + ttlMs);
    return "new";
  }

  async claimCallback(chatId: string, messageId: number, now: number, ttlMs: number): Promise<"new" | "duplicate"> {
    for (const [key, expiry] of this.callbacks) {
      if (expiry <= now) this.callbacks.delete(key);
    }
    const key = `${chatId}:${messageId}`;
    const expiry = this.callbacks.get(key);
    if (expiry !== undefined && expiry > now) return "duplicate";
    this.callbacks.set(key, now + ttlMs);
    return "new";
  }

  async hitRate(
    bucketKey: string,
    now: number,
    windowMs: number,
    max: number,
  ): Promise<{ allowed: boolean; count: number }> {
    const windowStart = Math.floor(now / windowMs) * windowMs;
    let bucket = this.buckets.get(bucketKey);
    if (!bucket || bucket.windowStart !== windowStart) {
      bucket = { windowStart, count: 0 };
      for (const [key, value] of this.buckets) {
        if (value.windowStart < windowStart) this.buckets.delete(key);
      }
    }
    bucket.count += 1;
    this.buckets.set(bucketKey, bucket);
    return { allowed: bucket.count <= max, count: bucket.count };
  }

  async pushContext(key: string, message: ContextMessage, limit: number): Promise<ContextMessage[]> {
    const previous = this.contexts.get(key) ?? [];
    const prior = freshContext(previous, message, limit);
    // Re-insert so Map order is least recently used first, then evict.
    this.contexts.delete(key);
    this.contexts.set(key, [...prior, message].slice(-limit));
    while (this.contexts.size > MAX_MEMORY_SCOPES) {
      const oldest = this.contexts.keys().next().value;
      if (oldest === undefined) break;
      this.contexts.delete(oldest);
    }
    return prior;
  }

  async getTyping(key: string): Promise<TypingScope | null> {
    const scope = this.typing.get(key);
    return scope ? structuredClone(scope) : null;
  }

  async setTyping(key: string, scope: TypingScope | null): Promise<void> {
    if (scope && Object.keys(scope.wakes).length > 0) {
      // In "once" mode no timer clears a scope, so drop the ones past every wake's ceiling here.
      const latest = Math.max(...Object.values(scope.wakes).map((wake) => wake.startedAt));
      for (const [other, value] of this.typing) {
        if (other !== key && scopeDeadline(value) <= latest) this.typing.delete(other);
      }
      this.typing.set(key, structuredClone(scope));
    } else {
      this.typing.delete(key);
    }
  }

  async closeWake(wakeId: string, now: number, ttlMs: number): Promise<void> {
    this.pruneWakes(now);
    this.closedWakes.set(wakeId, now + ttlMs);
  }

  async isWakeClosed(wakeId: string, now: number): Promise<boolean> {
    const expiry = this.closedWakes.get(wakeId);
    if (expiry === undefined) return false;
    if (expiry <= now) {
      this.closedWakes.delete(wakeId);
      return false;
    }
    return true;
  }

  async claimSend(key: string, now: number, ttlMs: number): Promise<SendRecord | null> {
    for (const [other, entry] of this.sends) {
      if (entry.until <= now) this.sends.delete(other);
    }
    const existing = this.sends.get(key);
    if (existing) return structuredClone(existing.record);
    this.sends.set(key, { until: now + ttlMs, record: { state: "pending", message_ids: [] } });
    return null;
  }

  async finishSend(key: string, record: SendRecord, now: number, ttlMs: number): Promise<void> {
    this.sends.set(key, { until: now + ttlMs, record: structuredClone(record) });
  }

  async releaseSend(key: string): Promise<void> {
    this.sends.delete(key);
  }

  async noteOutbound(wakeId: string, messageIds: readonly number[], now: number, ttlMs: number): Promise<void> {
    const adding = cleanMessageIds(messageIds);
    if (adding.length === 0) return;
    const current = this.liveOutbound(wakeId, now);
    const ids = cleanMessageIds([...(current?.ids ?? []), ...adding]);
    this.outbound.set(wakeId, { until: now + ttlMs, ids, tail: current?.tail ?? null });
  }

  async ownsOutbound(wakeId: string, messageId: number, now: number): Promise<boolean> {
    const current = this.liveOutbound(wakeId, now);
    return current !== null && current.ids.includes(messageId);
  }

  async getEditTail(wakeId: string, now: number): Promise<EditTail | null> {
    return this.liveOutbound(wakeId, now)?.tail ?? null;
  }

  async claimEditLock(key: string, now: number, ttlMs: number): Promise<string | null> {
    for (const [other, entry] of this.editLocks) {
      if (entry.until <= now) this.editLocks.delete(other);
    }
    const existing = this.editLocks.get(key);
    if (existing && existing.until > now) return null;
    const token = crypto.randomUUID();
    this.editLocks.set(key, { until: now + ttlMs, token });
    return token;
  }

  async releaseEditLock(key: string, token: string): Promise<void> {
    const existing = this.editLocks.get(key);
    if (existing && existing.token === token) this.editLocks.delete(key);
  }

  async setEditTail(wakeId: string, tail: EditTail | null, now: number, ttlMs: number): Promise<void> {
    const current = this.liveOutbound(wakeId, now);
    const normalized = tail ? normalizeEditTail(tail) : null;
    if (!current && !normalized) return;
    this.outbound.set(wakeId, {
      until: now + ttlMs,
      ids: current?.ids ?? [],
      tail: normalized,
    });
  }

  private liveOutbound(wakeId: string, now: number): { until: number; ids: number[]; tail: EditTail | null } | null {
    for (const [key, entry] of this.outbound) {
      if (entry.until <= now) this.outbound.delete(key);
    }
    const entry = this.outbound.get(wakeId);
    return entry && entry.until > now ? entry : null;
  }

  async peekBurst(scopeKey: string): Promise<BurstPeek | null> {
    const burst = this.bursts.get(scopeKey);
    if (!burst) return null;
    return { generation: burst.generation, senderKey: burst.senderKey, flushAt: burst.flushAt, size: burst.items.length };
  }

  async stageBurst(input: {
    scopeKey: string;
    item: BurstItem;
    shortTerm: ContextMessage[];
    senderKey: string;
    now: number;
    debounceMs: number;
    maxItems: number;
    create: boolean;
  }): Promise<BurstStage> {
    const existing = this.bursts.get(input.scopeKey);
    if (existing && existing.flushAt <= input.now) {
      return { joined: false, generation: 0, delayMs: 0, overdueGeneration: existing.generation };
    }
    if (existing && existing.senderKey !== input.senderKey) {
      return { joined: false, generation: 0, delayMs: 0 };
    }
    if (!existing) {
      if (!input.create) return { joined: false, generation: 0, delayMs: 0 };
      const created: PendingBurst = {
        generation: 1,
        senderKey: input.senderKey,
        flushAt: input.now + input.debounceMs,
        shortTerm: input.shortTerm,
        items: [input.item],
      };
      this.rememberBurst(input.scopeKey, created, input.now);
      return { joined: true, generation: 1, delayMs: input.debounceMs };
    }
    existing.generation += 1;
    existing.flushAt = input.now + input.debounceMs;
    existing.items.push(input.item);
    while (existing.items.length > input.maxItems) existing.items.shift();
    this.rememberBurst(input.scopeKey, existing, input.now);
    return { joined: true, generation: existing.generation, delayMs: input.debounceMs };
  }

  async takeBurst(scopeKey: string, generation: number): Promise<PendingBurst | null> {
    const existing = this.bursts.get(scopeKey);
    if (!existing || existing.generation !== generation) return null;
    this.bursts.delete(scopeKey);
    return structuredClone(existing);
  }

  /** Least-recently-used order, dropping bursts whose waiter is long gone. */
  private rememberBurst(scopeKey: string, burst: PendingBurst, now: number): void {
    this.bursts.delete(scopeKey);
    this.bursts.set(scopeKey, burst);
    for (const [key, value] of this.bursts) {
      if (key !== scopeKey && value.flushAt < now - 60_000) this.bursts.delete(key);
    }
    while (this.bursts.size > MAX_MEMORY_SCOPES) {
      const oldest = this.bursts.keys().next().value;
      if (oldest === undefined || oldest === scopeKey) break;
      this.bursts.delete(oldest);
    }
  }

  private pruneUpdates(now: number): void {
    for (const [id, expiry] of this.updates) {
      if (expiry <= now) this.updates.delete(id);
    }
  }

  private pruneWakes(now: number): void {
    for (const [id, expiry] of this.closedWakes) {
      if (expiry <= now) this.closedWakes.delete(id);
    }
  }
}
