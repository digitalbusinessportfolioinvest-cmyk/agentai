# CLAUDE.md — AgentAi Implementation Reference

Contributor reference. Read `ARCHITECTURE.md` for the design rationale and
`README.md` for the user-facing overview. This file is the practical guide
to working on the codebase.

---

## What this project is

AgentAi is a generic AI-powered communication platform. Users sign up,
configure AI agents, assign phone numbers, and the agents handle voice
calls and WhatsApp conversations autonomously.

A captador agent collects structured data through natural conversation. If
configured with a pricing formula and a linked sales agent, it computes
the proposal and hands off the same call to the sales agent who
communicates the total. Same channel, no hangup, voice changes mid-call.

Business-agnostic. Same agent, same script, two channels.

---

## Stack (what's actually built — not aspirational)

- **Backend**: Node.js + Express (single process serves API + frontend)
- **Frontend**: React SPA in `public/index.html`, Babel inline (no build
  step). Sufficient for the MVP; migrate to a build pipeline when the SPA
  outgrows ~600 lines.
- **Database**: SQLite for dev (`file:./dev.db`), PostgreSQL for production
  (set provider in `prisma/schema.prisma` and `DATABASE_URL` accordingly)
- **ORM**: Prisma 5
- **Auth**: JWT (`jsonwebtoken` + `bcrypt`)
- **Voice**: Twilio Voice API + Media Streams (WebSocket on `/api/webhooks/voice/media-stream`)
- **WhatsApp**: Twilio WhatsApp Business API
- **STT**: Deepgram streaming (voice channel only)
- **TTS**: ElevenLabs streaming (voice channel only, ulaw_8000 native to Twilio)
- **LLM gateway**: OpenRouter (~10 models accessible via single OpenAI-compatible API)
- **Pricing**: `expr-eval` (sandboxed expression parser, no LLM at runtime)
- **Storage**: local filesystem in dev. Object store (R2 / B2) is a
  future addition when needed.

No queue, no Redis, no separate frontend build, no microservices. One
Node process behind nginx. Everything else (Twilio, Deepgram, ElevenLabs,
OpenRouter, Postgres) is an external service.

---

## Project layout

```
src/
├── server.js                          Express + WebSocket entry, wires everything
├── middleware/
│   ├── auth.js                        JWT verification
│   └── twilio-signature.js            X-Twilio-Signature validation (mandatory in prod)
├── routes/
│   ├── auth.routes.js                 register, login, /me
│   ├── agents.routes.js               CRUD + role/salesAgentId/handoffMessage
│   ├── scripts.routes.js              CRUD on script steps (+ atomic reorder)
│   ├── numbers.routes.js              CRUD on phone numbers (ownership checked)
│   ├── conversations.routes.js        list + detail (read-only from dashboard)
│   ├── settings.routes.js             user preferences + per-tenant API keys
│   ├── pricing.routes.js              variables + formula + test calculator
│   ├── webhooks.voice.routes.js       Twilio voice inbound + status callback
│   ├── webhooks.whatsapp.routes.js    Twilio WhatsApp inbound
│   └── v1/output.v1.js                Public API for external modules
├── services/
│   ├── llm.service.js                 OpenRouter client + prompt builder
│   │                                  (now takes optional salesContext for handoff)
│   ├── conversation.service.js        State machine for WhatsApp + voice fallback
│   │                                  (handles handoff inside one turn for those channels)
│   ├── voice.stream.service.js        Media Streams handler with mid-call handoff
│   ├── tts.service.js                 ElevenLabs streaming + non-streaming
│   ├── stt.service.js                 Deepgram streaming WebSocket
│   ├── latency.service.js             Filler phrases + lazy ulaw audio cache
│   ├── pricing.service.js             validateConfig, calculate (expr-eval)
│   └── output.service.js              webhook + email + WhatsApp + dashboard fanout
└── utils/logger.js                    Winston, console only
```

---

## Data model

### Agent

The configurable unit. Six functional roles in the schema:

