import type { Config } from "./config.js";
import type { AddressResult, TelegramEntity, TelegramMessage } from "./types.js";

export function messageText(message: TelegramMessage): string {
  return message.text ?? message.caption ?? "";
}

/**
 * Forum topic id, or null. Replies in a non-forum supergroup also carry
 * message_thread_id, but sendMessage only accepts it for real topics.
 */
export function topicThreadId(message: TelegramMessage): number | null {
  if (message.is_topic_message !== true) return null;
  return typeof message.message_thread_id === "number" ? message.message_thread_id : null;
}

/**
 * The human behind a message, or null. When sender_chat is set the message was
 * sent as a chat (anonymous admin, or a user posting as a channel) and `from`
 * is a placeholder account, so it must not match ALLOWLIST_USER_IDS.
 */
export function senderUser(message: TelegramMessage): TelegramMessage["from"] | undefined {
  return message.sender_chat ? undefined : message.from;
}

export function messageEntities(message: TelegramMessage): TelegramEntity[] {
  return message.entities ?? message.caption_entities ?? [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ParsedCommand {
  name: string;
  target: string | null;
  forThisBot: boolean;
}

export function parseCommand(
  text: string,
  entities: readonly TelegramEntity[],
  botUsername: string,
): ParsedCommand | null {
  const entity = entities.find((item) => item.type === "bot_command");
  let raw = "";
  if (entity && entity.offset === 0) {
    raw = text.slice(entity.offset, entity.offset + entity.length);
  } else {
    const match = /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?/.exec(text);
    raw = match?.[0] ?? "";
  }
  if (!raw.startsWith("/")) return null;
  const body = raw.slice(1);
  const [nameRaw, targetRaw] = body.split("@");
  const name = (nameRaw ?? "").toLowerCase();
  if (!/^[a-z0-9_]{1,32}$/.test(name)) return null;
  const target = targetRaw ? targetRaw.toLowerCase() : null;
  const ours = botUsername.toLowerCase();
  const forThisBot = target === null || (ours.length > 0 && target === ours);
  return { name, target, forThisBot };
}

/**
 * Spoken stand-in for an @mention. A voice note or video note cannot carry a
 * mention entity. The transcript counts only when it contains this bot's
 * username as a whole word, with or without a leading @. A display name is
 * not matched: the bridge does not know one, and a common first name would
 * wake on ordinary speech. Usernames shorter than five characters are ignored.
 */
export function transcriptAddressesBot(text: string, botUsername: string): boolean {
  const username = botUsername.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) return false;
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9_])@?${escapeRegExp(username)}(?![A-Za-z0-9_])`, "i");
  return pattern.test(text);
}

export function mentionsBot(
  text: string,
  entities: readonly TelegramEntity[],
  botUsername: string,
): boolean {
  const username = botUsername.toLowerCase();
  if (!username) return false;
  for (const entity of entities) {
    if (entity.type !== "mention") continue;
    const raw = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
    if (raw === `@${username}`) return true;
  }
  const pattern = new RegExp(`(?:^|\\s)@${escapeRegExp(username)}\\b`, "i");
  return pattern.test(text);
}

export function isReplyToBot(
  message: TelegramMessage,
  config: Pick<Config, "telegramBotUsername" | "telegramBotId">,
): boolean {
  const from = message.reply_to_message?.from;
  if (!from) return false;
  if (config.telegramBotId && String(from.id) === config.telegramBotId) return true;
  const username = from.username?.toLowerCase();
  const ours = config.telegramBotUsername.toLowerCase();
  return Boolean(username && ours && username === ours);
}

export function classifyAddress(
  message: TelegramMessage,
  config: Pick<Config, "telegramBotUsername" | "telegramBotId" | "wakeCommands">,
): AddressResult {
  const text = messageText(message);
  const entities = messageEntities(message);
  const command = parseCommand(text, entities, config.telegramBotUsername);
  const commandName = command?.forThisBot ? command.name : null;
  const configuredCommand = Boolean(commandName && config.wakeCommands.has(commandName));

  if (message.chat.type === "private") {
    return { addressed: true, how: "private", command: commandName };
  }

  if (configuredCommand && commandName) {
    return { addressed: true, how: "command", command: commandName };
  }
  if (mentionsBot(text, entities, config.telegramBotUsername)) {
    return { addressed: true, how: "mention", command: commandName };
  }
  if (isReplyToBot(message, config)) {
    return { addressed: true, how: "reply", command: commandName };
  }
  return { addressed: false, how: null, command: commandName };
}
