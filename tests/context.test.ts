import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/core/handler.js";
import { scopeKey } from "../src/core/store.js";
import { SCHEMA_VERSION, type WakeEvent } from "../src/core/types.js";
import {
  createTestApp,
  dmUpdate,
  groupUpdate,
  postUpdate,
  settle,
  testEnv,
  webhookRequest,
  type RecordedCall,
} from "./helpers.js";

function wakes(calls: RecordedCall[]): WakeEvent[] {
  return calls
    .filter((call) => call.url.startsWith("https://grok.example/hook"))
    .map((call) => call.body as WakeEvent);
}

function quietEnv(extra: Record<string, string> = {}): Record<string, string> {
  return testEnv({ FORWARD_BURST_MS: "0", ...extra });
}

function userOrigin(name = "Grace", username = "grace", date = 1_600_000_000) {
  return {
    type: "user",
    date,
    sender_user: { id: 7, first_name: name, is_bot: false, username },
  };
}

function gateDelay(): { pending: Array<() => void>; delay: (ms: number) => Promise<void>; release: () => void } {
  const pending: Array<() => void> = [];
  return {
    pending,
    delay(ms: number) {
      if (ms <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => pending.push(resolve));
    },
    release() {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

const mention = [{ type: "mention", offset: 0, length: 8 }];

describe("forward origin", () => {
  it("keeps origin, text, and attachments on a forwarded photo", async () => {
    const app = createTestApp({ env: quietEnv() });
    await postUpdate(app.deps, app.tasks, dmUpdate("", 4, {
      text: undefined,
      caption: "the shot",
      caption_entities: [{ type: "text_link", offset: 0, length: 8, url: "https://cdn.example/shot" }],
      photo: [{ file_id: "FWDPHOTOFILEID", width: 40, height: 40, file_size: 20 }],
      forward_origin: {
        type: "channel",
        date: 1_690_000_000,
        chat: { id: -100123, type: "channel", title: "Launch\nnotes", username: "launch" },
        message_id: 9,
        author_signature: "Ada\u0007",
      },
    }));
    const payload = wakes(app.calls)[0]!;
    expect(payload.message.text).toBe("the shot");
    expect(payload.message.attachments).toHaveLength(1);
    expect(payload.message.forward).toEqual({
      type: "channel",
      date: 1_690_000_000,
      sender_name: "Ada",
      username: "launch",
      chat_title: "Launch notes",
      message_id: 9,
    });
    expect(payload.message.links).toEqual([
      { kind: "text_link", url: "https://cdn.example/shot", text: "the shot" },
    ]);
    expect(payload.message.burst).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain("FWDPHOTOFILEID");
    expect(JSON.stringify(payload)).not.toContain("123456:ABCDEFghij");
  });

  it("reads a hidden user, a user, and the legacy forward fields", async () => {
    const app = createTestApp({ env: quietEnv() });
    await postUpdate(app.deps, app.tasks, dmUpdate("hidden", 1, {
      forward_origin: { type: "hidden_user", date: 10, sender_user_name: "Ann\u202Eevil" },
    }));
    await postUpdate(app.deps, app.tasks, dmUpdate("from user", 2, {
      forward_from: { id: 5, first_name: "Lin", last_name: "Doe", username: "lin" },
      forward_date: 1_600_000_000,
    }));
    await postUpdate(app.deps, app.tasks, dmUpdate("from chat", 3, {
      forward_from_chat: { id: -100, type: "channel", title: "C", username: "cee" },
      forward_from_message_id: 4,
      forward_signature: "Ed",
      forward_date: 1_600_000_100,
    }));
    const [hidden, user, channel] = wakes(app.calls);
    expect(hidden?.message.forward).toMatchObject({ type: "hidden_user", sender_name: "Annevil", username: null, date: 10 });
    expect(user?.message.forward).toEqual({
      type: "user",
      date: 1_600_000_000,
      sender_name: "Lin Doe",
      username: "lin",
      chat_title: null,
      message_id: null,
    });
    expect(channel?.message.forward).toMatchObject({
      type: "channel",
      sender_name: "Ed",
      username: "cee",
      chat_title: "C",
      message_id: 4,
    });
  });
});

describe("replies, quotes, and links", () => {
  it("includes a reply to someone other than the bot, with caption, sender, and file", async () => {
    const app = createTestApp({ env: quietEnv() });
    const update = dmUpdate("what about this", 3, {
      reply_to_message: {
        message_id: 8,
        caption: "parent caption",
        chat: { id: 42, type: "private" },
        from: { id: 100, is_bot: false, first_name: "Grace", username: "grace" },
        photo: [{ file_id: "PARENTPHOTOFILE", width: 10, height: 10, file_size: 20 }],
      },
      quote: { text: "parent\u0007 cap", position: 0, is_manual: true },
    });
    await postUpdate(app.deps, app.tasks, update);
    const payload = wakes(app.calls)[0]!;
    expect(payload.addressed_how).toBe("private");
    expect(payload.message.reply_to).toMatchObject({
      message_id: 8,
      text: "parent caption",
      from: { id: "100", username: "grace", first_name: "Grace", is_bot: false },
    });
    expect(payload.message.reply_to?.attachments).toHaveLength(1);
    expect(payload.message.reply_to?.attachments[0]?.file_url).toMatch(/^https:\/\/bridge\.example\/file\/f1~/);
    expect(payload.message.quote).toEqual({ text: "parent cap", position: 0, is_manual: true });
  });

  it("includes a group reply that is not to the bot when the bot was mentioned", async () => {
    const app = createTestApp({ env: quietEnv() });
    await postUpdate(app.deps, app.tasks, groupUpdate({
      text: "@testbot look",
      updateId: 2,
      entities: mention,
      replyTo: {
        message_id: 4,
        text: "not the bot",
        chat: { id: -500, type: "supergroup" },
        from: { id: 100, is_bot: false, first_name: "Sam", username: "sam" },
      },
    }));
    const payload = wakes(app.calls)[0]!;
    expect(payload.addressed_how).toBe("mention");
    expect(payload.message.reply_to?.text).toBe("not the bot");
    expect(payload.message.reply_to?.from?.username).toBe("sam");
    expect(payload.message.reply_to?.from?.is_bot).toBe(false);
  });

  it("passes external_reply origin and media, and does not fetch link urls", async () => {
    const app = createTestApp({ env: quietEnv() });
    const text = "see https://example.com/a plus more";
    const url = "https://example.com/a";
    const moreAt = text.indexOf("more");
    await postUpdate(app.deps, app.tasks, dmUpdate(text, 5, {
      entities: [
        { type: "url", offset: text.indexOf(url), length: url.length },
        { type: "text_link", offset: moreAt, length: 4, url: "https://user:pw@secret.example/x" },
        { type: "text_link", offset: moreAt, length: 4, url: "javascript:alert(1)" },
        { type: "text_link", offset: moreAt, length: 4, url: "https://notes.example/doc" },
      ],
      external_reply: {
        origin: {
          type: "channel",
          date: 1_700_000_000,
          chat: { id: -100, type: "channel", title: "News", username: "news" },
          message_id: 55,
        },
        chat: { id: -100, type: "channel", title: "News", username: "news" },
        message_id: 55,
        photo: [{ file_id: "EXTPHOTOFILEID", width: 8, height: 8, file_size: 12 }],
      },
    }));
    const payload = wakes(app.calls)[0]!;
    expect(payload.message.links).toEqual([
      { kind: "url", url: "https://example.com/a", text: null },
      { kind: "text_link", url: "https://notes.example/doc", text: "more" },
    ]);
    expect(payload.message.external_reply).toMatchObject({
      chat_title: "News",
      chat_username: "news",
      message_id: 55,
      origin: { type: "channel", chat_title: "News", username: "news", message_id: 55 },
    });
    expect(payload.message.external_reply?.attachments).toHaveLength(1);
    expect(payload.message.external_reply?.media).toEqual(["photo"]);
    expect(app.calls.some((call) => call.url.includes("example.com/a") || call.url.includes("notes.example"))).toBe(false);
  });

  it("caps links and drops entities that point past the text", async () => {
    const app = createTestApp({ env: quietEnv() });
    const urls = Array.from({ length: 11 }, (_, index) => `https://example.com/${index}`);
    const text = urls.join(" ");
    let offset = 0;
    const entities = urls.map((url) => {
      const entity = { type: "url", offset, length: url.length };
      offset += url.length + 1;
      return entity;
    });
    entities.push({ type: "url", offset: text.length + 5, length: 4 });
    await postUpdate(app.deps, app.tasks, dmUpdate(text, 1, { entities }));
    const links = wakes(app.calls)[0]!.message.links;
    expect(links).toHaveLength(10);
    expect(links[0]?.url).toBe(urls[0]);
    expect(links[9]?.url).toBe(urls[9]);
  });
});

describe("contacts, locations, venues, and polls", () => {
  it("passes a compact summary and drops a location that is not on earth", async () => {
    const app = createTestApp({ env: quietEnv() });
    await postUpdate(app.deps, app.tasks, dmUpdate("", 1, {
      text: undefined,
      contact: { phone_number: `+1${"5".repeat(40)}`, first_name: "Grace", last_name: "Hopper", user_id: 7, vcard: "BEGIN:VCARD" },
    }));
    await postUpdate(app.deps, app.tasks, dmUpdate("", 2, {
      text: undefined,
      location: { latitude: 40.5, longitude: -74.25, horizontal_accuracy: 12.5, live_period: 60 },
    }));
    await postUpdate(app.deps, app.tasks, dmUpdate("", 3, {
      text: undefined,
      location: { latitude: 999, longitude: 0 },
    }));
    await postUpdate(app.deps, app.tasks, dmUpdate("", 4, {
      text: undefined,
      venue: {
        title: "Office",
        address: "1 Main\nStreet",
        google_place_id: "place-1",
        foursquare_id: "fs-1",
        location: { latitude: 1.25, longitude: 2.5 },
      },
      location: { latitude: 1.25, longitude: 2.5 },
    }));
    const options = Array.from({ length: 12 }, (_, index) => ({ text: index === 0 ? `${"q".repeat(200)}` : `opt${index}`, voter_count: index }));
    await postUpdate(app.deps, app.tasks, dmUpdate("", 5, {
      text: undefined,
      poll: {
        id: "p",
        question: `Ship?\u0007${"y".repeat(400)}`,
        options,
        total_voter_count: 3,
        is_closed: false,
        is_anonymous: true,
        type: "quiz",
        allows_multiple_answers: false,
        correct_option_id: 1,
        explanation: "because",
      },
    }));
    const [contact, location, bad, venue, poll] = wakes(app.calls);
    expect(contact?.message.contact).toEqual({
      phone_number: `+1${"5".repeat(30)}`,
      first_name: "Grace",
      last_name: "Hopper",
      user_id: "7",
    });
    expect(contact?.message.contact?.phone_number?.length).toBeLessThanOrEqual(32);
    expect(JSON.stringify(contact)).not.toContain("VCARD");
    expect(location?.message.location).toEqual({
      latitude: 40.5,
      longitude: -74.25,
      horizontal_accuracy: 12.5,
      live_period: 60,
    });
    expect(location?.message.media).toEqual(["location"]);
    expect(bad?.message.location).toBeNull();
    expect(bad?.message.media).toEqual(["location"]);
    expect(venue?.message.media).toEqual(["location", "venue"]);
    expect(venue?.message.venue).toEqual({
      title: "Office",
      address: "1 Main Street",
      latitude: 1.25,
      longitude: 2.5,
      foursquare_id: "fs-1",
      google_place_id: "place-1",
    });
    expect(poll?.message.poll?.question.length).toBeLessThanOrEqual(300);
    expect(poll?.message.poll?.question.startsWith("Ship?")).toBe(true);
    expect(poll?.message.poll?.type).toBe("quiz");
    expect(poll?.message.poll?.options).toHaveLength(10);
    expect(poll?.message.poll?.options[0]?.text.length).toBeLessThanOrEqual(100);
    expect(poll?.message.poll?.correct_option_id).toBe(1);
    expect(poll?.message.poll?.is_anonymous).toBe(true);
    expect(JSON.stringify(poll?.message.poll)).not.toContain("because");
  });
});

describe("forward and comment burst", () => {
  it("keeps forwarded attachments when a buffered comment is edited", async () => {
    const gate = gateDelay();
    const app = createTestApp({ env: testEnv({ FORWARD_BURST_MS: "1500" }), delay: gate.delay });
    await handleRequest(webhookRequest(dmUpdate("", 1, {
      text: undefined,
      photo: [{ file_id: "EDITPHOTOFILE", width: 4, height: 4, file_size: 10 }],
      forward_origin: userOrigin(),
    })), app.deps);
    const comment = dmUpdate("describe this", 2);
    await handleRequest(webhookRequest(comment), app.deps);
    await handleRequest(webhookRequest({
      update_id: 3,
      edited_message: { ...comment.message, text: "describe this photo" },
    }), app.deps);
    gate.release();
    await settle(app.tasks);
    const delivered = wakes(app.calls);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ update_id: 3, edited: true });
    expect(delivered[0]?.message.text).toBe("describe this photo");
    expect(delivered[0]?.message.burst).toHaveLength(1);
    expect(delivered[0]?.message.burst[0]?.attachments).toHaveLength(1);
    expect(delivered[0]?.message.burst[0]?.forward?.username).toBe("grace");
  });

  it("does not let a delayed old timer flush a replacement burst", async () => {
    const gate = gateDelay();
    const app = createTestApp({ env: testEnv({ FORWARD_BURST_MS: "1500" }), delay: gate.delay });
    let now = app.deps.now();
    app.deps.now = () => now;
    await handleRequest(webhookRequest(dmUpdate("first", 1, { forward_origin: userOrigin() })), app.deps);
    const oldTimer = gate.pending.shift()!;
    now += 1600;
    await handleRequest(webhookRequest(dmUpdate("second", 2, { forward_origin: userOrigin() })), app.deps);
    oldTimer();
    await vi.waitUntil(() => wakes(app.calls).length === 1);
    expect(await app.deps.store.peekBurst(scopeKey("42", null))).not.toBeNull();
    await handleRequest(webhookRequest(dmUpdate("handle second", 3)), app.deps);
    gate.release();
    await settle(app.tasks);
    const delivered = wakes(app.calls);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]?.message.text).toBe("handle second");
    expect(delivered[1]?.message.burst.map((item) => item.text)).toEqual(["second"]);
  });

  it("merges a forward and the following comment into one wake", async () => {
    const gate = gateDelay();
    const app = createTestApp({
      env: testEnv({ FORWARD_BURST_MS: "1500" }),
      delay: gate.delay,
    });
    const forward = dmUpdate("original text", 1, { forward_origin: userOrigin() });
    const comment = dmUpdate("handle this", 2);
    expect((await handleRequest(webhookRequest(forward), app.deps)).status).toBe(200);
    const second = handleRequest(webhookRequest(comment), app.deps);
    await vi.waitUntil(() => gate.pending.length >= 2);
    gate.release();
    expect((await second).status).toBe(200);
    await settle(app.tasks);
    const delivered = wakes(app.calls);
    expect(delivered).toHaveLength(1);
    const payload = delivered[0]!;
    expect(payload.update_id).toBe(2);
    expect(payload.idempotency_key).toBe("2");
    expect(payload.message.message_id).toBe(12);
    expect(payload.message.text).toBe("handle this");
    expect(payload.message.forward).toBeNull();
    expect(payload.message.burst).toHaveLength(1);
    expect(payload.message.burst[0]).toMatchObject({
      message_id: 11,
      text: "original text",
      forward: { type: "user", sender_name: "Grace", username: "grace", date: 1_600_000_000 },
    });
  });

  it("keeps several forwards, in order, ahead of the comment", async () => {
    const gate = gateDelay();
    const app = createTestApp({
      env: testEnv({ FORWARD_BURST_MS: "1500" }),
      delay: gate.delay,
    });
    const first = dmUpdate("", 1, {
      text: undefined,
      caption: "pic",
      photo: [{ file_id: "BURSTPHOTOFILE", width: 4, height: 4, file_size: 10 }],
      forward_origin: userOrigin("A", "aaa", 100),
    });
    const second = dmUpdate("second", 2, { forward_origin: userOrigin("B", "bbb", 200) });
    const comment = dmUpdate("handle these", 3);
    expect((await handleRequest(webhookRequest(first), app.deps)).status).toBe(200);
    const mid = handleRequest(webhookRequest(second), app.deps);
    await vi.waitUntil(() => gate.pending.length >= 2);
    const last = handleRequest(webhookRequest(comment), app.deps);
    await vi.waitUntil(() => gate.pending.length >= 3);
    gate.release();
    await Promise.all([mid, last]);
    await settle(app.tasks);
    const payload = wakes(app.calls)[0]!;
    expect(wakes(app.calls)).toHaveLength(1);
    expect(payload.message.text).toBe("handle these");
    expect(payload.message.burst.map((item) => item.text)).toEqual(["pic", "second"]);
    expect(payload.message.burst[0]?.attachments).toHaveLength(1);
    expect(payload.message.burst[0]?.forward?.username).toBe("aaa");
    expect(payload.message.burst[1]?.forward?.username).toBe("bbb");
  });

  it("wakes a lone forward after the wait, with an empty burst", async () => {
    const gate = gateDelay();
    const app = createTestApp({
      env: testEnv({ FORWARD_BURST_MS: "1500" }),
      delay: gate.delay,
    });
    await handleRequest(webhookRequest(dmUpdate("just the forward", 1, { forward_origin: userOrigin() })), app.deps);
    expect(gate.pending).toHaveLength(1);
    expect(wakes(app.calls)).toHaveLength(0);
    gate.release();
    await settle(app.tasks);
    const payload = wakes(app.calls)[0]!;
    expect(payload.message.text).toBe("just the forward");
    expect(payload.message.forward?.type).toBe("user");
    expect(payload.message.burst).toEqual([]);
  });

  it("does not let another sender take the burst", async () => {
    const gate = gateDelay();
    const app = createTestApp({
      env: testEnv({ FORWARD_BURST_MS: "1500" }),
      delay: gate.delay,
    });
    const forward = groupUpdate({ text: "fwd body", updateId: 1, userId: 42 });
    (forward.message as { forward_origin?: unknown }).forward_origin = userOrigin();
    const comment = groupUpdate({
      text: "@testbot handle",
      updateId: 2,
      userId: 100,
      entities: mention,
    });
    await handleRequest(webhookRequest(forward), app.deps);
    await handleRequest(webhookRequest(comment), app.deps);
    expect(gate.pending).toHaveLength(1);
    gate.release();
    await settle(app.tasks);
    const delivered = wakes(app.calls);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.message.text).toBe("@testbot handle");
    expect(delivered[0]?.message.burst).toEqual([]);
    expect(delivered[0]?.from?.id).toBe("100");
    expect(delivered[0]?.short_term.map((item) => item.text)).toContain("fwd body");
  });

  it("folds a group forward into the same sender's mention", async () => {
    const gate = gateDelay();
    const app = createTestApp({
      env: testEnv({ FORWARD_BURST_MS: "1500" }),
      delay: gate.delay,
    });
    await postUpdate(app.deps, app.tasks, groupUpdate({ text: "earlier note", updateId: 1 }));
    const forward = groupUpdate({ text: "fwd body", updateId: 2, userId: 42 });
    (forward.message as { forward_origin?: unknown }).forward_origin = userOrigin();
    const comment = groupUpdate({
      text: "@testbot handle this",
      updateId: 3,
      userId: 42,
      entities: mention,
    });
    await handleRequest(webhookRequest(forward), app.deps);
    const second = handleRequest(webhookRequest(comment), app.deps);
    await vi.waitUntil(() => gate.pending.length >= 2);
    gate.release();
    await second;
    await settle(app.tasks);
    const delivered = wakes(app.calls);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.addressed_how).toBe("mention");
    expect(delivered[0]?.message.text).toBe("@testbot handle this");
    expect(delivered[0]?.message.burst.map((item) => item.text)).toEqual(["fwd body"]);
    expect(delivered[0]?.short_term.map((item) => item.text)).toEqual(["earlier note"]);
  });

  it("does not wake for a group forward that nobody follows", async () => {
    const gate = gateDelay();
    const app = createTestApp({
      env: testEnv({ FORWARD_BURST_MS: "1500" }),
      delay: gate.delay,
    });
    const forward = groupUpdate({ text: "noise", updateId: 1 });
    (forward.message as { forward_origin?: unknown }).forward_origin = userOrigin();
    await handleRequest(webhookRequest(forward), app.deps);
    gate.release();
    await settle(app.tasks);
    expect(wakes(app.calls)).toHaveLength(0);
  });

  it("leaves a comment that arrives first, and a forward with the wait disabled, as separate wakes", async () => {
    const app = createTestApp({ env: quietEnv() });
    await postUpdate(app.deps, app.tasks, dmUpdate("handle this", 1));
    await postUpdate(app.deps, app.tasks, dmUpdate("original", 2, { forward_origin: userOrigin() }));
    const delivered = wakes(app.calls);
    expect(delivered).toHaveLength(2);
    expect(delivered[0]?.message.text).toBe("handle this");
    expect(delivered[0]?.message.burst).toEqual([]);
    expect(delivered[1]?.message.forward?.type).toBe("user");
    expect(delivered[1]?.message.text).toBe("original");
  });
});

