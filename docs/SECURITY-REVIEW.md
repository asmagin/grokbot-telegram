# Security review: grokbot-telegram

Branch `security-review`, cut from `main` at `e4067a6`. Reviewed and fixed 2026-10-08. Nothing was pushed, deployed, or sent to Telegram, Cloudflare, Vercel, or GitHub.

## Summary and scope

The repo is a Telegram ↔ Grok Bot webhook-routine bridge: a TypeScript core (Web `Request`/`Response`), a Cloudflare Worker with a Durable Object, Vercel and Node adapters, and docs/skills that an assistant follows. I reviewed everything in the brief's scope, security first:

- Webhook secret
- Allowlist semantics
- Reply-token crypto and scope
- `/send` and `/typing/stop` authorization
- SSRF and injection
- Prompt-injection exposure
- Dedupe and rate-limit races
- Error and secret leakage
- Adapters
- Telegram behavior
- Dependencies
- CI
- Docs, checked against the three verified Grok Bot reference files

The first pass was mine. After that, a separate read-only review agent went over the branch; its findings are M-7, M-8, L-18–L-21, L-22 and I-2.

The core was already in reasonable shape. It compared secrets in constant time, rejected an empty webhook secret, failed closed on an empty allowlist, used HMAC-SHA256 tokens scoped to chat and topic with stale-wake protection on typing stop, built Telegram URLs only for `api.telegram.org`, and never set `parse_mode`. The real problems were:

- **H-1:** the Node adapter buffered request bodies with no limit, on any path, before authentication.
- **Medium:** secret strength was never enforced, `send_url` could fall back to the request Host header, there was no prompt-injection framing (and user text could close the `<webhook_event>` block), the Durable Object dedupe value grew without bound, two typing-indicator bugs, a forum-thread bug, and docs that described Grok Bot UI that has not been verified.

Results:
- **Found:** 1 High, 8 Medium, 23 Low, 12 Info. No Critical.
- **Fixed:** all High and Medium findings, 21 of the 23 Low, and 2 of the 12 Info.
- **Left:** 2 Low and 10 Info, each with a reason below.

**Reading the line references.** Fixed items point at the code as it is at the end of the branch (`eac2ec1`). Left items point at `main`; in every Left case except I-2 that file has the same line number on both.

## Commits (oldest first)

| SHA | Subject | Findings |
| --- | --- | --- |
| 982b080 | Fail closed on missing, weak, or unsafe configuration | L-1, M-1, L-2, M-2, L-3 |
| ee342e3 | Cap request bodies while streaming and authenticate /send first | H-1, L-4 |
| 3363098 | Frame and sanitize untrusted Telegram content in the wake | M-3 |
| 1c59ae7 | Tighten sender identity and forum topic handling | M-4, L-5 |
| 922545c | Keep wakes flowing when Grok Bot, typing, or the store fails | L-6, L-7, L-8 |
| a4cca93 | Bound dedupe and context storage growth | M-5, L-9, L-10 |
| eb0dd4b | Make Telegram sends robust to emoji, deleted parents, and long 429s | L-11, L-12, L-13 |
| 3073f69 | Reject non-canonical reply token signatures | I-1 |
| 79a71e1 | Upgrade vitest to 4.1 and pin patched sharp | L-14 |
| 682e9c6 | Restrict CI token and stop persisting checkout credentials | L-15 |
| 15824fe | Correct setup docs against verified Grok Bot and Telegram behavior | M-6, L-16, L-17, I-12 |
| eac2ec1 | Fix typing alarm race and other issues found in second review | M-7, M-8, L-18, L-19, L-20, L-21 |

Every security fix has at least one test. The new test files are:
- `tests/config.test.ts`
- `tests/limits.test.ts`
- `tests/payload.test.ts`
- `tests/sender.test.ts`
- `tests/resilience.test.ts`
- `tests/stores.test.ts`
- `tests/telegram.test.ts`
- `tests/review-followups.test.ts`

