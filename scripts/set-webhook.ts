import { setWebhookBody } from "../src/core/commands.js";
import { isValidWebhookSecret, loadConfig } from "../src/core/config.js";
import { joinUrl } from "../src/core/text.js";
import { requireEnv, selectedEnv, telegramCall } from "./telegram-call.js";

const config = loadConfig(selectedEnv);
requireEnv("PUBLIC_BASE_URL");
requireEnv("TELEGRAM_WEBHOOK_SECRET");
if (!config.publicBaseUrl) {
  console.error(JSON.stringify({ ok: false, error: "public_base_url_invalid", hint: "https origin, no query or credentials" }));
  process.exit(1);
}
if (!isValidWebhookSecret(config.telegramWebhookSecret)) {
  console.error(JSON.stringify({ ok: false, error: "webhook_secret_invalid", hint: "16-256 chars of A-Z a-z 0-9 _ -" }));
  process.exit(1);
}
const webhookUrl = joinUrl(config.publicBaseUrl, config.pathPrefix, "/webhook");
await telegramCall("setWebhook", setWebhookBody(webhookUrl, config.telegramWebhookSecret));