describe("wake schema file", () => {
  it("requires the context fields the bridge now sends", async () => {
    const schema = JSON.parse(readFileSync(new URL(`../schema/wake-event.v${SCHEMA_VERSION}.json`, import.meta.url), "utf8")) as {
      properties: {
        schema_version: { const: number };
        message: { required: string[]; properties: { reply_to: { oneOf: { $ref?: string }[] } } };
      };
      $defs: {
        reply_to: { required: string[] };
        forward_origin: { required: string[] };
        burst_item: { required: string[] };
        external_reply: { required: string[] };
      };
    };
    expect(schema.properties.schema_version.const).toBe(SCHEMA_VERSION);
    const app = createTestApp({ env: quietEnv() });
    const linked = "see https://example.com/a";
    const linkedUrl = "https://example.com/a";
    await postUpdate(app.deps, app.tasks, dmUpdate(linked, 1, {
      entities: [{ type: "url", offset: linked.indexOf(linkedUrl), length: linkedUrl.length }],
      reply_to_message: {
        message_id: 2,
        text: "parent",
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Ada" },
      },
      forward_origin: userOrigin(),
    }));
    const payload = wakes(app.calls)[0]!;
    expect(Object.keys(payload.message).sort()).toEqual([...schema.properties.message.required].sort());
    expect(Object.keys(payload.message.reply_to ?? {}).sort()).toEqual([...schema.$defs.reply_to.required].sort());
    expect(Object.keys(payload.message.forward ?? {}).sort()).toEqual([...schema.$defs.forward_origin.required].sort());
    expect(payload.message.links[0]?.url).toBe("https://example.com/a");
    expect(payload.schema_version).toBe(SCHEMA_VERSION);
  });
});

