export const DEFAULT_BOT_COMMANDS = [
  { command: "ask", description: "Ask the assistant" },
  { command: "help", description: "How to talk to the assistant" },
] as const;

export function setWebhookBody(webhookUrl: string, secretToken: string): {
  url: string;
  secret_token: string;
  allowed_updates: string[];
  drop_pending_updates: boolean;
} {
  return {
    url: webhookUrl,
    secret_token: secretToken,
    allowed_updates: ["message", "edited_message", "callback_query"],
    drop_pending_updates: false,
  };
}

export function setMyCommandsBody(): {
  commands: { command: string; description: string }[];
} {
  return { commands: DEFAULT_BOT_COMMANDS.map((command) => ({ ...command })) };
}
