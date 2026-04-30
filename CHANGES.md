# AgentAi — CHANGES

Fixes applied in this pass. Eleven files changed, one added, one stray
directory removed. Backend went from 2,123 to 2,419 lines (about 14% growth,
mostly ownership checks, the signature middleware, and the more defensive
JSON parser).

---

## Critical (server didn't start / production-unsafe)

### 1. Wrong require paths in `src/routes/v1/output.v1.js` — startup blocker

The file is two levels deep (`src/routes/v1/`) but used `../middleware/auth`
and `../services/output.service`, which resolve to `src/routes/middleware/...`
(non-existent). Node throws `Cannot find module` and the server fails to
boot. Fixed to `../../middleware/auth` and `../../services/output.service`.
Also folded the duplicate inline `require` call into the single top-of-file
import.

### 2. Stray `{src/{config,middleware,routes,routes` directory at project root

Leftover from a `mkdir -p {src/{...},...}` command run in a shell that
didn't expand brace syntax. Deleted.

### 3. Route ordering bug in `src/routes/scripts.routes.js` — reorder was dead code

`PUT /:agentId/:stepId` was registered before `PUT /:agentId/reorder`.
Express matches in order, so `PUT /api/scripts/abc/reorder` hit the step
update handler with `stepId="reorder"`, tried to update a non-existent step,
and returned a Prisma error. The dashboard's drag-and-drop reorder silently
failed.

