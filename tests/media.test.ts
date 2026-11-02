import { describe, expect, it } from "vitest";
import { buildDeps } from "../src/core/deps.js";
import { handleRequest } from "../src/core/handler.js";
import { routeBodyLimit } from "../src/core/http.js";
import { normalizePublicMediaUrl } from "../src/core/media.js";
import { SCHEMA_VERSION, TELEGRAM_GET_FILE_MAX_BYTES, type WakeEvent } from "../src/core/types.js";
import {
  createFetchMock,
  createTestApp,
  defaultResponse,
  dmUpdate,
  groupUpdate,
  NOW,
  postUpdate,
  testEnv,
  type RecordedCall,
} from "./helpers.js";

function mediaApp(options: {
  env?: Record<string, string>;
  handler?: (call: RecordedCall) => Response | Promise<Response> | undefined;
  now?: () => number;
} = {}) {
  const mock = createFetchMock(async (call) => {
    const custom = await options.handler?.(call);
    if (custom) return custom;
    if (call.url.endsWith("/sendPhoto") || call.url.endsWith("/sendDocument")) {
      return Response.json({ ok: true, result: { message_id: 90 } });
    }
    if (call.url.endsWith("/getFile")) {
      return Response.json({ ok: true, result: { file_path: "photos/a.jpg", file_size: 4 } });
    }
    if (call.url.includes("/file/bot")) {
      return new Response(Uint8Array.from([1, 2, 3, 4]), {
        headers: { "content-type": "text/html", "content-length": "4" },
      });
    }
    return defaultResponse(call, mock.calls.length);
  });
  const tasks: Promise<unknown>[] = [];
  const deps = buildDeps({
    env: options.env ?? testEnv(),
    fetchImpl: mock.fetchImpl,
    now: options.now ?? (() => NOW),
    sleep: async () => undefined,
    waitUntil: (promise) => tasks.push(promise),
    typingMode: "once",
    log: () => undefined,
  });
  return { deps, tasks, calls: mock.calls };
}

function wakeFrom(calls: RecordedCall[]): WakeEvent {
  const call = calls.find((item) => item.url.startsWith("https://grok.example/hook"));
  if (!call) throw new Error("missing wake");
  return call.body as WakeEvent;
}

async function photoWake(app: { deps: ReturnType<typeof mediaApp>["deps"]; tasks: Promise<unknown>[]; calls: RecordedCall[] }, updateId = 4): Promise<WakeEvent> {
  const update = dmUpdate("", updateId, {
    text: undefined,
    caption: "see this",
    photo: [
      { file_id: "smallPhoto", width: 90, height: 90, file_size: 100 },
      { file_id: "wideButSmall", width: 2000, height: 10, file_size: 50 },
      { file_id: "ZZPHOTOFILEIDZZ", width: 800, height: 600, file_size: 5000 },
    ],
  });
  await postUpdate(app.deps, app.tasks, update);
  return wakeFrom(app.calls);
}