New cases were also added to the existing `tests/crypto.test.ts`. For the key fixes (signature canonicalization, the DO alarm race, the body caps, stopping typing on a failed forward) I confirmed that the new test fails on the old code.

## Findings table

| ID | Severity | Title | Status |
| --- | --- | --- | --- |
| H-1 | High | Node adapter buffers unbounded bodies before auth | Fixed ee342e3 |
| M-1 | Medium | No minimum length for `REPLY_TOKEN_SECRET`, so tokens can be forged offline | Fixed 982b080 |
| M-2 | Medium | `send_url` falls back to request Host (`http://` on Node) | Fixed 982b080 |
| M-3 | Medium | Untrusted content not framed; text can close `<webhook_event>` | Fixed 3363098 |
| M-4 | Medium | Non-forum reply-thread ids used as topic ids | Fixed 1c59ae7 |
| M-5 | Medium | DO dedupe map grows into the per-value limit, then every webhook 500s | Fixed a4cca93 |
| M-6 | Medium | Setup skill describes unverified Grok Bot UI for creating and rotating routines | Fixed 15824fe |
| M-7 | Medium | DO typing alarm writes back a stale snapshot, so the indicator gets stuck | Fixed eac2ec1 |
| M-8 | Medium | Bad reply secret or base URL silently drops every wake | Fixed eac2ec1 |
| L-1 | Low | Webhook secret charset/length not validated; Node starts without it | Fixed 982b080 |
| L-2 | Low | No minimum length for `OUTBOUND_API_KEY` | Fixed 982b080 |
| L-3 | Low | Allowlist ids not canonical; junk silently ignored | Fixed 982b080 |
| L-4 | Low | `/send` reads the body before checking the bearer | Fixed ee342e3 |
| L-5 | Low | `sender_chat` placeholder `from` and automatic forwards | Fixed 1c59ae7 |
| L-6 | Low | Typing keeps going after a failed forward; typing error blocks the forward | Fixed 922545c |
| L-7 | Low | No top-level error handler | Fixed 922545c |
| L-8 | Low | Missing fetch timeouts; scripts print raw errors; no SIGTERM drain | Fixed 922545c |
| L-9 | Low | MemoryStore growth (buckets, scopes, typing sessions) | Fixed a4cca93 |
| L-10 | Low | Stored context retained and attached indefinitely | Fixed a4cca93 |
| L-11 | Low | Hard split can cut a surrogate pair | Fixed eb0dd4b |
| L-12 | Low | Deleted parent message makes the whole reply fail | Fixed eb0dd4b |
| L-13 | Low | 429 with long `retry_after` retried early | Fixed eb0dd4b |
| L-14 | Low | npm audit: 6 dev-only vulnerabilities | Fixed 79a71e1 |
| L-15 | Low | CI workflow lacks least-privilege permissions | Fixed 682e9c6 |
| L-16 | Low | Privacy-mode and group-joining guidance imprecise | Fixed 15824fe |
| L-17 | Low | Docs stale or unsafe in places (getUpdates, external link, scripts) | Fixed 15824fe |
| L-18 | Low | A retried update sees itself in `short_term` | Fixed eac2ec1 |
| L-19 | Low | Context stored before this branch is not sanitized | Fixed eac2ec1 |
| L-20 | Low | Invisible tag and zero-width characters not stripped | Fixed eac2ec1 |
| L-21 | Low | DO prune order breaks when `update_id` gains a digit | Fixed eac2ec1 |
| L-22 | Low | `typing.stop` read-then-write race on Upstash | Left (store removed later) |
| L-23 | Low | CI actions not pinned to commit SHAs | Left |
| I-1 | Info | Reply-token signature malleable in its unused low bits | Fixed 3073f69 |
| I-2 | Info | Node buffers up to `MAX_BODY_BYTES` before core auth | Left |
| I-3 | Info | Reply token not bound to one bridge | Left (documented) |
| I-4 | Info | `/healthz` reveals config booleans and setting names | Left |
| I-5 | Info | `OUTBOUND_API_KEY` + body `wake_id` can stop a wake's typing | Left |
| I-6 | Info | Edited messages wake the bot again | Left (documented) |
| I-7 | Info | No Telegram source-IP check | Left |
| I-8 | Info | Single global dedupe Durable Object | Left |
| I-9 | Info | Failed forwards are not retried | Left (documented) |
| I-10 | Info | `engines` says Node ≥22; this box is Node 20.19 | Left |
| I-11 | Info | Vercel `export default { fetch }` not verified on a live deploy | Left |
| I-12 | Info | Reply-token replay semantics undocumented | Fixed 15824fe (decision documented) |