| Field group | Purpose |
|-------------|---------|
| `name`, `description`, `systemPrompt` | Personality |
| `greetingMessage` | Presentation |
| `aiDisclosure` | What it says when asked "are you AI?" — never fully overridable |
| `closingMessage`, `goodbyeMessage`, `fallbackBehavior` | Closing |
| `channels`, `voiceId`, `llmModel`, `temperature` | Channel + voice + LLM |
| `notify*` | Output destinations |
| `role`, `salesAgentId`, `handoffMessage` | Handoff config |
| `pricingVariables`, `pricingFormula`, `pricingCurrency` | Pricing |

`role` values: `intake`, `sales`, `standalone`. The role doesn't change
behavior at runtime — the runtime picks intake vs sales based on
`Conversation.currentRole`. The role field is informational and helps the
dashboard render the agent appropriately.

`salesAgentId` is a self-relation on Agent: an intake agent points to its
sales agent. An agent cannot be its own sales agent (validated in
`agents.routes.js`).

### Conversation

Tracks one customer interaction across one channel. Key fields beyond the
obvious:

- `currentRole`: `intake` (in captador phase), `sales` (after handoff),
  `completed` (no further mutation expected). Default `intake`.
- `calculatedTotal`: set when pricing runs at handoff. Null otherwise.
- `salesAgentId`: which sales agent took over this specific conversation.
  May differ from `Agent.salesAgentId` if the captador's salesAgent
  changed after this conversation already handed off.
- `scriptProgress` (JSON string): for sales role, holds the sales agent's
  collected data (e.g. the decision). For intake role, mirrors the
  collectedData rows for fast access.

### ConversationData

Captured fields during the **intake** phase only. Each row references a
ScriptStep and stores the value as a string. Sales-phase data lives in
`scriptProgress` because that schema's a free-form decision, not part of
the structured intake.

### Other models

- `User`, `PhoneNumber`, `ScriptStep`, `Message` — straightforward.
- `ApiKey` — exists for future REST API token auth, not used yet.

---

## Conversation flow

### Voice via Media Streams (Level 3 — when ElevenLabs + Deepgram are set)

```
Twilio → POST /api/webhooks/voice/incoming
  → Signature validated (twilio-signature middleware)
  → conversation created (currentRole=intake, direction=inbound)
  → TwiML returned with <Connect><Stream url="wss://...">

Twilio opens WebSocket → /api/webhooks/voice/media-stream
  → server.js spawns voice.stream.service.handleMediaStream()
  → loads intake agent + sales agent (if any) + history
  → starts Deepgram STT WebSocket

Per user utterance:
  → STT detects speech_final
  → processUserUtterance(text)
      filler text from latency.service (instant, cached after first use)
      LLM call in parallel with filler audio
      llm.parseResponse → { say, data, scriptComplete }
      tts.streamToTwilio streams ulaw_8000 chunks back
  → If scriptComplete in intake mode AND salesAgentId AND pricing exists:
      handoffToSales()
        pricing.calculate(intakeAgent, collectedProgress)
        persist currentRole=sales, calculatedTotal, salesAgentId
        speak handoffMessage in intake voice
        swap voiceId, scriptSteps, salesContext
      next user utterance is processed by sales agent

Twilio call ends → close handler tears down Deepgram + DB updates
```

### Voice fallback (Level 1 — Gather/Say) and WhatsApp

When ElevenLabs/Deepgram not configured, voice falls back to TwiML
`<Gather input="speech">` with Google TTS. Same pattern as WhatsApp:
each turn is a separate HTTP request to the webhook.

```
Inbound → conversation.service.processMessage(conversationId, userText)
  Loads conversation + active agent (intake or sales depending on currentRole)
  Builds prompt (with salesContext if currentRole === 'sales')
  LLM call (non-streaming)
  Saves messages + extracted data
  If scriptComplete in intake AND handoff possible:
    pricing.calculate
    Generates sales agent's opening message via second LLM call
    Returns combined: intakeReply + "\n\n" + salesOpening
    Persists currentRole=sales etc.
  Else if scriptComplete:
    Marks completed, fires output notifications
```

