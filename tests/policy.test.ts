import { describe, expect, it } from "vitest";
import { isAllowlisted, isOutboundChatAllowed } from "../src/core/allowlist.js";
import { classifyAddress, transcriptAddressesBot } from "../src/core/address.js";
import { loadConfig, parseIdList } from "../src/core/config.js";
import { setMyCommandsBody, setWebhookBody } from "../src/core/commands.js";
import { fastGreetingReply, splitTelegramText, truncateText } from "../src/core/text.js";
import type { TelegramMessage } from "../src/core/types.js";

const config = loadConfig({
  TELEGRAM_BOT_USERNAME: "@testbot",
  TELEGRAM_BOT_ID: "999",
  WAKE_COMMANDS: "/ask,/help",
  ALLOWLIST_USER_IDS: "42, 7",
  ALLOWLIST_CHAT_IDS: "-500",
});

function message(partial: Partial<TelegramMessage> & Pick<TelegramMessage, "chat">): TelegramMessage {
  return {
    message_id: 1,
    text: "",
    ...partial,
  };
}

describe("allowlist", () => {
  it("denies everyone when both lists are empty", () => {
    const closed = loadConfig({});
    expect(isAllowlisted("42", "42", closed)).toBe(false);
    expect(isOutboundChatAllowed("42", closed)).toBe(false);
  });

  it("admits a user id in any chat, and a chat id for every sender", () => {
    expect(isAllowlisted("42", "42", config)).toBe(true);
    expect(isAllowlisted("42", "-999", config)).toBe(true);
    expect(isAllowlisted("100", "-500", config)).toBe(true);
    expect(isAllowlisted("100", "-999", config)).toBe(false);
    expect(isAllowlisted(null, null, config)).toBe(false);
  });

  it("allows proactive sends only to listed chats or listed users' DMs", () => {
    expect(isOutboundChatAllowed("-500", config)).toBe(true);
    expect(isOutboundChatAllowed("42", config)).toBe(true);
    expect(isOutboundChatAllowed("-999", config)).toBe(false);
  });

  it("ignores non-numeric allowlist entries", () => {
    expect(parseIdList("42, nope, -100, 1.5")).toEqual(["42", "-100"]);
  });
});

describe("group wake rules", () => {
  it("wakes on every private message", () => {
    const result = classifyAddress(message({
      chat: { id: 42, type: "private" },
      text: "hello",
    }), config);
    expect(result).toMatchObject({ addressed: true, how: "private" });
  });

  it("ignores ordinary group chatter", () => {
    const result = classifyAddress(message({
      chat: { id: -500, type: "supergroup" },
      text: "anyone there?",
    }), config);
    expect(result.addressed).toBe(false);
  });

  it("wakes on an @mention", () => {
    const text = "hey @testbot";
    const result = classifyAddress(message({
      chat: { id: -500, type: "group" },
      text,
      entities: [{ type: "mention", offset: 4, length: 8 }],
    }), config);
    expect(result).toMatchObject({ addressed: true, how: "mention" });
  });

  it("wakes on a configured command, including the @bot suffix", () => {
    expect(classifyAddress(message({
      chat: { id: -500, type: "supergroup" },
      text: "/ask what time is it",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
    }), config)).toMatchObject({ addressed: true, how: "command", command: "ask" });

    expect(classifyAddress(message({
      chat: { id: -500, type: "supergroup" },
      text: "/help@testbot",
    }), config)).toMatchObject({ addressed: true, how: "command", command: "help" });
  });

  it("ignores commands aimed at a different bot and unconfigured commands", () => {
    expect(classifyAddress(message({
      chat: { id: -500, type: "supergroup" },
      text: "/ask@otherbot hello",
    }), config).addressed).toBe(false);
    expect(classifyAddress(message({
      chat: { id: -500, type: "supergroup" },
      text: "/start",
    }), config).addressed).toBe(false);
  });

  it("wakes when someone replies to the bot", () => {
    expect(classifyAddress(message({
      chat: { id: -500, type: "supergroup" },
      text: "and another thing",
      reply_to_message: {
        message_id: 8,
        text: "earlier",
        chat: { id: -500, type: "supergroup" },
        from: { id: 999, is_bot: true, username: "testbot" },
      },
    }), config)).toMatchObject({ addressed: true, how: "reply" });

    expect(classifyAddress(message({
      chat: { id: -500, type: "supergroup" },
      text: "replying to a person",
      reply_to_message: {
        message_id: 8,
        text: "earlier",
        chat: { id: -500, type: "supergroup" },
        from: { id: 5, is_bot: false, username: "sam" },
      },
    }), config).addressed).toBe(false);
  });
});

describe("spoken username", () => {
  it("matches the username as a whole word, with or without @", () => {
    expect(transcriptAddressesBot("hey testbot", "testbot")).toBe(true);
    expect(transcriptAddressesBot("@testbot what time is it", "testbot")).toBe(true);
    expect(transcriptAddressesBot("Hey TestBot,", "@testbot")).toBe(true);
    expect(transcriptAddressesBot("nottestbot", "testbot")).toBe(false);
    expect(transcriptAddressesBot("testbot2", "testbot")).toBe(false);
    expect(transcriptAddressesBot("see contestbot", "testbot")).toBe(false);
    expect(transcriptAddressesBot("hey bot", "bot")).toBe(false);
    expect(transcriptAddressesBot("", "testbot")).toBe(false);
  });
});

describe("text", () => {
  it("keeps short messages intact and splits long ones on paragraphs", () => {
    expect(splitTelegramText("hello")).toEqual(["hello"]);
    expect(splitTelegramText("a".repeat(4096))).toHaveLength(1);
    const paragraph = `${"a".repeat(3000)}\n\n${"b".repeat(2000)}`;
    const parts = splitTelegramText(paragraph);
    expect(parts.length).toBe(2);
    expect(parts[0]?.endsWith("a")).toBe(true);
    expect(parts[1]?.startsWith("b")).toBe(true);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(4096);
  });

  it("hard-splits text with no breaks", () => {
    const parts = splitTelegramText("x".repeat(5000));
    expect(parts.map((part) => part.length)).toEqual([4096, 904]);
  });

  it("truncates reply context", () => {
    expect(truncateText("z".repeat(5000)).length).toBe(4000);
  });

  it("recognizes only whole-message greetings", () => {
    expect(fastGreetingReply("ping", "testbot")).toBe("Pong.");
    expect(fastGreetingReply("@testbot thanks!", "testbot")).toBe("You're welcome.");
    expect(fastGreetingReply("ping me later", "testbot")).toBeNull();
  });
});

describe("telegram setup bodies", () => {
  it("registers the webhook with a secret, messages, and callback queries", () => {
    expect(setWebhookBody("https://bridge.example/webhook", "sekrit")).toEqual({
      url: "https://bridge.example/webhook",
      secret_token: "sekrit",
      allowed_updates: ["message", "edited_message", "callback_query"],
      drop_pending_updates: false,
    });
    expect(setMyCommandsBody().commands.map((command) => command.command)).toEqual(["ask", "help"]);
  });
});
