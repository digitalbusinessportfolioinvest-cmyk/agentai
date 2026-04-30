# AgentAi

AI-powered communication platform. Create agents that handle inbound phone
calls and WhatsApp conversations autonomously: they capture data, calculate
a quote in real time, and a second agent communicates the proposal — all in
the same call.

Business-agnostic. Configure everything from a dashboard: who the agent is,
what to ask, how to price, who takes over to close. No code, no JSON, no
YAML.

---

## What it does

```
Cliente llama
   ↓
Recepcionista (voz A) recoge los datos
   ↓
Sistema calcula el presupuesto con tu fórmula  (5 ms, determinista)
   ↓
"Te paso con Marta del comercial..."   ←  bridge phrase, voz A
   ↓
Comercial (voz B) entra en la misma llamada con el total ya calculado
   ↓
Comunica la propuesta, recoge la decisión
   ↓
Webhook a tu CRM / módulo de contratos / lo que sea
```

Same flow on WhatsApp. Same flow on voice. Same flow with a single
standalone agent if you don't need the handoff.

---

## Capabilities

**Configurable agents.** Six tabs per agent: Personality, Presentation,
AI Disclosure, Script, Closing, Output. Plus a 💰 Pricing tab when you
want the agent to drive a quote.

**Multi-channel.** Same agent, same script, same data extraction, on voice
calls and WhatsApp. Language is assigned per phone number (ES, EN, IT, FR,
DE, PT).

**Multi-model LLMs.** Choose per agent: GPT-4o Mini, GPT-5 Nano, Claude
Haiku 4.5, Claude Sonnet 4.6, Gemini Flash 2.0, DeepSeek, Mistral Small,
Grok 2. All via a single OpenRouter API key.

**Configurable pricing.** Up to 15 variables (text, number, yes/no, choice)
and a free-form math formula. Evaluated by a sandboxed expression parser
(`expr-eval`) — no LLM in the calculation, fully deterministic, 5 ms per
quote. Test from the dashboard with a "Calculate" button before going live.

**Sales handoff.** When a captador agent has both pricing configured and a
linked sales agent, completion of the intake script triggers: formula is
calculated, voice changes mid-call, the second agent takes over with the
total injected into its system prompt. The customer never hangs up.

**Latency masking on voice.** Filler words, parallel LLM + TTS, audio
streaming via ElevenLabs, lazy ulaw cache. Sub-500ms perceived response
times.

**Truthful by design.** The agent always acknowledges being an AI when
asked. The wording is editable, the disclosure is not.

**Outputs.** Each completed conversation fans out in parallel: dashboard,
email, WhatsApp to the owner, JSON webhook to any URL. Plus REST API
(`GET /api/v1/conversations/completed`) for downstream modules to pull data.

---

## Quick start

### Local development (laptop, ngrok)

```bash
# Install dependencies
npm install

# Copy and fill in your API keys
cp .env.example .env
# Edit .env with your Twilio, OpenRouter, ElevenLabs, Deepgram keys

# Initialize SQLite database with demo data
npm run setup

# Start the server
npm run dev
```

Open `http://localhost:3000` and login with `demo@agentai.local` / `demo1234`.

In a second terminal, expose to the internet so Twilio can reach you:

```bash
ngrok http 3000
# Copy the https://xxxx.ngrok-free.app URL into NGROK_URL in .env
# Restart npm run dev
```

In the Twilio Console, point your number's voice + WhatsApp webhooks at
the ngrok URL (paths in step 8 of `DEPLOYMENT.md`).

### Production (VPS, 24/7)

See `DEPLOYMENT.md` for the full guide. Hetzner CX22 + Postgres + nginx
with WebSockets + certbot + systemd. About 30 minutes end-to-end.

Quick summary:

```
Ubuntu 24 VPS  →  Node 20  →  Postgres  →  nginx (with WS upgrade)
              →  certbot SSL  →  systemd unit  →  Twilio webhooks
```