## Details

### High

**H-1. Node adapter buffers unbounded request bodies before any auth.** Fixed in ee342e3.
- **Where:** `src/adapters/node/server.ts:15` (`nodeRequestToWeb`) and `src/core/http.ts:30`.
- **Problem:** `nodeRequestToWeb` concatenated the whole request stream for every method and path before the core saw it, so the webhook secret check and `MAX_BODY_BYTES` came too late. On top of that, `readLimitedBody` called `arrayBuffer()` when Content-Length was absent.
- **Impact:** any unauthenticated client could exhaust the Node process's memory with one large chunked POST to any path.
- **Fix:**
  - Count bytes while streaming and stop at `MAX_BODY_BYTES`. The core cancels the reader; Node returns 413 and destroys the socket.
  - Set `requestTimeout` to 30 s and `headersTimeout` to 15 s.
- **Tests:** `tests/limits.test.ts` covers a chunked 10 MB body against the core and against a real Node server.

### Medium

**M-1. No minimum length for `REPLY_TOKEN_SECRET`.** Fixed in 982b080.
- **Where:** `src/core/config.ts:33`, `:158`.
- **Problem:** any non-empty secret was used as the HMAC key. Every wake hands the assistant a token, so a weak key can be brute-forced offline.
- **Impact:** a forged token carries any `chat_id`, and `/send` does not apply the allowlist to tokens. An attacker could therefore post as the bot in any chat it can reach.
- **Fix:** secrets under 32 characters are ignored, so no wakes are issued and no tokens are accepted. The setting name shows up in `/healthz` `problems`, and Node refuses to start (M-8).

**M-2. `send_url` derived from the request Host header.** Fixed in 982b080.
- **Where:** `src/core/payload.ts:71`, `src/core/config.ts:94`.
- **Problem:** without `PUBLIC_BASE_URL`, `reply.send_url` came from `request.url`. On Node that URL is always `http://<Host>`.
- **Impact:** the assistant would POST its bearer token over plaintext, or to whatever host the inbound request named.
- **Fix:**
  - The Host fallback is removed.
  - `PUBLIC_BASE_URL` must be `https` (`http` only for localhost), with no credentials, query or fragment.
  - `set-webhook` validates it too.

**M-3. Untrusted content not framed, and it can break out of `<webhook_event>`.** Fixed in 3363098.
- **Where:**
  - `src/core/grok.ts:15` (`encodeWakeBody`)
  - `src/core/text.ts:17`
  - `src/core/payload.ts:11`
  - `.grok/skills/telegram-connect/SKILL.md:207`
  - the reply skill
- **Problem:** message text, names, titles, `reply_to` and `short_term` were forwarded raw. `JSON.stringify` does not escape `<`, so a Telegram user could type `</webhook_event>` followed by fake instructions. Nothing told the assistant the content was untrusted.
- **Impact:** prompt injection into an assistant that can run commands.
- **Fix:**
  - Escape `<`, `>` and `&` as `<`, `>` and `&`. The JSON is equivalent, but the literal tag can no longer appear.
  - Strip C0/C1 control and bidi characters (L-20 extends the list).
  - Cap names (64), titles (128) and `short_term` entries (1000).
  - Add an `untrusted_content_notice` field. This is additive; `schema_version` stays 1 and the schema is updated.
  - Rewrite the recommended saved prompt and the reply skill: treat this content as data, do not act in connected accounts on request, and only POST to a pinned bridge origin. That last rule defeats a forged wake whose `send_url` points elsewhere.
  - End the saved prompt with a destination line, as the routines skill requires.

