import type { DoStorage } from "../src/adapters/cloudflare/do-storage.js";
import { buildDeps, type AppDeps } from "../src/core/deps.js";
import { handleRequest } from "../src/core/handler.js";
import type { TelegramUpdate } from "../src/core/types.js";

export const NOW = 1_700_000_000_000;

export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    TELEGRAM_BOT_TOKEN: "123456:ABCDEFghij",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret-value",
    TELEGRAM_BOT_USERNAME: "testbot",
    TELEGRAM_BOT_ID: "999",
    GROK_WEBHOOK_URL: "https://grok.example/hook",
    GROK_WEBHOOK_SENDER_KEY: "sender-key-value",
    REPLY_TOKEN_SECRET: "reply-token-secret-for-tests-only-0123456789",
    PUBLIC_BASE_URL: "https://bridge.example",
    ALLOWLIST_USER_IDS: "42",
    ALLOWLIST_CHAT_IDS: "-500",
    ...overrides,
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect?: RequestInit["redirect"];
}

export function createFetchMock(handler?: (call: RecordedCall) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let body: unknown = init?.body ?? null;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body) as unknown;
      } catch {
        // Keep the raw string.
      }
    }
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      body,
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    };
    calls.push(call);
    if (handler) return handler(call);
    return defaultResponse(call, calls.length);
  };
  return { fetchImpl, calls };
}

/** Telegram and Grok Bot both accept everything. */
export function defaultResponse(call: RecordedCall, count: number): Response {
  const url = call.url;
  if (url.includes("api.telegram.org") && /\/(sendChatAction|setMessageReaction|sendMessageDraft|answerCallbackQuery|editMessageReplyMarkup)$/.test(url)) {
    return Response.json({ ok: true, result: true });
  }
  if (url.includes("api.telegram.org") && /\/(sendMessage|sendPhoto|sendDocument)$/.test(url)) {
    return Response.json({ ok: true, result: { message_id: 70 + count } });
  }
  if (url.includes("api.telegram.org") && url.endsWith("/editMessageText")) {
    const messageId = typeof call.body === "object" && call.body && typeof (call.body as { message_id?: unknown }).message_id === "number"
      ? (call.body as { message_id: number }).message_id
      : 70 + count;
    return Response.json({ ok: true, result: { message_id: messageId } });
  }
  if (url.startsWith("https://grok.example/hook")) return new Response("accepted", { status: 202 });
  return new Response("unexpected", { status: 500 });
}

export function createTestApp(options: {
  env?: Record<string, string>;
  fetchImpl?: typeof fetch;
  now?: number;
  sleep?: (ms: number) => Promise<void>;
} = {}): { deps: AppDeps; tasks: Promise<unknown>[]; calls: RecordedCall[] } {
  const mock = createFetchMock();
  const tasks: Promise<unknown>[] = [];
  const deps = buildDeps({
    env: options.env ?? testEnv(),
    fetchImpl: options.fetchImpl ?? mock.fetchImpl,
    now: () => options.now ?? NOW,
    sleep: options.sleep ?? (async () => undefined),
    waitUntil(promise) {
      tasks.push(promise);
    },
    typingMode: "once",
    log: () => undefined,
  });
  return { deps, tasks, calls: mock.calls };
}

export async function settle(tasks: Promise<unknown>[]): Promise<void> {
  await Promise.all(tasks.splice(0));
}

export function webhookRequest(update: unknown, secret = "webhook-secret-value", path = "/webhook"): Request {
  return new Request(`https://bridge.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body: JSON.stringify(update),
  });
}

export async function postUpdate(deps: AppDeps, tasks: Promise<unknown>[], update: unknown, secret?: string): Promise<Response> {
  const response = await handleRequest(webhookRequest(update, secret), deps);
  await settle(tasks);
  return response;
}

export function dmUpdate(text: string, updateId = 1, extra: Record<string, unknown> = {}): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: 10 + updateId,
      date: 1_700_000_000,
      text,
      from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
      chat: { id: 42, type: "private" },
      ...extra,
    },
  };
}

export function groupUpdate(options: {
  text: string;
  updateId?: number;
  userId?: number;
  chatId?: number;
  replyTo?: Record<string, unknown>;
  threadId?: number;
  entities?: { type: string; offset: number; length: number }[];
  edited?: boolean;
}): TelegramUpdate {
  const message = {
    message_id: 30 + (options.updateId ?? 1),
    date: 1_700_000_000,
    text: options.text,
    from: { id: options.userId ?? 42, is_bot: false, first_name: "Ada", username: "ada" },
    chat: { id: options.chatId ?? -500, type: "supergroup", title: "Lab" },
    ...(options.threadId !== undefined ? { message_thread_id: options.threadId, is_topic_message: true } : {}),
    ...(options.entities ? { entities: options.entities } : {}),
    ...(options.replyTo ? { reply_to_message: options.replyTo } : {}),
  };
  return options.edited
    ? { update_id: options.updateId ?? 1, edited_message: message as TelegramUpdate["message"] }
    : { update_id: options.updateId ?? 1, message: message as TelegramUpdate["message"] };
}

export function memoryStorage(): DoStorage & { alarm: number | null } {
  const map = new Map<string, unknown>();
  return {
    alarm: null,
    async get<T>(key: string): Promise<T | undefined> {
      const value = map.get(key);
      return value === undefined ? undefined : structuredClone(value) as T;
    },
    async put<T>(key: string, value: T): Promise<void> {
      map.set(key, structuredClone(value));
    },
    async delete(key: string): Promise<boolean> {
      return map.delete(key);
    },
    async list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>> {
      const keys = [...map.keys()].filter((key) => key.startsWith(options.prefix)).sort();
      const out = new Map<string, T>();
      for (const key of keys.slice(0, options.limit ?? keys.length)) out.set(key, structuredClone(map.get(key)) as T);
      return out;
    },
    async getAlarm() {
      return this.alarm;
    },
    async setAlarm(time: number | Date) {
      this.alarm = typeof time === "number" ? time : time.getTime();
    },
    async deleteAlarm() {
      this.alarm = null;
    },
  };
}
