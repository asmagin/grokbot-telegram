import { handleDoAlarm, handleDoFetch, type DoStorage } from "./do-storage.js";

/**
 * One Durable Object class, two roles:
 * - name `dedupe` holds update-id claims and closed wake ids (serialized, so retries cannot double-wake)
 * - name `chat:<id>` holds that chat's context, rate limit, forward burst, and typing alarm
 */
export class ChatSession {
  private readonly storage: DoStorage;
  private readonly env: Record<string, unknown>;

  constructor(state: { storage: DoStorage }, env: Record<string, unknown>) {
    this.storage = state.storage;
    this.env = env;
  }

  fetch(request: Request): Promise<Response> {
    return handleDoFetch(this.storage, this.env, request);
  }

  alarm(): Promise<void> {
    return handleDoAlarm(this.storage, this.env);
  }
}