Fix: registered the `/reorder` route first, wrapped the update in a
`prisma.$transaction` so partial reorders can't leave the table in a
half-updated state, and added a check that every `stepId` in the payload
actually belongs to the requested agent (otherwise an attacker could renumber
another tenant's steps).

### 4. Multi-tenancy holes in `numbers.routes.js` and `scripts.routes.js`

PUT and DELETE on `/api/numbers/:id`, DELETE on `/api/scripts/:agentId/:stepId`,
and the reorder endpoint did not verify ownership before mutating. Any
authenticated user could modify or delete any other tenant's resources by
guessing UUIDs. CLAUDE.md explicitly mandates `userId` filtering on every
query.

Fix: added `ownsNumber()`, `ownsAgent()`, and `ownsStep()` helpers and used
them as the first step in every mutating handler. POST `/api/numbers` and PUT
`/api/numbers/:id` now also validate that any incoming `agentId` is owned by
the same user.

### 5. Message-history truncation read the wrong end

In `conversation.service.js` (line 16) and `voice.stream.service.js` (line
46) the LLM history was loaded with `orderBy: { createdAt: 'asc' }, take: 20`,
which returns the *first* 20 messages. After turn 11 the LLM never saw recent
context — only the original opener replayed forever. Particularly bad on
WhatsApp where conversations span days.

Fix: load `orderBy: 'desc', take: 20` and reverse to chronological before
sending to the model. Also bounded the in-memory history array in
`voice.stream.service.js` so long calls don't grow without limit.

---

## Important (claimed features that didn't work)

### 6. Twilio webhook signature validation — was missing

CLAUDE.md mandates "Twilio webhook signature validation on all endpoints" but
no validation existed. Anyone with the public ngrok / app URL could spoof
inbound calls and WhatsApp messages, pollute the database, and burn
OpenRouter / ElevenLabs / Deepgram credit.

Fix: new `src/middleware/twilio-signature.js` that uses
`twilio.validateRequest()` against the `X-Twilio-Signature` header. Both
`webhooks.voice.routes.js` and `webhooks.whatsapp.routes.js` now mount this
middleware as `router.use(...)`. A `SKIP_TWILIO_SIGNATURE=true` env flag
exists for local curl testing — must be left off in any environment that
receives real Twilio traffic.

### 7. JSON parsing of LLM output was fragile and could leak braces

The prompt asks for a strict JSON envelope, but the parser was a single
`JSON.parse()` with a fallback that treated *any* non-JSON text as the
spoken reply. When models emit JSON inside markdown fences or with prose
before/after, the catch path was triggered and the raw text — including
braces — was sent to TTS, so callers heard the agent literally say "open
brace, quote, say...".

Fix: three-tier parser in `llm.service.js`:
- Strip markdown fences and try direct parse
- If that fails, find the first balanced `{...}` block via a brace counter
  that respects strings and escape characters
- Only as a last resort, strip JSON-looking characters from the raw text and
  use what's left as the speech

Also: when the model is one that supports it (OpenAI, Anthropic, Mistral via
OpenRouter), the request now includes `response_format: { type: "json_object" }`
so the model is constrained to valid JSON at the API level.

### 8. Audio cache for filler phrases never worked

Three problems compounded:
- `pregenerateCommonPhrases()` was exported but never called anywhere — the
  cache was always empty
- `synthesize()` returned mp3 (default ElevenLabs format) but the cached
  bytes were sent into Twilio media events, which expect mulaw 8 kHz —
  callers would have heard noise even if the cache had been populated
- The streamFillerToTwilio path sent the entire cached buffer in one
  oversized media frame

Fix: `synthesize()` now takes a `format` parameter defaulting to `ulaw_8000`
(the Twilio-native format), which means cached audio can be sent without
re-encoding. `voice.stream.service.js` populates the cache lazily on first
use of each `(voiceId, phrase)` pair, and chunks the cached buffer into
~8 KB media frames. Subsequent uses of the same filler hit the cache
instantly. `pregenerateCommonPhrases` now also requests ulaw_8000 so it can
be wired in later (e.g. on agent creation) without re-encoding.

### 9. `Agent.whatsappTimeout` was never read

Schema had a `whatsappTimeout` column (default 1440 minutes) but no code
read it. Idle WhatsApp conversations stayed `active` forever, so a customer
who messaged again three months later would resume the same conversation
with stale collected data.

Fix: `findActiveWhatsAppConversation` now reads the agent's timeout, and if
the candidate conversation's `lastActivityAt` is older than that, marks it
`abandoned` and returns null so the next message starts a fresh conversation.

### 10. Per-tenant API keys were stored but never used

The `User` model has `openrouterKey`, `elevenlabsKey`, `twilioToken` columns,
and the settings endpoint writes to them. But every service only read from
`process.env`, so the per-tenant keys were dead weight (and stored in
plaintext, with no payoff).

Fix: `conversation.service.js` and `voice.stream.service.js` now load the
user's `openrouterKey` along with the conversation/agent and pass it to
`llm.chat({ apiKey })`. Falls back to the platform key when the user
hasn't configured their own. ElevenLabs and Deepgram per-tenant keys are
left as env-only for now since they're called from many places — that's a
follow-up if real multi-tenancy is needed.

### 11. Status callback URL was undocumented and partial

`/api/webhooks/voice/status` existed but the TwiML returned by `/incoming`
never told Twilio to call it back, so `durationSeconds` and `recordingUrl`
were always null. Also, the handler used `updateMany` unconditionally,
which would overwrite the `completed`/`data_collected` outcome that the
conversation engine had already set with a generic completed/no-outcome.

Fix: status handler now reads the existing conversation and only sets
`status='completed'` when it was still `active`, and only sets `outcome=
'partial'` when no outcome was set. (To actually wire the callback,
configure the Twilio number's "Call status changes" webhook to point at
`<NGROK_URL>/api/webhooks/voice/status`. This is not in `TwiML <Connect>`,
it's a Twilio number setting.)

---

## Not done in this pass (deliberate)

- **True LLM token streaming into TTS (Layer 3 LLM streaming).** TTS audio
  *is* streamed (ElevenLabs ulaw chunks forwarded to Twilio as they arrive),
  but the LLM call itself is non-streaming because the model returns a
  structured JSON envelope and parsing partial JSON token-by-token to extract
  the `say` field early is more involved than a bug fix. The honest claim
  is: "audio of the response streams; LLM response itself is generated in
  one shot, with filler audio masking the LLM latency." The voice-stream
  comments now say exactly this.

- **Encryption of stored API keys.** Currently plaintext in the `User`
  table. For real production, wrap with libsodium/secret-box or move to a
  KMS-backed secret store. Out of scope for "make it run safely."

- **Updating CLAUDE.md to match the actually-built stack.** CLAUDE.md
  describes Next.js 14, PostgreSQL, Bull + Redis. The codebase ships with
  a Babel-in-browser SPA, SQLite, no queue. The doc is aspirational — it
  should be rewritten to match reality so future contributors don't get
  misled, but that's a docs task, not a code fix.

- **Barge-in on voice calls.** The agent currently can't be interrupted
  while it's speaking; mid-response audio from the caller is dropped. For
  a "natural conversation" claim this matters, but implementing it requires
  echo cancellation and a mid-utterance abort path. Out of scope.

---

## Files touched

```
M  .env.example                                    (added SKIP_TWILIO_SIGNATURE, TWILIO_WHATSAPP_FROM)
A  src/middleware/twilio-signature.js              (new — signature validation)
M  src/routes/numbers.routes.js                    (ownership checks)
M  src/routes/scripts.routes.js                    (route order, ownership, atomic reorder)
M  src/routes/v1/output.v1.js                      (require paths fix)
M  src/routes/webhooks.voice.routes.js             (signature middleware, status callback semantics)
M  src/routes/webhooks.whatsapp.routes.js          (signature middleware)
M  src/services/conversation.service.js            (history order, whatsappTimeout, per-user key)
M  src/services/latency.service.js                 (pregenerate uses ulaw)
M  src/services/llm.service.js                     (json_object mode, robust parser, per-user key)
M  src/services/tts.service.js                     (format parameter, ulaw default)
M  src/services/voice.stream.service.js            (history order, lazy ulaw cache, per-user key)
D  {src/...                                        (stray directory removed)
```

All 21 JS files pass `node --check`. The require-path fix and the route
ordering fix were verified by isolated runtime tests.
