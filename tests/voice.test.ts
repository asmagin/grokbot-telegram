import { describe, expect, it } from "vitest";
import { buildDeps } from "../src/core/deps.js";
import { handleRequest } from "../src/core/handler.js";
import { OPENAI_TRANSCRIBE_MODEL, OPENAI_TRANSCRIPTIONS_URL, SPEECH_BUDGET_MS } from "../src/core/transcribe.js";
import { TELEGRAM_GET_FILE_MAX_BYTES, type WakeEvent } from "../src/core/types.js";
import {
  createFetchMock,
  defaultResponse,
  dmUpdate,
  NOW,
  postUpdate,
  testEnv,
  type RecordedCall,
} from "./helpers.js";

const OPENAI_KEY = "sk-test-openai-key-0123456789";

function speechEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return testEnv({ OPENAI_API_KEY: OPENAI_KEY, ...overrides });
}

function speechApp(options: {
  env?: Record<string, string>;
  transcript?: string;
  languages?: { code: string }[] | null;
  provider?: (call: RecordedCall) => Response | Promise<Response>;
  handler?: (call: RecordedCall) => Response | Promise<Response> | undefined;
  log?: (event: Record<string, unknown>) => void;
  now?: () => number;
} = {}) {
  const mock = createFetchMock(async (call) => {
    const custom = await options.handler?.(call);
    if (custom) return custom;
    if (call.url === OPENAI_TRANSCRIPTIONS_URL) {
      if (options.provider) return options.provider(call);
      const body: Record<string, unknown> = { text: options.transcript ?? "hey testbot" };
      if (options.languages !== null) body.languages = options.languages ?? [{ code: "en" }];
      return Response.json(body);
    }
    if (call.url.endsWith("/getFile")) {
      return Response.json({ ok: true, result: { file_path: "voice/a.ogg", file_size: 4 } });
    }
    if (call.url.includes("/file/bot")) {
      return new Response(Uint8Array.from([1, 2, 3, 4]), {
        headers: { "content-length": "4" },
      });
    }
    if (/\/(sendVoice|sendAudio|sendPhoto|sendDocument|sendMessage)$/.test(call.url)) {
      return Response.json({ ok: true, result: { message_id: 90 } });
    }
    return defaultResponse(call, mock.calls.length);
  });
  const tasks: Promise<unknown>[] = [];
  const deps = buildDeps({
    env: options.env ?? speechEnv(),
    fetchImpl: mock.fetchImpl,
    now: options.now ?? (() => NOW),
    sleep: async () => undefined,
    waitUntil: (promise) => tasks.push(promise),
    typingMode: "once",
    log: options.log ?? (() => undefined),
  });
  return { deps, tasks, calls: mock.calls };
}

function wakes(calls: RecordedCall[]): WakeEvent[] {
  return calls
    .filter((call) => call.url.startsWith("https://grok.example/hook"))
    .map((call) => call.body as WakeEvent);
}

function openaiCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.url === OPENAI_TRANSCRIPTIONS_URL);
}

function voice(overrides: Record<string, unknown> = {}) {
  return { file_id: "voiceFile", duration: 3, mime_type: "audio/ogg", file_size: 120, ...overrides };
}

function groupMedia(updateId: number, extra: Record<string, unknown>) {
  return {
    update_id: updateId,
    message: {
      message_id: 200 + updateId,
      date: 1_700_000_000,
      from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
      chat: { id: -500, type: "supergroup", title: "Lab" },
      ...extra,
    },
  };
}