describe("incoming attachments", () => {
  it("uses the caption as text and describes the largest photo without the file id or bot token", async () => {
    const app = mediaApp();
    const payload = await photoWake(app);
    expect(payload.schema_version).toBe(SCHEMA_VERSION);
    expect(payload.callback).toBeNull();
    expect(payload.message.text).toBe("see this");
    expect(payload.message.media).toEqual(["photo"]);
    expect(payload.message.attachments).toHaveLength(1);
    const attachment = payload.message.attachments[0]!;
    expect(attachment).toMatchObject({
      kind: "photo",
      mime_type: "image/jpeg",
      file_name: null,
      file_size: 5000,
      width: 800,
      height: 600,
      duration: null,
      unavailable: null,
    });
    expect(attachment.file_url).toMatch(/^https:\/\/bridge\.example\/file\/f1~/);
    expect(attachment.file_url).not.toContain("ZZPHOTOFILEIDZZ");
    expect(payload.reply.send_media_url).toBe("https://bridge.example/send/media");
    expect(JSON.stringify(payload)).not.toContain("123456:ABCDEFghij");
    expect(JSON.stringify(payload)).not.toContain("ZZPHOTOFILEIDZZ");
  });

  it("keeps an empty attachment list on a text message", async () => {
    const app = createTestApp();
    await postUpdate(app.deps, app.tasks, dmUpdate("just words"));
    const payload = app.calls.find((item) => item.url.startsWith("https://grok.example/hook"))?.body as WakeEvent;
    expect(payload.message.attachments).toEqual([]);
    expect(payload.message.media).toEqual([]);
  });

  it("describes a document, and marks a file over 20 MiB too large with no URL", async () => {
    const app = mediaApp();
    const update = dmUpdate("", 2, {
      text: undefined,
      caption: "notes",
      document: {
        file_id: "docFileId",
        file_name: "../../secret/\r\npage.html",
        mime_type: "text/html",
        file_size: 30,
      },
    });
    await postUpdate(app.deps, app.tasks, update);
    const doc = wakeFrom(app.calls).message.attachments[0]!;
    expect(doc).toMatchObject({
      kind: "document",
      mime_type: "text/html",
      file_name: "page.html",
      file_size: 30,
      unavailable: null,
    });
    expect(doc.file_url).toMatch(/\/file\/f1~/);
    expect(doc.file_name).not.toMatch(/[\r\n]/);

    const huge = dmUpdate("", 3, {
      text: undefined,
      document: { file_id: "hugeDocId", file_name: "big.pdf", mime_type: "application/pdf", file_size: TELEGRAM_GET_FILE_MAX_BYTES + 1 },
    });
    await postUpdate(app.deps, app.tasks, huge);
    const wakes = app.calls.filter((item) => item.url.startsWith("https://grok.example/hook"));
    const hugeAttachment = (wakes[1]?.body as WakeEvent).message.attachments[0]!;
    expect(hugeAttachment.file_url).toBeNull();
    expect(hugeAttachment.unavailable).toBe("too_large");
    expect(hugeAttachment.file_size).toBe(TELEGRAM_GET_FILE_MAX_BYTES + 1);

    const exact = dmUpdate("", 5, {
      text: undefined,
      document: { file_id: "exactDoc", file_size: TELEGRAM_GET_FILE_MAX_BYTES },
    });
    await postUpdate(app.deps, app.tasks, exact);
    const exactAttachment = (app.calls.filter((item) => item.url.startsWith("https://grok.example/hook")).at(-1)?.body as WakeEvent).message.attachments[0]!;
    expect(exactAttachment.unavailable).toBeNull();
    expect(exactAttachment.file_url).toMatch(/\/file\/f1~/);
  });

  it("describes voice, video notes, and stickers, and mounts file URLs under PATH_PREFIX", async () => {
    const app = createTestApp({ env: testEnv({ PATH_PREFIX: "/bridge" }) });
    const update = dmUpdate("", 6, {
      text: undefined,
      voice: { file_id: "voiceFile", duration: 3, mime_type: "audio/ogg" },
      video_note: { file_id: "noteFile", duration: 2, length: 240 },
      sticker: { file_id: "stickerFile", width: 512, height: 512, is_animated: false, is_video: false },
    });
    await postUpdate(app.deps, app.tasks, update);
    const payload = app.calls.find((item) => item.url.startsWith("https://grok.example/hook"))?.body as WakeEvent;
    expect(payload.message.media).toEqual(["sticker", "voice", "video_note"]);
    expect(payload.message.attachments.map((item) => [item.kind, item.mime_type, item.duration])).toEqual([
      ["voice", "audio/ogg", 3],
      ["video_note", "video/mp4", 2],
      ["sticker", "image/webp", null],
    ]);
    expect(payload.message.attachments[0]).not.toHaveProperty("transcript");
    expect(payload.message.attachments[0]?.file_url).toMatch(/^https:\/\/bridge\.example\/bridge\/file\/f1~/);
    const fetched = await handleRequest(new Request(payload.message.attachments[0]!.file_url!, {
      headers: { authorization: `Bearer ${payload.reply.token}` },
    }), app.deps);
    // The default test fetch mock has no getFile handler, so Telegram fails closed.
    expect(fetched.status).toBe(502);
    expect(await fetched.text()).not.toContain("ABCDEFghij");
  });
});

