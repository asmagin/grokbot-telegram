import { describe, expect, it } from "vitest";
import { replyTokenScopeOk, secretsEqual, signFileToken, signReplyToken, timingSafeEqual, verifyFileToken, verifyReplyToken } from "../src/core/crypto.js";
import type { FileClaims, ReplyClaims } from "../src/core/types.js";

const secret = "reply-token-secret";

function claims(overrides: Partial<ReplyClaims> = {}): ReplyClaims {
  return {
    v: 1,
    chat_id: "42",
    thread_id: null,
    wake_id: "wake-1",
    exp: 1_800_000_000,
    ...overrides,
  };
}

describe("reply tokens", () => {
  it("signs and verifies a token", async () => {
    const token = await signReplyToken(secret, claims());
    const verified = await verifyReplyToken(secret, token, 1_700_000_000_000);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.claims.wake_id).toBe("wake-1");
  });

  it("rejects an expired token", async () => {
    const token = await signReplyToken(secret, claims({ exp: 1_600_000_000 }));
    const verified = await verifyReplyToken(secret, token, 1_700_000_000_000);
    expect(verified).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a tampered signature and a tampered payload", async () => {
    const token = await signReplyToken(secret, claims());
    const [version, payload, signature] = token.split(".");
    const flipped = `${signature?.slice(0, -1)}${signature?.endsWith("A") ? "B" : "A"}`;
    expect(await verifyReplyToken(secret, `${version}.${payload}.${flipped}`, 1_700_000_000_000)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verifyReplyToken(secret, `${version}.${payload}x.${signature}`, 1_700_000_000_000)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signReplyToken("other-secret", claims());
    expect(await verifyReplyToken(secret, token, 1_700_000_000_000)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects malformed tokens", async () => {
    expect((await verifyReplyToken(secret, "nope", 0)).ok).toBe(false);
    expect((await verifyReplyToken("", "v1.a.b", 0)).ok).toBe(false);
  });

  it("checks chat and thread scope", () => {
    const tokenClaims = claims({ chat_id: "-500", thread_id: 7 });
    expect(replyTokenScopeOk(tokenClaims, "-500", 7)).toBe(true);
    expect(replyTokenScopeOk(tokenClaims, "42", 7)).toBe(false);
    expect(replyTokenScopeOk(tokenClaims, "-500", null)).toBe(false);
    expect(replyTokenScopeOk(claims({ thread_id: null }), "42", null)).toBe(true);
    expect(replyTokenScopeOk(claims({ thread_id: null }), "42", 3)).toBe(false);
  });
});

describe("secret compare", () => {
  it("matches equal secrets and rejects missing or different ones", async () => {
    expect(await secretsEqual("abc", "abc")).toBe(true);
    expect(await secretsEqual("abc", "abd")).toBe(false);
    expect(await secretsEqual("abc", "")).toBe(false);
    expect(await secretsEqual("", "abc")).toBe(false);
    expect(await secretsEqual("short", "a-much-longer-value")).toBe(false);
  });

  it("compares byte arrays in constant time for equal lengths", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});

function fileClaims(overrides: Partial<FileClaims> = {}): FileClaims {
  return {
    v: 1,
    chat_id: "42",
    thread_id: null,
    wake_id: "wake-1",
    file_id: "photoBig",
    exp: 1_800_000_000,
    kind: "photo",
    mime: "image/jpeg",
    name: null,
    ...overrides,
  };
}

describe("file tokens", () => {
  it("signs and verifies a file token, and does not accept it as a reply token", async () => {
    const token = await signFileToken(secret, fileClaims());
    expect(token.startsWith("f1~")).toBe(true);
    expect(token.includes(".")).toBe(false);
    const verified = await verifyFileToken(secret, token, 1_700_000_000_000);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.claims.file_id).toBe("photoBig");
    expect((await verifyReplyToken(secret, token, 1_700_000_000_000)).ok).toBe(false);
    const reply = await signReplyToken(secret, claims());
    expect((await verifyFileToken(secret, reply, 1_700_000_000_000)).ok).toBe(false);
  });

  it("rejects a file token signed with another secret, a tampered signature, and an expired token", async () => {
    const token = await signFileToken(secret, fileClaims());
    expect((await verifyFileToken("other-secret-value", token, 1_700_000_000_000)).ok).toBe(false);
    const flipped = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(await verifyFileToken(secret, flipped, 1_700_000_000_000)).toEqual({ ok: false, reason: "bad_signature" });
    const expired = await signFileToken(secret, fileClaims({ exp: 1_600_000_000 }));
    expect(await verifyFileToken(secret, expired, 1_700_000_000_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("does not treat a file payload re-prefixed as v1 as a reply token", async () => {
    const token = await signFileToken(secret, fileClaims());
    const [, payload, signature] = token.split("~") as [string, string, string];
    const disguised = `v1.${payload}.${signature}`;
    expect(await verifyReplyToken(secret, disguised, 1_700_000_000_000)).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("reply token encoding", () => {
  it("accepts only the canonical signature encoding", async () => {
    const token = await signReplyToken(secret, claims());
    const [version, payload, signature] = token.split(".") as [string, string, string];
    // 32 bytes -> 43 chars; the last char carries 2 unused bits.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastIndex = alphabet.indexOf(signature.slice(-1));
    const twin = alphabet[lastIndex ^ 1] ?? "";
    const malleated = `${version}.${payload}.${signature.slice(0, -1)}${twin}`;
    expect(malleated).not.toBe(token);
    expect((await verifyReplyToken(secret, malleated, 1_700_000_000_000)).ok).toBe(false);
    expect((await verifyReplyToken(secret, token, 1_700_000_000_000)).ok).toBe(true);
  });
});
