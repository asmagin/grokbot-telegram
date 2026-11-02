import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBots } from "../src/core/bots.js";
import { startNodeServer } from "../src/adapters/node/server.js";
import { vercelFetch, resetVercelShared } from "../src/adapters/vercel/handler.js";
import { handleCloudflare } from "../src/adapters/cloudflare/worker.js";
import { ChatSession } from "../src/adapters/cloudflare/session.js";
import type { DoNamespace } from "../src/adapters/cloudflare/backend.js";
import { createFetchMock, dmUpdate, memoryStorage, testEnv, webhookRequest } from "./helpers.js";
import type { WakeEvent } from "../src/core/types.js";

function multiEnv() {
  const bot = (id: string, token: string) => {
    const env = testEnv({
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_BOT_USERNAME: `${id}bot`,
      TELEGRAM_WEBHOOK_SECRET: `webhook-secret-${id}`,
      REPLY_TOKEN_SECRET: `reply-secret-${id}-012345678901234567890123456789`,
      GROK_WEBHOOK_URL: `https://grok.example/hook/${id}`,
      FORWARD_BURST_MS: "0",
    });
    delete (env as Partial<typeof env>).PUBLIC_BASE_URL;
    return env;
  };
  return {
    PUBLIC_BASE_URL: "https://bridge.example",
    TELEGRAM_BOTS: JSON.stringify({ alpha: bot("alpha", "111:alpha"), beta: bot("beta", "222:beta") }),
  };
}

afterEach(() => { vi.unstubAllGlobals(); resetVercelShared(); vi.useRealTimers(); });

describe("bot registry", () => {
  it("keeps legacy configuration and mounts named bots under the prefix", () => {
    expect(loadBots(testEnv())[0]?.id).toBeNull();
    expect(loadBots({ ...multiEnv(), PATH_PREFIX: "/bridge/" }).map((b) => b.env.PATH_PREFIX))
      .toEqual(["/bridge/bots/alpha", "/bridge/bots/beta"]);
  });
  it("fails closed without echoing invalid JSON or accepting shared credentials", () => {
    expect(() => loadBots({ TELEGRAM_BOTS: 'secret bad JSON' })).toThrow(/^invalid_TELEGRAM_BOTS$/);
    const env = multiEnv();
    const bots = JSON.parse(env.TELEGRAM_BOTS);
    bots.beta.REPLY_TOKEN_SECRET = bots.alpha.REPLY_TOKEN_SECRET;
    expect(() => loadBots({ ...env, TELEGRAM_BOTS: JSON.stringify(bots) })).toThrow("invalid_TELEGRAM_BOTS");
  });
  it("does not inherit credentials or allowlists from the legacy bot", () => {
    const env = multiEnv();
    const bots = JSON.parse(env.TELEGRAM_BOTS);
    delete bots.alpha.ALLOWLIST_USER_IDS;
    delete bots.alpha.ALLOWLIST_CHAT_IDS;
    const selected = loadBots({ ...testEnv(), ...env, TELEGRAM_BOTS: JSON.stringify(bots) });
    expect(selected[0]?.env.ALLOWLIST_USER_IDS).toBeUndefined();
    delete bots.alpha.REPLY_TOKEN_SECRET;
    expect(() => loadBots({ ...testEnv(), ...env, TELEGRAM_BOTS: JSON.stringify(bots) })).toThrow();
  });
});

for (const host of ["node", "vercel", "cloudflare"] as const) {
  it(`${host}: isolates identical updates and chats, tokens, replies and context`, async () => {
    const env = multiEnv();
    const mock = createFetchMock();
    const tasks: Promise<unknown>[] = [];
    const sessions = new Map<string, ChatSession>();
    const stores = new Map<string, ReturnType<typeof memoryStorage>>();
    const namespace: DoNamespace = {
      idFromName: (name) => ({ toString: () => name }),
      get(id) {
        const name = id.toString();
        if (!sessions.has(name)) {
          const storage = memoryStorage();
          stores.set(name, storage);
          sessions.set(name, new ChatSession({ storage }, env));
        }
        return { fetch: (input, init) => sessions.get(name)!.fetch(new Request(input, init)) };
      },
    };
    const server = host === "node" ? await startNodeServer({ env, fetchImpl: mock.fetchImpl, typingMode: "once" }) : null;
    const localFetch = globalThis.fetch;
    if (host === "cloudflare") vi.stubGlobal("fetch", mock.fetchImpl);
    const call = async (request: Request) => {
      if (server) {
        const url = new URL(request.url);
        return localFetch(new Request(`${server.url}${url.pathname}`, request));
      }
      if (host === "vercel") return vercelFetch(request, env, undefined, mock.fetchImpl);
      return handleCloudflare(request, { ...env, CHAT_SESSION: namespace }, { waitUntil: (p) => tasks.push(p) });
    };
    const drain = async () => {
      await server?.drain();
      await Promise.all(tasks.splice(0));
      // Vercel waitUntil runs background work outside the response.
      await vi.waitFor(() => expect(mock.calls.filter((c) => c.url.startsWith("https://grok.example"))).toHaveLength(2));
    };
    try {
      const health = await call(new Request("https://bridge.example/healthz"));
      expect(await health.json()).toMatchObject({ ready: true, bots: { alpha: true, beta: true } });
      for (const id of ["alpha", "beta"]) {
        const response = await call(webhookRequest(dmUpdate(`hello ${id}`, 7), `webhook-secret-${id}`, `/bots/${id}/webhook`));
        expect(response.status).toBe(200);
      }
      await drain();
      const wakes = mock.calls.filter((c) => c.url.startsWith("https://grok.example")).map((c) => c.body as WakeEvent);
      expect(wakes.map((w) => w.idempotency_key).sort()).toEqual(["alpha:7", "beta:7"]);
      for (const wake of wakes) {
        expect(wake.short_term).toEqual([]);
        expect(wake.reply.send_url).toMatch(/\/bots\/(alpha|beta)\/send$/);
      }
      const alpha = wakes.find((w) => w.idempotency_key === "alpha:7")!;
      const send = (url: string) => new Request(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${alpha.reply.token}` }, body: JSON.stringify({ chat_id: "42", text: "answer", final: true }) });
      expect((await call(send("https://bridge.example/bots/beta/send"))).status).toBe(401);
      expect((await call(send(alpha.reply.send_url))).status).toBe(200);
      const sent = mock.calls.filter((c) => c.url.endsWith("/sendMessage"));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.url).toContain("bot111:alpha/");
      expect((await call(webhookRequest(dmUpdate("bad"), "webhook-secret-alpha", "/bots/beta/webhook"))).status).toBe(401);
      expect((await call(new Request("https://bridge.example/bots/missing/healthz"))).status).toBe(404);
      // Retrying either bot's update does not wake it again.
      for (const id of ["alpha", "beta"]) await call(webhookRequest(dmUpdate("retry", 7), `webhook-secret-${id}`, `/bots/${id}/webhook`));
      await drain();
      if (host === "cloudflare") {
        expect([...sessions.keys()].sort()).toEqual(["bot:alpha:chat:42", "bot:alpha:dedupe", "bot:beta:chat:42", "bot:beta:dedupe"]);
        mock.calls.length = 0;
        const storage = stores.get("bot:beta:chat:42")!;
        vi.setSystemTime(Date.now() + 3500);
        await new ChatSession({ storage }, env).alarm();
        expect(mock.calls.some((c) => c.url.includes("bot222:beta/sendChatAction"))).toBe(true);
        expect(mock.calls.every((c) => c.url.includes("bot222:beta/"))).toBe(true);
      }
    } finally { await server?.close(); }
  });
}