describe("GET /file", () => {
  it("streams the file for this wake's reply token and hides the bot token", async () => {
    const app = mediaApp();
    const payload = await photoWake(app);
    const fileUrl = payload.message.attachments[0]!.file_url!;
    const response = await handleRequest(new Request(fileUrl, {
      headers: { authorization: `Bearer ${payload.reply.token}` },
    }), app.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toContain("inline");
    expect(response.headers.get("content-disposition")).not.toMatch(/[\r\n]/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3, 4]));
    const download = app.calls.find((call) => call.url.includes("/file/bot"));
    expect(download?.method).toBe("GET");
    expect(download?.redirect).toBe("manual");
    expect(download?.url).toBe("https://api.telegram.org/file/bot123456:ABCDEFghij/photos/a.jpg");
    expect(JSON.stringify(Object.fromEntries(response.headers.entries()))).not.toContain("ABCDEFghij");
  });

  it("serves a document as an attachment and refuses to reflect text/html", async () => {
    const app = mediaApp();
    const update = dmUpdate("", 8, {
      text: undefined,
      document: { file_id: "htmlDoc", file_name: "page.html", mime_type: "text/html", file_size: 12 },
    });
    await postUpdate(app.deps, app.tasks, update);
    const payload = wakeFrom(app.calls);
    const response = await handleRequest(new Request(payload.message.attachments[0]!.file_url!, {
      headers: { authorization: `Bearer ${payload.reply.token}` },
    }), app.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain('attachment; filename="page.html"');
  });

  it("rejects a missing token, a reply token used as the file id, and a tampered file URL", async () => {
    const app = mediaApp();
    const payload = await photoWake(app);
    const fileUrl = payload.message.attachments[0]!.file_url!;
    const open = await handleRequest(new Request(fileUrl), app.deps);
    expect(open.status).toBe(401);
    const asFile = await handleRequest(new Request(`https://bridge.example/file/${payload.reply.token}`, {
      headers: { authorization: `Bearer ${payload.reply.token}` },
    }), app.deps);
    expect(asFile.status).toBe(401);
    const tamperedUrl = `${fileUrl.slice(0, -1)}${fileUrl.endsWith("A") ? "B" : "A"}`;
    const tampered = await handleRequest(new Request(tamperedUrl, {
      headers: { authorization: `Bearer ${payload.reply.token}` },
    }), app.deps);
    expect(tampered.status).toBe(401);
  });

  it("allows only the wake, chat, and topic the file was signed for", async () => {
    const app = mediaApp();
    const first = await photoWake(app, 4);
    await postUpdate(app.deps, app.tasks, dmUpdate("second", 5));
    const second = app.calls.filter((item) => item.url.startsWith("https://grok.example/hook")).map((item) => item.body as WakeEvent).at(-1)!;
    const fileUrl = first.message.attachments[0]!.file_url!;
    const otherWake = await handleRequest(new Request(fileUrl, {
      headers: { authorization: `Bearer ${second.reply.token}` },
    }), app.deps);
    expect(otherWake.status).toBe(403);
    expect(await otherWake.json()).toMatchObject({ error: "scope" });

    const topic = groupUpdate({
      text: "@testbot look",
      updateId: 6,
      threadId: 7,
      entities: [{ type: "mention", offset: 0, length: 8 }],
    });
    (topic.message as { photo?: unknown[] }).photo = [{ file_id: "topicPhoto", file_size: 20, width: 10, height: 10 }];
    await postUpdate(app.deps, app.tasks, topic);
    const topicWake = app.calls.filter((item) => item.url.startsWith("https://grok.example/hook")).map((item) => item.body as WakeEvent).at(-1)!;
    const cross = await handleRequest(new Request(topicWake.message.attachments[0]!.file_url!, {
      headers: { authorization: `Bearer ${first.reply.token}` },
    }), app.deps);
    expect(cross.status).toBe(403);

    const outbound = testEnv({ OUTBOUND_API_KEY: "outbound-key-0123456789abcdef0123456789" });
    const keyed = mediaApp({ env: outbound });
    const owned = await photoWake(keyed, 9);
    const denied = await handleRequest(new Request(owned.message.attachments[0]!.file_url!, {
      headers: { authorization: "Bearer outbound-key-0123456789abcdef0123456789" },
    }), keyed.deps);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "reply_token_required" });
  });

  it("returns 413 when Telegram says the file is too big, and does not follow a redirect or a bad path", async () => {
    const tooBig = mediaApp({
      handler: (call) => call.url.endsWith("/getFile")
        ? Response.json({ ok: false, description: "Bad Request: file is too big", error_code: 400 }, { status: 400 })
        : undefined,
    });
    const payload = await photoWake(tooBig);
    const limited = await handleRequest(new Request(payload.message.attachments[0]!.file_url!, {
      headers: { authorization: `Bearer ${payload.reply.token}` },
    }), tooBig.deps);
    expect(limited.status).toBe(413);
    expect(await limited.json()).toEqual({ ok: false, error: "file_too_large", limit: TELEGRAM_GET_FILE_MAX_BYTES });

    const reported = mediaApp({
      handler: (call) => call.url.endsWith("/getFile")
        ? Response.json({ ok: true, result: { file_path: "photos/a.jpg", file_size: TELEGRAM_GET_FILE_MAX_BYTES + 8 } })
        : undefined,
    });
    const reportedWake = await photoWake(reported, 12);
    const before = reported.calls.length;
    const over = await handleRequest(new Request(reportedWake.message.attachments[0]!.file_url!, {
      headers: { authorization: `Bearer ${reportedWake.reply.token}` },
    }), reported.deps);
    expect(over.status).toBe(413);
    expect(reported.calls.slice(before).some((call) => call.url.includes("/file/bot"))).toBe(false);

    const sneaky = mediaApp({
      handler: (call) => {
        if (call.url.endsWith("/getFile")) {
          return Response.json({ ok: true, result: { file_path: "../etc/passwd", file_size: 4 } });
        }
        if (call.url.includes("/file/bot")) return new Response("should-not-run", { status: 200 });
        return undefined;
      },
    });
    const sneakyWake = await photoWake(sneaky, 13);
    const blocked = await handleRequest(new Request(sneakyWake.message.attachments[0]!.file_url!, {
      headers: { authorization: `Bearer ${sneakyWake.reply.token}` },
    }), sneaky.deps);
    expect(blocked.status).toBe(502);
    expect(sneaky.calls.some((call) => call.url.includes("/file/bot"))).toBe(false);
    expect(await blocked.text()).not.toContain("ABCDEFghij");

    const redirected = mediaApp({
      handler: (call) => call.url.includes("/file/bot")
        ? new Response(null, { status: 302, headers: { location: "https://evil.example/bot123456:ABCDEFghij" } })
        : undefined,
    });
    const redirectedWake = await photoWake(redirected, 14);
    const bounce = await handleRequest(new Request(redirectedWake.message.attachments[0]!.file_url!, {
      headers: { authorization: `Bearer ${redirectedWake.reply.token}` },
    }), redirected.deps);
    expect(bounce.status).toBe(502);
    const bounceText = await bounce.text();
    expect(bounceText).not.toContain("ABCDEFghij");
    expect(bounceText).not.toContain("evil.example");
    expect(bounce.headers.get("location")).toBeNull();
  });
});