describe("inbound transcripts", () => {
  it("leaves a voice note unchanged when the OpenAI key is unset", async () => {
    const app = speechApp({ env: testEnv({ TRANSCRIBE_MAX_SECONDS: "30" }) });
    await postUpdate(app.deps, app.tasks, dmUpdate("", 1, { text: undefined, voice: voice() }));
    const payload = wakes(app.calls)[0];
    expect(payload).toBeDefined();
    expect(payload?.message.attachments[0]).not.toHaveProperty("transcript");
    expect(openaiCalls(app.calls)).toHaveLength(0);
    expect(app.calls.some((call) => call.url.endsWith("/getFile"))).toBe(false);
  });

  it("adds an untrusted transcript and language, and does not leak the key", async () => {
    const logs: Record<string, unknown>[] = [];
    const app = speechApp({ log: (event) => logs.push(event) });
    await postUpdate(app.deps, app.tasks, dmUpdate("", 2, {
      text: undefined,
      voice: voice(),
      sticker: { file_id: "stickerFile", width: 32, height: 32 },
    }));
    const payload = wakes(app.calls)[0]!;
    const voiceAttachment = payload.message.attachments.find((item) => item.kind === "voice")!;
    const sticker = payload.message.attachments.find((item) => item.kind === "sticker")!;
    expect(voiceAttachment).toMatchObject({
      transcript: "hey testbot",
      transcript_language: "en",
      transcript_error: null,
      file_url: expect.stringMatching(/\/file\/f1~/) as string,
    });
    expect(sticker).not.toHaveProperty("transcript");
    expect(payload.message.text).toBe("");
    expect(payload.untrusted_content_notice).toMatch(/transcript/);
    expect(JSON.stringify(payload)).not.toContain(OPENAI_KEY);
    expect(JSON.stringify(logs)).not.toContain(OPENAI_KEY);
    expect(JSON.stringify(logs)).not.toContain("hey testbot");
    expect(logs.some((event) => event.event === "transcribe" && event.reason === null && event.kind === "voice")).toBe(true);

    const provider = openaiCalls(app.calls)[0]!;
    expect(provider.method).toBe("POST");
    expect(provider.redirect).toBe("manual");
    expect(provider.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(provider.body).toBeInstanceOf(FormData);
    const form = provider.body as FormData;
    expect(form.get("model")).toBe(OPENAI_TRANSCRIBE_MODEL);
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("voice.ogg");
    expect((file as File).type).toBe("audio/ogg");
    expect([...form.keys()].sort()).toEqual(["file", "model", "response_format"]);
  });

  it("cleans the transcript and caps it, and keeps a whisper language name", async () => {
    const app = speechApp({
      provider: () => Response.json({ text: `hey \u0007testbot\u202e ${"a".repeat(5000)}`, language: "English!" }),
    });
    await postUpdate(app.deps, app.tasks, dmUpdate("", 3, { text: undefined, voice: voice() }));
    const attachment = wakes(app.calls)[0]?.message.attachments[0];
    expect(attachment?.transcript?.startsWith("hey testbot ")).toBe(true);
    expect(attachment?.transcript?.includes("\u0007")).toBe(false);
    expect(attachment?.transcript?.includes("\u202e")).toBe(false);
    expect(attachment?.transcript?.length).toBe(4000);
    expect(attachment?.transcript_language).toBeNull();
  });

  it("records a reason and still wakes when the provider fails", async () => {
    const refused = speechApp({
      provider: () => Response.json({ error: { message: OPENAI_KEY } }, { status: 500 }),
    });
    await postUpdate(refused.deps, refused.tasks, dmUpdate("", 4, { text: undefined, voice: voice() }));
    expect(wakes(refused.calls)[0]?.message.attachments[0]).toMatchObject({
      transcript: null,
      transcript_language: null,
      transcript_error: "provider_error",
    });
    expect(JSON.stringify(wakes(refused.calls)[0])).not.toContain(OPENAI_KEY);

    const timedOut = speechApp({
      provider: () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    });
    await postUpdate(timedOut.deps, timedOut.tasks, dmUpdate("", 5, { text: undefined, voice: voice() }));
    expect(wakes(timedOut.calls)[0]?.message.attachments[0]?.transcript_error).toBe("timeout");

    const empty = speechApp({ transcript: "  \n  " });
    await postUpdate(empty.deps, empty.tasks, dmUpdate("", 6, { text: undefined, voice: voice() }));
    expect(wakes(empty.calls)[0]?.message.attachments[0]).toMatchObject({
      transcript: null,
      transcript_error: "empty",
    });
  });

  it("skips the download when the clip is over a cap or a type OpenAI will not take", async () => {
    const tooLong = speechApp();
    await postUpdate(tooLong.deps, tooLong.tasks, dmUpdate("", 7, {
      text: undefined,
      voice: voice({ duration: 61 }),
    }));
    expect(wakes(tooLong.calls)[0]?.message.attachments[0]?.transcript_error).toBe("too_long");
    expect(tooLong.calls.some((call) => call.url.endsWith("/getFile") || call.url === OPENAI_TRANSCRIPTIONS_URL)).toBe(false);

    const tooLarge = speechApp();
    await postUpdate(tooLarge.deps, tooLarge.tasks, dmUpdate("", 8, {
      text: undefined,
      audio: { file_id: "audioFile", duration: 2, mime_type: "audio/mpeg", file_size: 2_000_001 },
    }));
    const large = wakes(tooLarge.calls)[0]?.message.attachments[0];
    expect(large).toMatchObject({ kind: "audio", transcript_error: "too_large", file_url: expect.stringMatching(/\/file\/f1~/) as string });
    expect(tooLarge.calls.some((call) => call.url === OPENAI_TRANSCRIPTIONS_URL)).toBe(false);

    const unavailable = speechApp();
    await postUpdate(unavailable.deps, unavailable.tasks, dmUpdate("", 9, {
      text: undefined,
      voice: voice({ file_size: TELEGRAM_GET_FILE_MAX_BYTES + 1, duration: 2 }),
    }));
    expect(wakes(unavailable.calls)[0]?.message.attachments[0]).toMatchObject({
      file_url: null,
      unavailable: "too_large",
      transcript_error: "unavailable",
    });

    const aac = speechApp();
    await postUpdate(aac.deps, aac.tasks, dmUpdate("", 10, {
      text: undefined,
      audio: { file_id: "aacFile", duration: 2, mime_type: "audio/aac", file_size: 40 },
    }));
    expect(wakes(aac.calls)[0]?.message.attachments[0]?.transcript_error).toBe("unsupported");
    expect(openaiCalls(aac.calls)).toHaveLength(0);
  });

  it("does not send a fast greeting or an unlisted chat to OpenAI", async () => {
    const greeting = speechApp({ env: speechEnv({ FAST_GREETING: "true" }) });
    await postUpdate(greeting.deps, greeting.tasks, dmUpdate("ping", 11, { voice: voice() }));
    expect(wakes(greeting.calls)).toHaveLength(0);
    expect(openaiCalls(greeting.calls)).toHaveLength(0);

    const stranger = speechApp();
    await postUpdate(stranger.deps, stranger.tasks, {
      update_id: 12,
      message: {
        message_id: 12,
        date: 1_700_000_000,
        voice: voice(),
        from: { id: 7, is_bot: false, first_name: "Sam" },
        chat: { id: 7, type: "private" },
      },
    });
    expect(wakes(stranger.calls)).toHaveLength(0);
    expect(openaiCalls(stranger.calls)).toHaveLength(0);
  });

  it("wakes a group voice note or video note only when the transcript says the username", async () => {
    const named = speechApp({ transcript: "hey @testbot what time is it" });
    await postUpdate(named.deps, named.tasks, groupMedia(13, { voice: voice() }));
    const namedWake = wakes(named.calls)[0];
    expect(namedWake?.addressed_how).toBe("mention");
    expect(namedWake?.message.text).toBe("");
    expect(namedWake?.message.attachments[0]?.transcript).toBe("hey @testbot what time is it");

    const quiet = speechApp({ transcript: "just chatting about lunch" });
    await postUpdate(quiet.deps, quiet.tasks, groupMedia(14, { voice: voice() }));
    expect(wakes(quiet.calls)).toHaveLength(0);
    expect(openaiCalls(quiet.calls)).toHaveLength(1);

    const embedded = speechApp({ transcript: "see contestbot today" });
    await postUpdate(embedded.deps, embedded.tasks, groupMedia(15, { voice: voice() }));
    expect(wakes(embedded.calls)).toHaveLength(0);

    const failed = speechApp({
      provider: () => Response.json({ ok: false }, { status: 500 }),
    });
    await postUpdate(failed.deps, failed.tasks, groupMedia(16, { voice: voice() }));
    expect(wakes(failed.calls)).toHaveLength(0);

    const note = speechApp({ transcript: "testbot are you there" });
    await postUpdate(note.deps, note.tasks, groupMedia(17, {
      video_note: { file_id: "noteFile", duration: 2, length: 240, file_size: 80 },
    }));
    expect(wakes(note.calls)[0]?.addressed_how).toBe("mention");
    const uploaded = openaiCalls(note.calls)[0]?.body as FormData;
    const file = uploaded.get("file");
    expect((file as File).name).toBe("note.mp4");
    expect((file as File).type).toBe("video/mp4");
  });

  it("does not treat a spoken name in an audio file as an address", async () => {
    const ignored = speechApp({ transcript: "hey testbot" });
    await postUpdate(ignored.deps, ignored.tasks, groupMedia(18, {
      audio: { file_id: "audioFile", duration: 4, mime_type: "audio/mpeg", file_size: 80 },
    }));
    expect(wakes(ignored.calls)).toHaveLength(0);
    expect(openaiCalls(ignored.calls)).toHaveLength(0);

    const caption = speechApp({ transcript: "the track, without a name" });
    await postUpdate(caption.deps, caption.tasks, groupMedia(19, {
      text: "@testbot play this",
      entities: [{ type: "mention", offset: 0, length: 8 }],
      audio: { file_id: "audioFile", duration: 4, mime_type: "audio/mpeg", file_name: "song.mp3", file_size: 80 },
    }));
    const payload = wakes(caption.calls)[0];
    expect(payload?.addressed_how).toBe("mention");
    expect(payload?.message.attachments[0]).toMatchObject({
      kind: "audio",
      transcript: "the track, without a name",
      transcript_language: "en",
    });
    const uploaded = openaiCalls(caption.calls)[0]?.body as FormData;
    expect((uploaded.get("file") as File).name).toBe("audio.mp3");
    expect((uploaded.get("file") as File).type).toBe("audio/mpeg");
  });

  it("keeps reply addressing when the voice transcript does not say the username", async () => {
    const app = speechApp({ transcript: "and another thing" });
    await postUpdate(app.deps, app.tasks, groupMedia(20, {
      voice: voice(),
      reply_to_message: {
        message_id: 8,
        text: "earlier",
        chat: { id: -500, type: "supergroup" },
        from: { id: 999, is_bot: true, username: "testbot" },
      },
    }));
    const payload = wakes(app.calls)[0];
    expect(payload?.addressed_how).toBe("reply");
    expect(payload?.message.attachments[0]?.transcript).toBe("and another thing");
  });

  it("stops after the time budget so a second clip does not call OpenAI", async () => {
    let shift = 0;
    const app = speechApp({
      now: () => NOW + shift,
      handler: (call) => {
        if (call.url !== OPENAI_TRANSCRIPTIONS_URL) return undefined;
        shift = SPEECH_BUDGET_MS + 1;
        return Response.json({ text: "hey testbot", languages: [{ code: "en" }] });
      },
    });
    await postUpdate(app.deps, app.tasks, dmUpdate("", 21, {
      text: undefined,
      voice: voice({ duration: 2, file_size: 10 }),
      audio: { file_id: "audioFile", duration: 2, mime_type: "audio/mpeg", file_size: 10 },
    }));
    const payload = wakes(app.calls)[0]!;
    const speech = payload.message.attachments.filter((item) => item.kind === "voice" || item.kind === "audio");
    expect(speech.map((item) => item.transcript_error).sort()).toEqual([null, "timeout"]);
    expect(speech.find((item) => item.transcript)?.transcript).toBe("hey testbot");
    expect(openaiCalls(app.calls)).toHaveLength(1);
  });
});

describe("outbound voice and audio", () => {
  async function tokenFor(app: ReturnType<typeof speechApp>, updateId: number): Promise<WakeEvent> {
    await postUpdate(app.deps, app.tasks, dmUpdate("hi", updateId));
    const payload = wakes(app.calls).at(-1);
    if (!payload) throw new Error("missing wake");
    return payload;
  }

  it("sends a voice URL through sendVoice and shares the final slot with text", async () => {
    const app = speechApp({ env: testEnv() });
    const payload = await tokenFor(app, 30);
    const sent = await handleRequest(new Request(payload.reply.send_media_url, {
      method: "POST",
      headers: { authorization: `Bearer ${payload.reply.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: payload.reply.chat_id,
        kind: "voice",
        url: "https://cdn.example/note.ogg",
        caption: "On my way",
        reply_to_message_id: payload.message.message_id,
        final: true,
      }),
    }), app.deps);
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ ok: true, message_ids: [90] });
    expect(app.calls.find((call) => call.url.endsWith("/sendVoice"))?.body).toEqual({
      chat_id: "42",
      voice: "https://cdn.example/note.ogg",
      caption: "On my way",
      disable_notification: false,
      reply_parameters: { message_id: payload.message.message_id, allow_sending_without_reply: true },
    });

    const text = await handleRequest(new Request(payload.reply.send_url, {
      method: "POST",
      headers: { authorization: `Bearer ${payload.reply.token}`, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "42", text: "again", final: true }),
    }), app.deps);
    expect(text.status).toBe(200);
    expect(await text.json()).toMatchObject({ already_sent: true });
    expect(app.calls.filter((call) => call.url.endsWith("/sendVoice"))).toHaveLength(1);
  });

  it("uploads OGG as a voice note, rejects other types, and uploads other audio", async () => {
    const app = speechApp({ env: testEnv() });
    const payload = await tokenFor(app, 31);
    const headers = { authorization: `Bearer ${payload.reply.token}` };

    const bad = new FormData();
    bad.set("chat_id", "42");
    bad.set("kind", "voice");
    bad.set("file", new File([Uint8Array.from([1, 2])], "clip.mp3", { type: "audio/mpeg" }));
    const rejected = await handleRequest(new Request(payload.reply.send_media_url, {
      method: "POST",
      headers,
      body: bad,
    }), app.deps);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "bad_voice" });
    expect(app.calls.some((call) => call.url.endsWith("/sendVoice"))).toBe(false);

    const form = new FormData();
    form.set("chat_id", "42");
    form.set("kind", "voice");
    form.set("final", "false");
    form.set("file_name", "clip.mp3");
    form.set("file", new File([Uint8Array.from([1, 2])], "ignored.mp3", { type: "audio/ogg" }));
    const uploaded = await handleRequest(new Request(payload.reply.send_media_url, {
      method: "POST",
      headers,
      body: form,
    }), app.deps);
    expect(uploaded.status).toBe(200);
    const voiceCall = app.calls.find((call) => call.url.endsWith("/sendVoice"));
    expect(voiceCall?.body).toBeInstanceOf(FormData);
    const sent = voiceCall?.body as FormData;
    expect(sent.get("chat_id")).toBe("42");
    expect(sent.get("disable_notification")).toBe("true");
    const file = sent.get("voice");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("clip.ogg");
    expect((file as File).type).toBe("audio/ogg");

    const audio = new FormData();
    audio.set("chat_id", "42");
    audio.set("kind", "audio");
    audio.set("final", "true");
    audio.set("file", new File([Uint8Array.from([9])], "song.mp3", { type: "audio/mpeg" }));
    const audioSent = await handleRequest(new Request(payload.reply.send_media_url, {
      method: "POST",
      headers,
      body: audio,
    }), app.deps);
    expect(audioSent.status).toBe(200);
    const audioCall = app.calls.find((call) => call.url.endsWith("/sendAudio"));
    const audioForm = audioCall?.body as FormData;
    const audioFile = audioForm.get("audio");
    expect(audioFile).toBeInstanceOf(File);
    expect((audioFile as File).name).toBe("song.mp3");
    expect((audioFile as File).type).toBe("audio/mpeg");
    expect(audioForm.get("disable_notification")).toBe("false");

    const again = await handleRequest(new Request(payload.reply.send_media_url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "42", kind: "audio", url: "https://cdn.example/more.mp3", final: true }),
    }), app.deps);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ already_sent: true });
    expect(app.calls.filter((call) => call.url.endsWith("/sendAudio"))).toHaveLength(1);
  });
});