**M-4. Reply-thread ids in non-forum supergroups treated as topics.** Fixed in 1c59ae7.
- **Where:** `src/core/address.ts:12`, `src/core/inbound.ts:126`.
- **Problem:** in a non-forum supergroup, a reply carries `message_thread_id`. The bridge used it as a topic: it split context and typing per reply chain, scoped the token to that id, and passed it to `sendMessage`/`sendChatAction`. The Bot API documents that parameter for forum topics only.
- **Impact:** replies to group replies could fail to send.
- **Fix:** the thread id is used only when `is_topic_message` is true.
- **Not verified:** I did not observe the failure against live Telegram; the fix follows the Bot API docs.

**M-5. Durable Object dedupe kept one ever-growing value.** Fixed in a4cca93.
- **Where:** `src/adapters/cloudflare/do-storage.ts:108`, `:128`.
- **Problem:** every `update_id` from the last 24 h, and every closed wake id, lived in one map that was read and rewritten on each webhook.
- **Impact:** on a busy bot the map outgrows the Durable Object per-value limit. Every claim then throws, every webhook returns 500, Telegram retries, and the backlog grows. The cost per webhook also rose linearly with traffic.
- **Fix:**
  - One key per entry. Update keys are zero-padded (L-21).
  - Expired entries are pruned in batches of 64.
  - The old `seen`/`wakes` maps are still honored until they age out, then deleted.

**M-6. Setup skill describes Grok Bot UI that has not been verified.** Fixed in 15824fe.
- **Where:** `.grok/skills/telegram-connect/SKILL.md:195` (Step 9) and `:340` (rotation); `AGENTS.md`; `README.md`.
- **Problem:** the docs told the person to "add a routine" in the info pane, and to "open the routine editor". They said the sender key can be rotated "from the routine panel". None of these is in the verified references.
- **What the references say:**
  - The assistant creates routines itself with its routine tool, and the person may see a confirmation card.
  - The info pane lists the agent's Routines.
  - The person copies the URL and sender key from the routine panel, and `<automation_status>` provides ready-made links to it.
  - Grok Bot collects credentials only through a masked secret-request. The bridge's secrets are host secrets, not connector credentials, so the docs now say not to collect them at all.
- **Fix:** the docs follow those facts. Rotating the sender key now means replacing the routine, and uninstalling deletes or pauses it with the routine tool.

**M-7. Durable Object typing alarm writes back a stale snapshot.** Fixed in eac2ec1.
- **Where:** `src/adapters/cloudflare/do-storage.ts:73`. This predates the branch and was found in the second review.
- **Problem:** `handleDoAlarm` read the typing map, awaited one `sendChatAction` fetch per session, then wrote its snapshot back. The object keeps serving requests while it waits on that fetch.
- **Impact:** a `final` stop (or the M-8/L-6 failure stop) that arrived during the fetch was undone. A newer wake started in that window was replaced by the old one. Either way the typing indicator stayed up for up to `TYPING_MAX_MS` (10 min).
- **Fix:** re-read the map after sending and only drop expired sessions.
- **Test:** `tests/review-followups.test.ts`.

**M-8. A short reply secret or missing/invalid `PUBLIC_BASE_URL` silently drops every wake.** Fixed in eac2ec1.
- **Where:** `src/core/config.ts:185`, `src/core/inbound.ts` (`wake_skipped`).
- **Problem:** after M-1/M-2, a deployment with either setting missing, short, or invalid answers Telegram 200 but never wakes the bot, and the only sign was an info-level log line.
- **Fix:**
  - The Node server refuses to start and lists the setting names.
  - On Workers and Vercel the skip is logged with `level: "error"` and the names; `/healthz` shows `ready: false` and `problems`.
  - Operators upgrading with a short `REPLY_TOKEN_SECRET` must rotate it (README and skill say so).

### Low