describe("POST /send/media", () => {
  it("sends a photo by https URL with the same final, reply, and thread semantics as text", async () => {
    const app = mediaApp();
    const topic = groupUpdate({
      text: "@testbot chart",
      updateId: 2,
      threadId: 9,
      entities: [{ type: "mention", offset: 0, length: 8 }],
    });
    await postUpdate(app.deps, app.tasks, topic);
    const payload = wakeFrom(app.calls);
    const sent = await handleRequest(new Request(payload.reply.send_media_url, {
      method: "POST",
      headers: { authorization: `Bearer ${payload.reply.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: payload.reply.chat_id,
        message_thread_id: payload.reply.message_thread_id,
        kind: "photo",
        url: "https://cdn.example/plot.png",
        caption: "chart",
        reply_to_message_id: payload.message.message_id,
        final: true,
      }),
    }), app.deps);
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ ok: true, message_ids: [90] });
    const photo = app.calls.find((call) => call.url.endsWith("/sendPhoto"));
    expect(photo?.body).toEqual({
      chat_id: "-500",
      photo: "https://cdn.example/plot.png",
      caption: "chart",
      message_thread_id: 9,
      disable_notification: false,
      reply_parameters: { message_id: payload.message.message_id, allow_sending_without_reply: true },
    });
    const reactions = app.calls.filter((call) => call.url.endsWith("/setMessageReaction")).map((call) => call.body);
    expect(reactions.at(-1)).toEqual({ chat_id: "-500", message_id: payload.message.message_id, reaction: [], is_big: false });

    const again = await handleRequest(new Request(payload.reply.send_media_url, {
      method: "POST",
      headers: { authorization: `Bearer ${payload.reply.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: payload.reply.chat_id,
        message_thread_id: 9,
        kind: "document",
        url: "https://cdn.example/more.pdf",
        final: true,
      }),
    }), app.deps);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ already_sent: true });
    expect(app.calls.filter((call) => call.url.endsWith("/sendDocument"))).toHaveLength(0);

    const textAfter = await handleRequest(new Request(payload.reply.send_url, {
      method: "POST",
      headers: { authorization: `Bearer ${payload.reply.token}`, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: payload.reply.chat_id, message_thread_id: 9, text: "again", final: true }),
    }), app.deps);
    expect(textAfter.status).toBe(200);
    expect(await textAfter.json()).toMatchObject({ already_sent: true });
  });

  it("sends a progress photo silently, then a document URL, and still requires text on /send", async () => {
    const app = mediaApp();
    const payload = await photoWake(app, 15);
    const progress = await handleRequest(new Request(payload.reply.send_media_url, {
      method: "POST",
      headers: { authorization: `Bearer ${payload.reply.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "42",
        kind: "photo",
        url: "https://cdn.example/draft.png?sig=1",
        idempotency_key: "progress-1",
        final: false,
      }),
    }), app.deps);
    expect(progress.status).toBe(200);
    expect(app.calls.find((call) => call.url.endsWith("/sendPhoto"))?.body).toMatchObject({
      photo: "https://cdn.example/draft.png?sig=1",
      disable_notification: true,
    });
    const repeat = await handleRequest(new Request(payload.reply.send_media_url, {
      method: "POST",
      headers: { authorization: `Bearer ${payload.reply.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "42",
        kind: "photo",
        url: "https://cdn.example/draft.png?sig=1",
        idempotency_key: "progress-1",
      }),
    }), app.deps);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ already_sent: true });
    expect(app.calls.filter((call) => call.url.endsWith("/sendPhoto"))).toHaveLength(1);

    const textOnly = await handleRequest(new Request("https://bridge.example/send", {
      method: "POST",
      headers: { authorization: `Bearer ${payload.reply.token}`, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "42", kind: "photo", url: "https://cdn.example/draft.png" }),
    }), app.deps);
    expect(textOnly.status).toBe(400);
    expect(await textOnly.json()).toMatchObject({ error: "empty_text" });

    const mismatched = await handleRequest(new Request(payload.reply.send_media_url, {
      method: "POST",
      headers: { authorization: `Bearer ${payload.reply.token}`, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "42", message_thread_id: 3, kind: "document", url: "https://cdn.example/a.pdf" }),
    }), app.deps);
    expect(mismatched.status).toBe(403);
  });

  it("rejects urls the bridge must not hand to Telegram", () => {
    expect(normalizePublicMediaUrl("https://cdn.example/a.png")).toBe("https://cdn.example/a.png");
    for (const bad of [
      "http://cdn.example/a.png",
      "https://user:pass@cdn.example/a.png",
      "https://127.0.0.1/a.png",
      "https://localhost/a.png",
      "https://10.1.2.3/a.png",
      "https://169.254.169.254/a.png",
      "https://api.telegram.org/file/bot123:ABC/a.jpg",
      "https://2130706433/a.png",
      "file:///etc/passwd",
      "",
    ]) {
      expect(normalizePublicMediaUrl(bad)).toBeNull();
    }
  });

  it("rejects a bad kind, a long caption, and an oversized upload", async () => {
    const app = mediaApp({ env: testEnv({ MAX_MEDIA_BYTES: "1024" }) });
    const payload = await photoWake(app, 16);
    const headers = { authorization: `Bearer ${payload.reply.token}`, "content-type": "application/json" };
    const badKind = await handleRequest(new Request(payload.reply.send_media_url, {
      method: "POST",
      headers,
      body: JSON.stringify({ chat_id: "42", kind: "video", url: "https://cdn.example/a.mp4" }),
    }), app.deps);
    expect(badKind.status).toBe(400);
    expect(await badKind.json()).toMatchObject({ error: "bad_kind" });
    const longCaption = await handleRequest(new Request(payload.reply.send_media_url, {
      method: "POST",
      headers,
      body: JSON.stringify({ chat_id: "42", kind: "photo", url: "https://cdn.example/a.png", caption: "x".repeat(1025) }),
    }), app.deps);
    expect(longCaption.status).toBe(413);
    expect(await longCaption.json()).toMatchObject({ error: "caption_too_large" });

    const form = new FormData();
    form.set("chat_id", "42");
    form.set("kind", "document");
    form.set("file", new File([new Uint8Array(2048)], "big.bin", { type: "application/octet-stream" }));
    const oversized = await handleRequest(new Request(payload.reply.send_media_url, {
      method: "POST",
      headers: { authorization: `Bearer ${payload.reply.token}` },
      body: form,
    }), app.deps);
    expect(oversized.status).toBe(413);
  });

  it("uploads a small document and lets the outbound key send to an allowlisted chat", async () => {
    const env = testEnv({ OUTBOUND_API_KEY: "outbound-key-0123456789abcdef0123456789" });
    const app = mediaApp({ env });
    const payload = await photoWake(app, 17);
    const form = new FormData();
    form.set("chat_id", "42");
    form.set("kind", "document");
    form.set("caption", "notes");
    form.set("final", "true");
    form.set("reply_to_message_id", String(payload.message.message_id));
    form.set("file_name", "notes.txt");
    form.set("file", new File([Uint8Array.from([9, 9])], "ignored.bin", { type: "text/plain" }));
    const uploaded = await handleRequest(new Request(payload.reply.send_media_url, {
      method: "POST",
      headers: { authorization: `Bearer ${payload.reply.token}` },
      body: form,
    }), app.deps);
    expect(uploaded.status).toBe(200);
    const call = app.calls.find((item) => item.url.endsWith("/sendDocument"));
    expect(call?.body).toBeInstanceOf(FormData);
    const sent = call?.body as FormData;
    expect(sent.get("chat_id")).toBe("42");
    expect(sent.get("caption")).toBe("notes");
    expect(sent.get("disable_notification")).toBe("false");
    const file = sent.get("document");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("notes.txt");
    expect(sent.get("reply_parameters")).toBe(JSON.stringify({
      message_id: payload.message.message_id,
      allow_sending_without_reply: true,
    }));

    const proactive = await handleRequest(new Request("https://bridge.example/send/media", {
      method: "POST",
      headers: {
        authorization: "Bearer outbound-key-0123456789abcdef0123456789",
        "content-type": "application/json",
      },
      body: JSON.stringify({ chat_id: "-500", kind: "photo", url: "https://cdn.example/hello.png", caption: "hi" }),
    }), app.deps);
    expect(proactive.status).toBe(200);
    const denied = await handleRequest(new Request("https://bridge.example/send/media", {
      method: "POST",
      headers: {
        authorization: "Bearer outbound-key-0123456789abcdef0123456789",
        "content-type": "application/json",
      },
      body: JSON.stringify({ chat_id: "7", kind: "photo", url: "https://cdn.example/hello.png" }),
    }), app.deps);
    expect(denied.status).toBe(403);
  });
});

describe("GET /file without a content-length", () => {
  it("buffers the body up to the getFile cap and sets the length", async () => {
    const app = mediaApp({
      handler: (call) => {
        if (!call.url.includes("/file/bot")) return undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.from([7, 8, 9]));
            controller.close();
          },
        });
        return new Response(stream);
      },
    });
    const payload = await photoWake(app, 21);
    const response = await handleRequest(new Request(payload.message.attachments[0]!.file_url!, {
      headers: { authorization: `Bearer ${payload.reply.token}` },
    }), app.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("3");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([7, 8, 9]));
  });
});

describe("media body limit", () => {
  it("raises the Node read cap only for /send/media", () => {
    const config = { maxBodyBytes: 1000, maxMediaBytes: 4000, pathPrefix: "/bridge" };
    expect(routeBodyLimit("/bridge/send/media", config)).toBe(4000);
    expect(routeBodyLimit("/bridge/webhook", config)).toBe(1000);
    expect(routeBodyLimit("/send/media?x=1", { ...config, pathPrefix: "" })).toBe(4000);
  });
});