---

## Stack

| Layer | Tech |
|-------|------|
| Backend | Node.js + Express (single process) |
| Frontend | React SPA in a single HTML (Babel inline, served by Express) |
| Database | SQLite (demo) / PostgreSQL (production) via Prisma ORM |
| Auth | JWT (jsonwebtoken + bcrypt) |
| Voice | Twilio Voice API + Media Streams (WebSocket) |
| WhatsApp | Twilio WhatsApp Business API |
| STT | Deepgram (real-time streaming) |
| TTS | ElevenLabs (streaming, ulaw_8000 native to Twilio) |
| LLM gateway | OpenRouter (one API for ~10 models) |
| Pricing | `expr-eval` (sandboxed, no LLM at runtime) |
| Storage | Filesystem (dev) — bring your own object store for production |

---

## Project structure

```
agentai/
├── README.md
├── DEPLOYMENT.md            # production VPS guide
├── ARCHITECTURE.md          # technical design document
├── CLAUDE.md                # implementation reference
├── CHANGES.md               # initial fix pass changelog
├── CHANGES_MVP.md           # pricing + handoff additions changelog
├── .env.example
├── package.json
├── prisma/schema.prisma
├── public/index.html        # React SPA dashboard (single file)
├── scripts/seed.js          # demo data
└── src/
    ├── server.js            # Express + WebSocket entry
    ├── middleware/
    │   ├── auth.js
    │   └── twilio-signature.js
    ├── routes/
    │   ├── auth.routes.js
    │   ├── agents.routes.js
    │   ├── scripts.routes.js
    │   ├── numbers.routes.js
    │   ├── conversations.routes.js
    │   ├── settings.routes.js
    │   ├── pricing.routes.js          ← variables + formula CRUD
    │   ├── webhooks.voice.routes.js
    │   ├── webhooks.whatsapp.routes.js
    │   └── v1/output.v1.js            ← public API for external modules
    ├── services/
    │   ├── llm.service.js             ← OpenRouter + prompt builder
    │   ├── conversation.service.js    ← state engine for WhatsApp + Gather
    │   ├── voice.stream.service.js    ← Media Streams handler + handoff
    │   ├── tts.service.js             ← ElevenLabs streaming TTS
    │   ├── stt.service.js             ← Deepgram streaming STT
    │   ├── latency.service.js         ← fillers + audio cache
    │   ├── pricing.service.js         ← formula evaluator (expr-eval)
    │   └── output.service.js          ← webhook/email/WhatsApp dispatch
    └── utils/logger.js
```

---

## Public API

For external modules to consume conversation data:

```
GET  /api/v1/conversations/completed?agentId=...&from=...&to=...
GET  /api/v1/conversations/:id/output
POST /api/v1/test-webhook          (verify a webhook endpoint is reachable)
```

Webhook payload format on conversation completion:

```json
{
  "event": "conversation.completed",
  "timestamp": "2026-04-29T12:34:56.000Z",
  "data": {
    "conversation_id": "uuid",
    "agent_name": "Photography Receptionist",
    "channel": "voice",
    "remote_number": "+34612345678",
    "language": "es",
    "status": "completed",
    "outcome": "data_collected",
    "duration_seconds": 142,
    "collected_data": {
      "event_type": "boda",
      "duration_hours": 4,
      "drone": false
    },
    "summary": "...",
    "calculated_total": 1452.00
  }
}
```

---

## Documentation index

- **`README.md`** — this file (overview, quick start)
- **`RAILWAY.md`** — deploy on Railway (PostgreSQL, env vars, Twilio URLs)
- **`DEPLOYMENT.md`** — production VPS deployment, step by step
- **`ARCHITECTURE.md`** — technical design, data model, flows
- **`CLAUDE.md`** — implementation reference for contributors
- **`CHANGES.md`** — first fix pass (security + correctness fixes)
- **`CHANGES_MVP.md`** — MVP additions (pricing engine + sales handoff)