- **L-1. Webhook secret not validated.** Fixed in 982b080; `src/core/config.ts:81`, `src/core/inbound.ts:15`, `scripts/set-webhook.ts`.
  - **Before:** only emptiness was checked.
  - **Now:**
    - A secret Telegram would reject, or one shorter than 16 characters, also returns 503 (fail closed).
    - The Node server refuses to start without a valid secret.
    - `set-webhook` validates before calling Telegram.
- **L-2. `OUTBOUND_API_KEY` had no floor.** Fixed in 982b080; `src/core/config.ts:172`. Keys under 32 characters are ignored and reported in `problems`.
- **L-3. Allowlist ids not canonical, junk silently dropped.** Fixed in 982b080; `src/core/config.ts:62`.
  - **Before:** `042` never matched anything, and nobody was told.
  - **Now:** ids are canonical decimal and safe integers, and rejected entries are reported by setting name. `/send` `chat_id` uses the same parser.
- **L-4. `/send` and `/typing/stop` read the body before checking the bearer.** Fixed in ee342e3; `src/core/outbound.ts:126`. The bearer is now verified first and scope is checked after parsing.
- **L-5. `sender_chat` and automatic forwards.** Fixed in 1c59ae7; `src/core/address.ts:22`, `src/core/inbound.ts:104`.
  - **Before:** for anonymous admins and people posting as a channel, the placeholder `from` was treated as the sender.
  - **Now:**
    - Those messages are admitted only by the chat's id in `ALLOWLIST_CHAT_IDS`, with `from: null` in the wake.
    - Linked-channel copies (`is_automatic_forward`) are dropped.
- **L-6. Typing after a failed forward.** Fixed in 922545c; `src/core/inbound.ts:233`, `:255`.
  - **Before:** a non-2xx or unreachable Grok Bot left "typing…" up for 10 minutes, and a typing-start error (for example a DO error) aborted the forward itself.
  - **Now:** both are handled. The wake is deliberately not closed, because a timed-out wake may still have been accepted.
- **L-7. No top-level error handler.** Fixed in 922545c; `src/core/handler.ts:20`. Store errors in `/send` now produce a generic 500 JSON body instead of a platform error page.
- **L-8. Missing timeouts and shutdown handling.** Fixed in 922545c.
  - Added `AbortSignal.timeout` to Upstash (`src/core/upstash.ts:111`, since removed), the DO typing refresh (`do-storage.ts:250`) and the scripts (`scripts/telegram-call.ts:26`).
  - The scripts no longer print raw fetch errors, because some runtimes include the URL and the URL contains the bot token.
  - Node drains background work on SIGTERM/SIGINT (`server.ts:147`).
- **L-9. MemoryStore growth.** Fixed in a4cca93; `src/core/store.ts:62`. Stale rate buckets are evicted, scopes are capped at 1000 (LRU), and expired typing sessions are dropped (in "once" mode nothing used to clear them).
- **L-10. Context retained indefinitely.** Fixed in a4cca93; `src/core/store.ts:53`. Entries more than 7 days older than the current message stay out of the wake. Upstash keys, since removed, expired after 7 idle days.
- **L-11. Surrogate pair cut on hard split.** Fixed in eb0dd4b; `src/core/text.ts:49`. `truncateText` was fixed too, in 3363098.
- **L-12. Deleted parent breaks the reply.** Fixed in eb0dd4b; `src/core/telegram.ts:83`. The bridge now sends `reply_parameters` with `allow_sending_without_reply: true` instead of `reply_to_message_id`.
- **L-13. 429 retried before `retry_after`.** Fixed in eb0dd4b; `src/core/telegram.ts:104`.
  - **Before:** a 30 s limit was "waited" for 5 s and then retried.
  - **Now:** the bridge waits only when `retry_after` is 5 s or less (still at most 2 retries). Longer limits return 502 with `retry_after`, and the reply skill tells the assistant to wait that long.