The combined-reply trick is a workaround for channels where you can't
mid-stream change personas. The customer sees a single WhatsApp message
that has the captador's closing followed by the comercial's greeting + total.

---

## Pricing

`pricing.service.js` is the calculation engine. Three public functions:

- `parseVariables(jsonString)` — validates the `pricingVariables` blob:
  max 15 entries, each with valid identifier label, valid type, choices
  array for `choice` type. Throws on any malformedness.
- `compileFormula(formula, variables)` — parses with `expr-eval`. Rejects
  formulas that reference symbols not in the variable list (or in the
  auto-generated `<label>_idx` companions for choice types). Rejects
  assignment, string concatenation, and `in` operator.
- `calculate(agent, inputs)` — runs the full pipeline: parse vars, compile
  formula, coerce inputs to declared types, evaluate, round to 2 decimals,
  return `{ amount, currency, inputs }`.

The `validateConfig({ variables, formula })` helper does parse-only
validation for the dashboard's Save action.

### Coercion rules

- `text`: `String(value)`
- `number`: `Number(value)`, NaN rejected
- `boolean`: accepts `true`/`false`/`1`/`0`/`yes`/`no`/`sí`/`y`/`n`
- `choice`: accepts the literal string. Also exposes `<label>_idx` to the
  formula (zero-based index in the choices array). Use `_idx` for
  arithmetic dispatch on choice values.

### Security

`expr-eval` is configured to disable: assignment, string concatenation,
the `in` operator. It has no access to `eval`, `Function`, the filesystem,
network, or any host objects. Worst case a malicious formula loops or
returns NaN; we catch the latter explicitly. Loop bombs are mitigated by
`expr-eval`'s lack of any iteration construct in the parser.

---

## API conventions

### Response shape

Success:
```json
{ "success": true, "data": <whatever>, "meta": { ... }? }
```

Error:
```json
{ "success": false, "error": { "code": "UPPER_SNAKE", "message": "..." } }
```

### Multi-tenancy rule

**Every Prisma query that touches a tenant-owned table includes
`userId` in the where clause** (or in the join). The two helpers
`ownsAgent`, `ownsNumber`, `ownsStep` in the route files codify this.
If you add a new table that's per-user, add the same pattern.

### Twilio webhooks

All Twilio inbound endpoints (voice + WhatsApp) sit behind
`twilio-signature.js` which validates the `X-Twilio-Signature` header
against the request body and full URL. The `SKIP_TWILIO_SIGNATURE=true`
env flag exists ONLY for local curl testing — never set it in prod.

### LLM calls

Use `llm.chat(agent, messages, { stream, apiKey })`. The function picks
up the agent's model, applies `response_format: { type: "json_object" }`
when the model supports it (currently OpenAI, Anthropic, Mistral
families), and returns either a stream or the raw string.

`llm.parseResponse(rawString)` is the robust parser: tries direct JSON,
then strips fences and retries, then extracts the first balanced `{...}`
respecting strings and escapes, then last-resort strips JSON-looking
characters and uses what's left as the say. This is what prevents the
model from accidentally speaking JSON braces to the caller.

When you need handoff context in the prompt, pass `salesContext` as the
7th argument to `llm.buildPrompt()`. The function rewrites the prompt to
say "you're receiving a handoff, the total is X, don't re-collect data".

---

## Adding a new feature — checklist

1. **Schema first**: edit `prisma/schema.prisma`, run
   `npx prisma migrate dev --name <description>`. Migration files commit
   alongside the code change.
2. **Service**: business logic in `src/services/<thing>.service.js`. Pure
   functions where possible. Inject `prisma` via require, not via
   parameter — same singleton.
3. **Route**: thin handler in `src/routes/<thing>.routes.js`. Always use
   `ownedX` helpers for ownership. Always return the canonical response
   shape. Mount in `server.js`.
