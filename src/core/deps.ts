import { collectSecrets, createLogger, safeErrorMessage, type Logger } from "./log.js";
import { loadConfig, type Config } from "./config.js";
import { MemoryStore, type Store } from "./store.js";
import { createStoreTyping, telegramEffects, type TypingController } from "./typing.js";
import { createTelegramClient, type TelegramClient } from "./telegram.js";

export interface AppDeps {
  config: Config;
  store: Store;
  typing: TypingController;
  telegram: TelegramClient;
  fetchImpl: typeof fetch;
  waitUntil: (promise: Promise<unknown>) => void;
  /** Wall-clock wait. The forward burst uses this; tests can hold it open. */
  delay: (ms: number) => Promise<void>;
  now: () => number;
  log: Logger;
}

export interface BuildDepsOptions {
  env: Record<string, string | undefined>;
  store?: Store;
  typing?: TypingController;
  typingMode?: "interval" | "once";
  fetchImpl?: typeof fetch;
  waitUntil?: (promise: Promise<unknown>) => void;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export function buildDeps(options: BuildDepsOptions): AppDeps {
  const config = loadConfig(options.env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const store = options.store ?? new MemoryStore();
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? createLogger(collectSecrets([
    config.telegramBotToken,
    config.telegramWebhookSecret,
    config.grokWebhookSenderKey,
    config.replyTokenSecret,
    config.outboundApiKey ?? "",
    config.speech?.apiKey ?? "",
  ]));
  const telegramOptions: Parameters<typeof createTelegramClient>[0] = {
    token: config.telegramBotToken,
    fetchImpl,
  };
  if (options.sleep) telegramOptions.sleep = options.sleep;
  const telegram = createTelegramClient(telegramOptions);
  const typing = options.typing ?? createStoreTyping({
    store,
    mode: options.typingMode ?? "interval",
    now,
    effects: telegramEffects(telegram, log),
  });
  return {
    config,
    store,
    typing,
    telegram,
    fetchImpl,
    waitUntil: options.waitUntil ?? ((promise) => {
      promise.catch(() => undefined);
    }),
    delay: options.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    now,
    log,
  };
}

export function runInBackground(deps: AppDeps, event: string, task: () => Promise<void>): void {
  const pending = task().catch((err: unknown) => {
    deps.log({ event, error: safeErrorMessage(err, []) });
  });
  deps.waitUntil(pending);
}