- **L-14. Dependency advisories.** Fixed in 79a71e1; `package.json:36`.
  - vitest 3 → 4.1.11, which drops tinypool (critical) and fixes `@vitest/mocker`.
  - `overrides.sharp ^0.35.5`, because the latest miniflare still pins 0.35.4.
  - Audit went from 6 to 0. All were dev-only.
  - npm 9.2 on this box crashed with `edgesOut` while resolving, so the lockfile was produced with npm 10. `npm ci` with npm 9 then installs cleanly.
- **L-15. CI permissions.** Fixed in 682e9c6; `.github/workflows/ci.yml:9`.
  - `permissions: contents: read`
  - `persist-credentials: false`
  - a job timeout
  - concurrency cancellation
  - an `npm audit --omit=dev --audit-level=high` step
- **L-16. Privacy-mode and group-joining guidance.** Fixed in 15824fe; `.grok/skills/telegram-connect/SKILL.md:63`, `README.md`.
  - Privacy mode delivers addressed commands, replies to the bot and service messages. Mentions are delivered in practice but not documented. A bare `/ask` reaches the bot only if it was the last bot to post.
  - The docs recommend `/ask@Bot`, and `/setjoingroups` → Disable once the bot is in the right groups.
- **L-17. Docs and secrets hygiene.** Fixed in 15824fe.
  - `getUpdates` now uses `read -rs` so the token stays out of shell history, and no longer asks for whole payloads that contain other people's messages.
  - Removed an unverified external product link.
  - Removed a "repo stays private" claim about clones.
  - The README no longer says the scripts print the webhook URL.
  - Documented: secret floors, https base URL, `problems`, `sender_chat`, failed-forward behavior, and using a unique secret per bridge.
- **L-18. A retried update sees itself as prior context.** Fixed in eac2ec1; `src/core/store.ts:53`.
  - **Before:** if processing failed after `pushContext`, the update was released and retried, and the retry's `short_term` contained the current message.
  - **Now:** context is de-duplicated by `message_id`, so an edit replaces its earlier copy.
- **L-19. Context stored before this branch is not sanitized.** Fixed in eac2ec1; `src/core/payload.ts:40`. `short_term` is cleaned again on the way out.
- **L-20. Invisible characters.** Fixed in eac2ec1; `src/core/text.ts:17`. The bridge now also strips U+061C, U+200B, U+2060–2064 and Unicode tag characters (U+E0000–E007F; the model reads them, a person cannot see them). ZWJ and ZWNJ are kept for emoji and scripts that need them.
- **L-21. DO prune order.** Fixed in eac2ec1; `do-storage.ts:108`. Update keys are zero-padded, so string order matches numeric order across digit-count changes.
- **L-22. `typing.stop` race on Upstash.** Left; `src/core/typing.ts:61` (same on `main`).
  - **Problem:** `stop` reads, compares the wake id, then deletes, in separate round trips. If a newer wake starts in that window, the newer typing session can be deleted.
  - **Why left:** the effect is cosmetic (the indicator disappears early). It only matters on Upstash, which Vercel uses with single-shot typing. In-process MemoryStore is effectively atomic, and Cloudflare goes through the Durable Object. A proper fix needs a Lua compare-and-delete script.
- **L-23. CI actions on major tags.** Left; `.github/workflows/ci.yml` (`actions/checkout@v4`, `actions/setup-node@v4`). I could not verify commit SHAs offline and was told not to contact GitHub. The workflow has a comment telling adopters to pin them.

### Info