4. **Frontend**: extend `public/index.html`. The SPA is a single file with
   inline Babel — keep it that way until it hurts.
5. **Test**: at minimum, syntax-check (`node --check src/**/*.js`). For
   the pricing engine, the kind of tests in `CHANGES_MVP.md` are the
   target shape. There's no test runner wired yet — when you're ready to
   add one, vitest is the lightest option.

---

## Things to know that aren't obvious

- **History window is the most recent 20 messages** (descending order then
  reversed before sending to LLM). Earlier code took the first 20 in
  ascending order which is a silent bug after turn 11. See `CHANGES.md`.
- **Filler audio is cached lazily in ulaw_8000**. The cache populates on
  first use of each `(voiceId, phrase)` pair. There's an unused
  `pregenerateCommonPhrases()` helper if you want to warm it up at agent
  creation; not wired by default.
- **The audio cache cannot be sent to Twilio in one frame**. Twilio media
  events have a payload size limit. We chunk at 8 KB of raw ulaw which
  encodes to ~10 KB base64 — well under the limit, more than enough
  margin for any realistic filler phrase length.
- **`Agent.whatsappTimeout` is honored**. Idle WhatsApp conversations
  beyond the timeout (default 24h) are auto-marked `abandoned` and the
  next message starts a fresh conversation. `findActiveWhatsAppConversation`
  in `conversation.service.js` does the check.
- **The seeded `demo@agentai.local` account must be removed before
  production.** It's there only to make the first dashboard login painless.
  See `DEPLOYMENT.md` "Production hardening".
- **OpenRouter per-user API keys are wired through** for `llm.chat`.
  Plumb additional providers (Twilio, ElevenLabs, Deepgram) the same way
  if you go true multi-tenant — the pattern is `user.openrouterKey ||
  process.env.OPENROUTER_API_KEY`.

---

## Out of scope for the current MVP

These are explicitly not built; come back when you need them:

- **Outbound calls/messages.** AgentAi is inbound-only. The system can't
  initiate a call to a customer. Architecture is ready (Conversation has
  `direction='outbound'` already), but no endpoint disptaches it.
- **Multi-tenant SaaS billing.** No Stripe, no plans, no quotas. Single
  tenant for now.
- **Encrypted secrets at rest.** API keys in `User` table are plaintext.
  Hardening for multi-tenant SaaS only.
- **Real email integration.** `output.service` logs to console with a
  TODO. Resend is the recommended drop-in (~10 lines).
- **Voice preview in dashboard.** Pick voice IDs by hand from
  elevenlabs.io for now. A `/preview-voice` endpoint is ~30 lines if you
  want to add it.
- **Workflow engine for multi-step processes.** AgentAi is the
  conversation layer. Long-running processes (12-step business workflows
  in your case) live in their own service that talks to AgentAi via
  webhooks. Out of scope here.
- **Token-streaming LLM into TTS.** TTS audio is streamed; LLM is not.
  Implementing token-level streaming requires changing the JSON envelope
  format (the model returns `{say, data, script_complete}` which can't be
  streamed mid-key). Future change.

---

## Quick reference: response and webhook payload formats

### API success
```json
{ "success": true, "data": { ... }, "meta": { "total": 100, "limit": 50, "offset": 0 } }
```

### API error
```json
{ "success": false, "error": { "code": "AGENT_NOT_FOUND", "message": "..." } }
```

### Webhook event (sent by output.service on completion)
```json
{
  "event": "conversation.completed",
  "timestamp": "2026-04-29T12:34:56.000Z",
  "data": {
    "conversation_id": "uuid",
    "agent_name": "...",
    "channel": "voice|whatsapp",
    "remote_number": "+34...",
    "language": "es",
    "status": "completed",
    "outcome": "data_collected",
    "duration_seconds": 142,
    "collected_data": { "field": "value" },
    "summary": "...",
    "calculated_total": 1452.00
  }
}
```