describe("burst store", () => {
  it("appends for the same sender, ignores another, and take is single-shot", async () => {
    const { MemoryStore } = await import("../src/core/store.js");
    const store = new MemoryStore();
    const item = (id: number, text: string) => ({
      updateId: id,
      addressedHow: "private" as const,
      command: null,
      message: {
        message_id: id,
        text,
        chat: { id: 1, type: "private" },
        from: { id: 1, first_name: "A" },
      },
    });
    const scope = scopeKey("1", null);
    const opened = await store.stageBurst({
      scopeKey: scope, item: item(1, "a"), shortTerm: [], senderKey: "user:1", now: 1000, debounceMs: 1500, maxItems: 8, create: true,
    });
    expect(opened).toMatchObject({ joined: true, generation: 1, delayMs: 1500 });
    const foreign = await store.stageBurst({
      scopeKey: scope, item: item(2, "nope"), shortTerm: [], senderKey: "user:2", now: 1100, debounceMs: 1500, maxItems: 8, create: true,
    });
    expect(foreign.joined).toBe(false);
    const joined = await store.stageBurst({
      scopeKey: scope, item: item(3, "b"), shortTerm: [], senderKey: "user:1", now: 1200, debounceMs: 1500, maxItems: 8, create: false,
    });
    expect(joined.generation).toBe(2);
    const capped = await store.stageBurst({
      scopeKey: scope, item: item(4, "c"), shortTerm: [], senderKey: "user:1", now: 1300, debounceMs: 1500, maxItems: 2, create: false,
    });
    expect(capped.generation).toBe(3);
    expect(await store.takeBurst(scope, 1)).toBeNull();
    const taken = await store.takeBurst(scope, 3);
    expect(taken?.items.map((entry) => entry.message.text)).toEqual(["b", "c"]);
    expect(await store.takeBurst(scope, 2)).toBeNull();
    expect(await store.peekBurst(scope)).toBeNull();
  });
});