- **I-1. Signature malleability.** Fixed in 3073f69; `src/core/crypto.ts:74`. Verification compared decoded bytes, so a signature whose last base64url character differs only in the 2 unused bits was also accepted. It now compares the canonical string in constant time. Harmless before the fix (same wake id), but cleaner.
- **I-2. Node buffers up to `MAX_BODY_BYTES` before core auth.** Left; `src/adapters/node/server.ts:15`. Bounded at 1 MB by default with a 30 s request timeout, so L-4's "auth before body" does not fully hold on Node. A streaming bridge into `Request` is possible but not worth the complexity.
- **I-3. Reply token not bound to a bridge.** Left, documented in the README. Two bridges sharing a `REPLY_TOKEN_SECRET` would accept each other's tokens for the same chat. The docs require a unique secret per bridge. Changing the claim set would change the token format.
- **I-4. `/healthz` is unauthenticated.** Left. It shows booleans and rejected setting names, never values. That helps setup, and the risk is low.
- **I-5. `wake_id` in the body.** Left; `src/core/outbound.ts:32` (`main`:29). A caller holding `OUTBOUND_API_KEY` can pass `wake_id` with `final` to stop that wake's typing. That key is an operator credential; the impact is cosmetic.
- **I-6. Edited messages wake again.** Left, documented. This is by design, and the wake has `edited: true`. The reply skill now says to treat an edit as a correction. Rate limiting applies.
- **I-7. No Telegram source-IP allowlist.** Left. The secret token is Telegram's recommended check, and IP ranges change.
- **I-8. One global dedupe Durable Object.** Left. It serializes every claim, which caps throughput but is ample for a personal bot.
- **I-9. Failed forwards are not retried.** Left, documented. A retry after a timeout could double-wake the bot. The bridge logs the failure and stops typing.
- **I-10. Node version.** Left. `engines` says ≥22 and CI uses 22; this box has Node 20.19.2. Everything passes on 20.19, but vitest 5 would need Node 22, which is why vitest 4.1 was used.
- **I-11. Vercel function signature.** Left. `export default { fetch }` in `api/*.ts` is exercised in tests but not on a live Vercel deploy.
- **I-12. Replay semantics.** Decided and documented in the README (15824fe):
  - Tokens are multi-use within the TTL (15 min) so the assistant can send an acknowledgement, progress and the answer.
  - Each token works only for its chat and topic.
  - A token is rejected after `expires_at` or after `final: true` (a wake-closed check backed by the store).
  - A stale token cannot stop a newer wake's typing (wake-id compare, now race-free on Cloudflare after M-7).
  - Tokens never appear in logs, URLs, or error bodies.

## Changes after the review

Later branches changed some behavior this record describes. The findings above stay as written.

- The Upstash Redis store (`src/core/upstash.ts`) was removed. Vercel and Node use `MemoryStore`, and Cloudflare uses the Durable Object. L-22 went away with the store.
- An edit of a message that already woke the bot is ignored and logged as `edit_ignored` (I-6). An edit that first addresses the bot wakes it once.
- After an ambiguous forward, the bridge logs `forward_ambiguous` and keeps typing until the final send, `/typing/stop`, or the lease (I-9). After a definite failure it stops typing.

## Baseline vs final

| Check | Baseline (`main`) | Final (`eac2ec1`) |
| --- | --- | --- |
| `npm run lint` | exit 0 | exit 0 |
| `npm run typecheck` | exit 0 | exit 0 |
| `npm test` | 6 files, 57 tests passed (vitest 3.2) | 14 files, 97 tests passed (vitest 4.1.11) |
| `npm audit` | 6 (1 moderate, 3 high, 2 critical), all dev | 0 |

A clean `rm -rf node_modules && npm ci` followed by `npm test` passes on Node 20.19.2 with npm 9.2.

## Scrub

I checked the tree at HEAD and every line added on the branch (`git log -p main..HEAD`) for:
- the listed names, case-insensitive;
- real-looking `-100…` chat ids;
- bot tokens matching `\d+:[A-Za-z0-9_-]{30,}`;
- `workers.dev` / `vercel.app` subdomains.

- **Result:** clean.
- **Lockfile:** the only hits are two random runs inside `package-lock.json` sha512 integrity hashes. They are false positives.
- **Placeholder id:** a sequential placeholder supergroup id I had added in a test and the README was replaced with `-100500` in the commits that introduced it. Only my unpushed branch commits were rewritten; `main` was not touched.
- **Generic mention:** "workers.dev" appears in the setup skill, but only as a word with no subdomain.
- **Authors and history:** branch commit authors and bodies contain none of the strings. `main`'s history is unchanged; per the operator, its only known hits are the GitHub owner login in the initial commit's author and a Co-authored-by trailer.

## Not verified

- No live Telegram, Cloudflare, Vercel or Grok Bot run. Everything was checked through unit and adapter tests with mocked `fetch` and an in-memory Durable Object storage fake.
- Specifically unverified against the live services:
  - the `message_thread_id` rejection in non-forum groups (M-4);
  - privacy-mode delivery of @mentions (L-16);
  - Durable Object per-value limits under real load (M-5);
  - the Vercel handler shape (I-11);
  - `wrangler secret put` before the first deploy (it should create the Worker);
  - Grok Bot's exact confirmation-card flow when the assistant saves a routine.
- The Grok Bot behavior in the docs relies only on `/home/box/reference/app-ui.md` and the routines and channels skills.
- Action SHAs were not resolved (L-23).

## Operator verification (mechanical, added after the review)

- Re-ran on `security-review` (HEAD eac2ec1): `npm run lint` exit 0, `npm run typecheck` exit 0, `npm test` 14 files / 97 tests passed, `npm audit` 0 vulnerabilities. Baseline at `main` e4067a6: lint 0, typecheck 0, 6 files / 57 tests passed, audit 6 (1 moderate, 3 high, 2 critical).
- `fixes.patch` = `git format-patch main..security-review --stdout` (12 patches). Applied with `git am` to a fresh clone of the bundle at `main` (e4067a6): applied cleanly, resulting tree byte-identical to the branch tree, then `npm ci`, lint, typecheck all exit 0 and tests 14 files / 97 passed. Commit SHAs after `git am` differ from the SHAs cited above (new committer timestamps); match by subject.
- Citation check: all 57 file references in this document resolve to existing files; every `path:line` is within the file's length at the branch HEAD (or at `main` for left items). Spot-checked H-1 and L-21 lines for content.
- Scrub (tree + all reachable history, and `fixes.patch`): none of the listed names, no `-100…` chat IDs, no bot-token-shaped strings, no real workers.dev/vercel.app subdomains. Informational only: the GitHub owner login appears in the initial commit's author email and a Co-authored-by trailer on `main` (not in the patch).

## Inline keyboards

Added after this review. Not part of the original finding set.

- `callback_data` is HMAC-SHA256, truncated to 16 bytes, over a `cb1` domain separator, the chat id, the owner user id, the expiry, and the action. The chat and the owner are MAC inputs, not stored in the token, so a copied tap fails on any instance without a shared store. Version 2 (operator `OUTBOUND_API_KEY` sends, which have no wake user) omits the owner and is bound to the chat. The allowlist still applies. The signature does not name the message. Telegram does not require `callback_query.data` to be one of that message's buttons, so a tap is accepted only when that exact token is on the keyboard Telegram attached to the message. A token from another message in the same chat is rejected and does not claim it.
- Reply tokens minted for a wake now include that sender's `user_id`, so the button can be signed for them when `/send` hits a different instance than the webhook. Tokens without `user_id` still verify. Callback buttons on those tokens are refused (`buttons_require_user`). URL buttons are not signed.
- URL buttons are https only. Credentials, IP literals, localhost, and `api.telegram.org` are rejected. The bridge does not fetch the URL.
- The first accepted tap claims `(chat, bot message id)` and calls `editMessageReplyMarkup` with an empty keyboard. A second tap is answered "Already chosen." and does not wake. A failed MAC is answered "That button isn't for you." A caller who is not allowlisted gets an empty `answerCallbackQuery` and no wake.
- The one-tap claim uses the same store as other dedupe: the chat Durable Object on Cloudflare, process memory on Node and Vercel. The signature check does not. On Vercel a second instance can accept a second tap until the keyboard is gone. That matches the existing dedupe limitation. The action itself cannot be forged or replayed into another chat.
- Button `data` is capped at 27 bytes so the signed blob fits Telegram's 64-byte `callback_data`. Labels are capped at 64 characters. The wake puts the action in `callback.data` and the bot message text in `callback.message_text`. A private-chat Approve tap is defined as confirmation of that message only.
