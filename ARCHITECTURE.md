# AgentAi — AI Voice Call Management Platform

## Architecture Document v1.0

---

## 1. Vision

AgentAi is a generic AI-powered communication management platform. Any user can sign up, configure an AI agent, assign it a phone number, and have it handle voice calls and WhatsApp conversations autonomously. The platform collects data, transcribes everything, and exposes it through an API for external module integration.

AgentAi does not care what the user does with it. It is a tool — like Typeform is for forms, AgentAi is for phone calls and WhatsApp.

The same agent, same script, same logic works across both channels. Only the interface changes: voice uses STT + TTS, WhatsApp uses text. A conversation can even start on one channel and continue on the other.

---

## 2. Core Principles

- **Generic by design**: The platform knows nothing about the user's business. All behavior is defined by the user through configuration.
- **Modular architecture**: Module 1 (Call Management) is self-contained but exposes a full REST API. Future modules (budgeting, coordination, contracts, payments, invoicing) connect through this API.
- **Easy to parametrize**: Non-technical users must be able to configure agents entirely through the dashboard UI — no code, no JSON, no YAML.
- **Multi-channel**: Voice calls and WhatsApp from the same agent, same script, same data collection. The channel is transparent to the business logic.
- **Multi-language by number**: Each phone number is tied to a language. The same agent logic runs regardless of language.
- **Multi-tenant**: Each user account is fully isolated.

---

## 3. Module 1 — Call Management (Current Scope)

### 3.1 What It Does

1. User creates an account
2. User creates one or more "Agents"
3. Each Agent has: name, personality/instructions, voice (for calls), language, assigned phone number(s), and a conversation script (what to ask, what data to collect)
4. When a call or WhatsApp message comes in (inbound), or the system initiates one (outbound), the Agent follows the script, communicates naturally, and collects data
5. Every conversation is logged: recording/chat history, transcription, extracted data, duration, outcome
6. User sees everything in a dashboard
7. All data is accessible via REST API for external modules
8. Conversations can cross channels: start on WhatsApp, escalate to voice call, send summary back via WhatsApp

### 3.2 User-Facing Features

#### Agent Builder
- Agent name and description
- System prompt / personality (free text — "You are a friendly receptionist for a photography service...")
- Channels enabled: Voice, WhatsApp, or both
- Voice selection (ElevenLabs voice ID, with preview) — only for voice channel
- Language (tied to phone number)
- Conversation script builder:
  - Ordered list of questions/topics
  - Each question has: label, prompt text, expected data type (text, number, date, email, phone, yes/no, choice from list)
  - Optional: conditional logic (if answer to Q2 is "wedding", add Q2a, Q2b, Q2c)
  - Optional: closing message / next steps message
  - Optional: channel-specific behavior (e.g., send image/PDF via WhatsApp after collecting data)
- Fallback behavior: what to do if the AI can't handle the conversation (transfer to human, take message, hang up/end chat with apology)
- Cross-channel actions:
  - After voice call → send summary via WhatsApp
  - During WhatsApp → offer to escalate to voice call
  - After data collection → send confirmation/document via WhatsApp

#### Phone Number Management
- Add Twilio numbers (user provides their own Twilio credentials or uses platform-provided numbers)
- Assign number → Agent + Language + Channels (voice, WhatsApp, or both)
- Same Twilio number can handle both voice and WhatsApp
- Example: +34 612 345 678 → "ReceptionBot" → Spanish → Voice + WhatsApp
- Example: +1 555 123 4567 → "ReceptionBot" → English → Voice only
- Same agent, different numbers, different languages, different channel configs

#### Conversation Dashboard
- List of all conversations (filterable by agent, channel, date, status, outcome)
- Channel indicator: phone icon for voice, WhatsApp icon for messages
- Each conversation shows:
  - Date/time, duration (voice) or message count (WhatsApp)
  - Phone number (caller/messager or called/messaged)
  - Channel: voice or WhatsApp
  - Agent that handled it
  - Status: completed, failed, transferred, no-answer, pending (WhatsApp async)
  - Collected data (structured, per-question)
  - Full transcription (voice) or chat history (WhatsApp)
  - Audio recording (playable, voice only)
  - AI confidence score (how well it handled the conversation)
- Linked conversations: when a conversation spans channels, they are linked together
- Export to CSV/JSON

#### Outbound Campaigns (v1.1)
- Upload a list of phone numbers
- Assign an Agent
- Choose channel: voice call, WhatsApp, or WhatsApp first → escalate to call
- Schedule (time window, timezone, max concurrent)
- Track progress: pending, completed, failed, callback-needed
- WhatsApp campaigns can send initial template message + continue with AI when user replies

### 3.3 Technical Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        FRONTEND                              │
│              React SPA (single index.html)                   │
│   Dashboard │ Agent Builder │ Conversations │ Settings       │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                      API LAYER                               │
│                  Node.js + Express                            │
│                                                              │
│  /api/auth/*          Authentication (JWT)                   │
│  /api/agents/*        Agent CRUD + configuration             │
│  /api/numbers/*       Phone number management                │
│  /api/conversations/* Conversation logs, transcriptions, data│
│  /api/scripts/*       Conversation script management         │
│  /api/webhooks/*      Twilio webhook handlers (voice + WA)   │
│  /api/v1/*            Public API (for external modules)      │
│                                                              │
└───────┬──────────┬──────────┬──────────┬────────────────────┘
        │          │          │          │
        ▼          ▼          ▼          ▼
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────────┐
│ Twilio   │ │ElevenLabs│ │OpenRouter│ │     Database         │
│          │ │          │ │(LLM GW) │ │   PostgreSQL          │
│ - Voice  │ │ - TTS    │ │- Claude  │ │                      │
│ - WhatsApp│ │ - Voices │ │- GPT     │ │ - Users              │
│ - Numbers│ │ - Stream │ │- Gemini  │ │ - Agents             │
│ - Record │ │          │ │- DeepSeek│ │ - Scripts             │
│ - STT    │ │          │ │- Mistral │ │ - Conversations      │
│          │ │          │ │- Grok    │ │ - ConversationData   │
│          │ │          │ │- 290+    │ │ - PhoneNumbers       │
│          │ │          │ │          │ │ - Messages (WA)      │
└──────────┘ └──────────┘ └──────────┘ └──────────────────────┘
```

### 3.4 Conversation Flows

#### Voice Call Flow (Inbound)

```
Phone call to Twilio number
        │
        ▼
Twilio sends webhook to /api/webhooks/voice/incoming
        │
        ▼
System identifies: which number → which Agent → which language
        │
        ▼
WebSocket/streaming connection established
        │
        ▼
┌─── CONVERSATION LOOP ───────────────────────┐
│                                              │
│  1. Twilio streams caller's audio            │
│  2. Speech-to-Text (Deepgram, streaming)     │
│  3. LATENCY MASKING ENGINE kicks in:         │
│     a. [INSTANT] Play filler/acknowledgment  │
│     b. [PARALLEL] Text goes to LLM via       │
│        OpenRouter with:                      │
│        - Agent system prompt                 │
│        - Conversation script (current step)  │
│        - Conversation history                │
│        - Collected data so far               │
│  4. LLM streams response with:               │
│     - What to say next                       │
│     - Data extracted from caller's answer    │
│     - Next script step (or done)             │
│  5. Response text → ElevenLabs TTS streaming │
│  6. Audio streamed back to caller via Twilio │
│     (seamless from filler to real response)  │
│                                              │
│  Repeat until script complete or caller ends │
└──────────────────────────────────────────────┘
        │
        ▼
Call ends → Save: recording, transcription, collected data, outcome
        │
        ▼
Optional: send summary/document via WhatsApp to same number
        │
        ▼
Data available in dashboard + API
```

#### WhatsApp Flow (Inbound)

```
WhatsApp message to Twilio number
        │
        ▼
Twilio sends webhook to /api/webhooks/whatsapp/incoming
        │
        ▼
System identifies: which number → which Agent → which language
        │
        ▼
Check if active conversation exists for this sender
  ├─ No  → Create new conversation, start script from step 1
  └─ Yes → Load conversation state, continue from last step
        │
        ▼
┌─── MESSAGE PROCESSING ──────────────────────┐
│                                              │
│  1. Receive text (+ optional media)          │
│  2. Text goes to LLM via OpenRouter with:    │
│     - Agent system prompt                    │
│     - Conversation script (current step)     │
│     - Message history                        │
│     - Collected data so far                  │
│  3. LLM responds with:                       │
│     - Reply text                             │
│     - Data extracted from user's message     │
│     - Next script step (or done)             │
│  4. Reply sent via Twilio WhatsApp API       │
│     - Can include text, images, PDFs,        │
│       buttons, list options                  │
│                                              │
│  Async: user replies whenever they want      │
│  Timeout: configurable (e.g., 24h no reply   │
│  → mark as abandoned or send reminder)       │
└──────────────────────────────────────────────┘
        │
        ▼
Script complete or conversation ends
        │
        ▼
Save: chat history, collected data, outcome
        │
        ▼
Data available in dashboard + API
```

#### Cross-Channel Flow

```
Client calls → AI collects data via voice
        │
        ▼
Call ends → AI sends WhatsApp:
  "Thanks for calling! Here's a summary of what we discussed:
   - Event: Wedding
   - Date: June 15
   - Location: Madrid
   We'll send you a quote shortly."
        │
        ▼
Quote ready → AI sends WhatsApp with PDF attachment
        │
        ▼
Client replies "yes" on WhatsApp → triggers next module via webhook
```

Key difference between channels:
- **Voice**: Real-time, synchronous. Full conversation in one session. Requires STT + TTS.
- **WhatsApp**: Asynchronous. Conversation can span hours/days. Text only (no STT/TTS needed). Supports rich media (images, PDFs, buttons, lists).

### 3.5 Database Schema

```sql
-- Multi-tenant users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    company_name VARCHAR(255),
    twilio_account_sid VARCHAR(255),      -- User's own Twilio credentials
    twilio_auth_token VARCHAR(255),       -- Encrypted
    elevenlabs_api_key VARCHAR(255),      -- Encrypted
    llm_provider VARCHAR(50) DEFAULT 'openrouter',  -- openrouter (handles all models)
    llm_api_key VARCHAR(255),            -- Encrypted (user can override with own OpenRouter key)
    plan VARCHAR(50) DEFAULT 'free',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI Agents
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    system_prompt TEXT NOT NULL,           -- Personality and behavior instructions
    channels JSONB DEFAULT '["voice", "whatsapp"]',  -- Enabled channels
    voice_id VARCHAR(255),                -- ElevenLabs voice ID (voice channel only)
    voice_name VARCHAR(255),              -- Display name
    llm_model VARCHAR(100) DEFAULT 'openai/gpt-5-nano',  -- OpenRouter model ID
    temperature DECIMAL(3,2) DEFAULT 0.7,
    max_call_duration_seconds INT DEFAULT 600,  -- 10 min default (voice)
    whatsapp_timeout_minutes INT DEFAULT 1440,  -- 24h default (WhatsApp inactivity)
    whatsapp_reminder_enabled BOOLEAN DEFAULT false,
    whatsapp_reminder_message TEXT,        -- Sent after timeout before closing
    fallback_behavior VARCHAR(50) DEFAULT 'take_message',  -- take_message, transfer, hangup
    fallback_transfer_number VARCHAR(50), -- Number to transfer to if fallback = transfer
    greeting_message TEXT,                -- First thing the agent says/sends
    goodbye_message TEXT,                 -- Last thing the agent says/sends
    cross_channel_summary BOOLEAN DEFAULT true,  -- Send WhatsApp summary after voice call
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Conversation Scripts (what data to collect)
CREATE TABLE script_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    step_order INT NOT NULL,
    label VARCHAR(255) NOT NULL,          -- Internal label: "event_type"
    prompt_text TEXT NOT NULL,             -- What the AI asks: "What type of event is this for?"
    data_type VARCHAR(50) NOT NULL,       -- text, number, date, datetime, email, phone, boolean, choice
    choices JSONB,                        -- For 'choice' type: ["wedding", "corporate", "portrait"]
    is_required BOOLEAN DEFAULT true,
    condition_step_id UUID REFERENCES script_steps(id),  -- Only ask if...
    condition_value VARCHAR(255),          -- ...this step's answer equals this value
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Phone Numbers
CREATE TABLE phone_numbers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    twilio_number VARCHAR(50) NOT NULL,
    twilio_number_sid VARCHAR(255),
    country_code VARCHAR(5),
    language VARCHAR(10) NOT NULL,        -- es, en, it, fr, de, pt...
    channels JSONB DEFAULT '["voice", "whatsapp"]',  -- Which channels this number handles
    label VARCHAR(255),                   -- "Spain Main", "US Sales"
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Conversations (voice calls + WhatsApp chats)
CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    agent_id UUID REFERENCES agents(id),
    phone_number_id UUID REFERENCES phone_numbers(id),
    linked_conversation_id UUID REFERENCES conversations(id),  -- Cross-channel link
    channel VARCHAR(20) NOT NULL,         -- voice, whatsapp
    twilio_call_sid VARCHAR(255),         -- Voice only
    direction VARCHAR(10) NOT NULL,       -- inbound, outbound
    remote_number VARCHAR(50),            -- The other party's number
    language VARCHAR(10),
    status VARCHAR(50) NOT NULL,          -- ringing, in-progress, completed, failed, no-answer, transferred, active, abandoned
    outcome VARCHAR(50),                  -- data_collected, partial, failed, transferred
    duration_seconds INT,                 -- Voice: call duration. WhatsApp: time from first to last message
    message_count INT DEFAULT 0,          -- WhatsApp: number of messages exchanged
    recording_url TEXT,                   -- Voice only
    recording_duration_seconds INT,       -- Voice only
    ai_confidence_score DECIMAL(3,2),     -- 0.00 to 1.00
    transcription TEXT,                   -- Voice: full transcription. WhatsApp: formatted chat log
    summary TEXT,                         -- AI-generated summary
    script_progress JSONB,               -- Current state: which steps completed, current step
    metadata JSONB,                       -- Any extra info
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    last_activity_at TIMESTAMPTZ,         -- WhatsApp: last message timestamp
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- WhatsApp Messages (individual messages within a WhatsApp conversation)
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    direction VARCHAR(10) NOT NULL,       -- inbound (from user), outbound (from agent)
    content TEXT NOT NULL,                -- Message text
    media_url TEXT,                       -- Attached media (image, PDF, etc.)
    media_type VARCHAR(50),               -- image/jpeg, application/pdf, etc.
    twilio_message_sid VARCHAR(255),
    status VARCHAR(50),                   -- sent, delivered, read, failed
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Collected Data (structured, per-question answers — same for both channels)
CREATE TABLE conversation_data (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    script_step_id UUID REFERENCES script_steps(id),
    label VARCHAR(255) NOT NULL,          -- Matches script_step.label
    value TEXT,                           -- The extracted answer
    data_type VARCHAR(50),
    confidence DECIMAL(3,2),              -- How confident the AI is in the extraction
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Outbound Campaigns (v1.1)
CREATE TABLE campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES agents(id),
    phone_number_id UUID REFERENCES phone_numbers(id),
    name VARCHAR(255) NOT NULL,
    channel VARCHAR(20) DEFAULT 'voice',  -- voice, whatsapp, whatsapp_then_voice
    whatsapp_template TEXT,               -- Initial template message for WhatsApp campaigns
    status VARCHAR(50) DEFAULT 'draft',   -- draft, active, paused, completed
    schedule_start TIME,
    schedule_end TIME,
    timezone VARCHAR(100),
    max_concurrent INT DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE campaign_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
    phone_number VARCHAR(50) NOT NULL,
    name VARCHAR(255),
    status VARCHAR(50) DEFAULT 'pending', -- pending, calling, completed, failed, callback
    call_id UUID REFERENCES conversations(id),    -- Link to actual conversation when made
    attempts INT DEFAULT 0,
    max_attempts INT DEFAULT 3,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- API Keys (for external module integration)
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    key_hash VARCHAR(255) NOT NULL,       -- Hashed API key
    key_prefix VARCHAR(10) NOT NULL,      -- First chars for identification: "agnt_k1_..."
    label VARCHAR(255),
    permissions JSONB DEFAULT '["read"]', -- read, write, calls, agents, admin
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Webhook Subscriptions (for external modules to receive events)
CREATE TABLE webhook_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    url VARCHAR(2048) NOT NULL,           -- Where to send events
    secret VARCHAR(255) NOT NULL,         -- For signature verification
    events JSONB NOT NULL,                -- ["call.completed", "call.started", "data.collected"]
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.6 Public API (for External Module Integration)

This is the key to modularity. Future modules (budgeting, freelancer coordination, contracts, payments) connect through this API. External systems, Zapier, Make, or custom code can also use it.

#### Authentication
```
Authorization: Bearer agnt_k1_xxxxxxxxxxxxxxxx
```

#### Endpoints

**Agents**
```
GET    /api/v1/agents                    List all agents
GET    /api/v1/agents/:id                Get agent details + script
POST   /api/v1/agents                    Create agent
PUT    /api/v1/agents/:id                Update agent
DELETE /api/v1/agents/:id                Delete agent
GET    /api/v1/agents/:id/script         Get conversation script
PUT    /api/v1/agents/:id/script         Update conversation script
```

**Conversations**
```
GET    /api/v1/conversations                     List conversations (filterable)
GET    /api/v1/conversations/:id                 Get detail + transcription/chat + data
GET    /api/v1/conversations/:id/recording       Get recording URL (voice only)
GET    /api/v1/conversations/:id/messages        Get WhatsApp messages (WhatsApp only)
GET    /api/v1/conversations/:id/data            Get structured data collected
POST   /api/v1/conversations/outbound            Trigger outbound (voice call or WhatsApp)
```

**Query Parameters for GET /api/v1/conversations**
```
?agent_id=xxx           Filter by agent
?channel=voice          Filter by channel (voice, whatsapp)
?direction=inbound      Filter by direction
?status=completed       Filter by status
?from=2025-01-01        Date range start
?to=2025-01-31          Date range end
?phone=+34612...        Filter by remote number
?limit=50&offset=0      Pagination
```

**Phone Numbers**
```
GET    /api/v1/numbers                   List numbers
POST   /api/v1/numbers                   Add number
PUT    /api/v1/numbers/:id               Update (assign agent, language)
DELETE /api/v1/numbers/:id               Remove number
```

**Campaigns (v1.1)**
```
GET    /api/v1/campaigns                 List campaigns
POST   /api/v1/campaigns                 Create campaign
PUT    /api/v1/campaigns/:id             Update campaign
POST   /api/v1/campaigns/:id/start       Start campaign
POST   /api/v1/campaigns/:id/pause       Pause campaign
GET    /api/v1/campaigns/:id/contacts    Get contact list + status
```

**Webhooks (Event Subscriptions)**
```
POST   /api/v1/webhooks                  Subscribe to events
GET    /api/v1/webhooks                  List subscriptions
DELETE /api/v1/webhooks/:id              Unsubscribe
```

**Webhook Events Emitted**
```json
{
    "event": "conversation.completed",
    "timestamp": "2025-03-15T14:30:00Z",
    "data": {
        "conversation_id": "uuid",
        "agent_id": "uuid",
        "channel": "voice",
        "direction": "inbound",
        "remote_number": "+34612345678",
        "duration_seconds": 180,
        "outcome": "data_collected",
        "collected_data": {
            "event_type": "wedding",
            "date": "2025-06-15",
            "location": "Madrid",
            "hours": 4,
            "email": "client@example.com"
        },
        "summary": "Client requesting wedding photographer for June 15th in Madrid, 4 hours coverage.",
        "transcription_url": "/api/v1/conversations/uuid/transcription"
    }
}
```

This webhook system is how future modules plug in:
- **Budgeting module** subscribes to `conversation.completed` → receives collected data → generates quote
- **Coordinator module** subscribes to `quote.accepted` → triggers outbound calls/WhatsApp to freelancers
- **Contract module** subscribes to `freelancer.confirmed` → sends DocuSign
- **Payment module** subscribes to `contract.signed` → charges via Stripe

Each module is independent. Each module only needs the API.

---

## 4. Tech Stack

| Component | Technology | Reason |
|-----------|-----------|--------|
| Frontend | React SPA in single HTML, Babel inline | Zero build step; fits the MVP. Migrate to a build pipeline once the SPA outgrows ~600 lines. |
| Backend | Node.js + Express | Same language as frontend, native Twilio SDK |
| Database | SQLite (dev) / PostgreSQL (prod) | SQLite for zero-setup demo; switch `provider` and `DATABASE_URL` for production |
| ORM | Prisma 5 | Type-safe, easy migrations |
| Auth | JWT + bcrypt | Simple, stateless |
| Voice calls | Twilio Voice API + Media Streams | Industry standard, real-time WebSocket audio |
| Speech-to-Text | Deepgram (streaming) | Sub-300ms transcription, supports mulaw 8kHz natively |
| Text-to-Speech | ElevenLabs (streaming, ulaw_8000) | Best AI voice quality, native Twilio output format |
| LLM Gateway | OpenRouter API | Unified access to ~10 models (Claude, GPT, Gemini, DeepSeek, Mistral, Grok) via single OpenAI-compatible API |
| Real-time | `ws` (Node WebSocket lib) | For Twilio Media Streams |
| Pricing engine | `expr-eval` | Sandboxed expression parser, deterministic, 5ms per quote, no LLM at runtime |
| Webhook signature | Twilio SDK `validateRequest` | Mandatory in prod (env: `SKIP_TWILIO_SIGNATURE=false`) |
| File storage | Local filesystem (dev). Object store (R2 / B2) recommended for production | |

**What's deliberately NOT in the stack**:
- No Next.js / no separate frontend build process. The dashboard is a
  single HTML with inline Babel.
- No Bull / Redis / queues. There's no outbound campaign engine yet, and
  the inbound flow is fully synchronous.
- No microservices. One Node process behind nginx.

---

## 5. Environment Variables

```env
# App
NODE_ENV=production
PORT=3000
APP_URL=https://agent.tudominio.com   # used for generating Twilio webhook URLs in prod
JWT_SECRET=<32-byte random hex>

# Database (SQLite for demo, switch to Postgres for prod)
DATABASE_URL=postgresql://agentai:password@localhost:5432/agentai
# or for dev: DATABASE_URL="file:./dev.db"

# Twilio (platform defaults — users can override per-tenant when multi-tenant is enabled)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_WHATSAPP_FROM=+14155238886    # sandbox default; replace with your approved sender
SKIP_TWILIO_SIGNATURE=false           # NEVER true in production

# ElevenLabs (voice TTS)
ELEVENLABS_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Deepgram (voice STT)
DEEPGRAM_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# OpenRouter (LLM gateway — single key for all models)
OPENROUTER_API_KEY=sk-or-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OPENROUTER_DEFAULT_MODEL=openai/gpt-4o-mini   # default for new agents

# Ngrok (development only)
NGROK_URL=https://xxxx.ngrok-free.app
```


---

## 6. Project Structure (as built)

```
agentai/
├── README.md                          User-facing overview, quick start
├── DEPLOYMENT.md                      Production VPS guide
├── ARCHITECTURE.md                    This document
├── CLAUDE.md                          Implementation reference for contributors
├── CHANGES.md                         First fix pass changelog
├── CHANGES_MVP.md                     Pricing + handoff changelog
├── package.json
├── .env.example
├── prisma/
│   └── schema.prisma                  Single schema (User, Agent, ScriptStep,
│                                      PhoneNumber, Conversation, Message,
│                                      ConversationData, ApiKey)
├── public/
│   └── index.html                     React SPA, Babel inline. No build step.
│                                      Includes the 7 agent config tabs:
│                                      Personality / Presentation / AI Disclosure /
│                                      Script / Pricing / Closing / Output
├── scripts/
│   └── seed.js                        Demo user + photography receptionist agent
└── src/
    ├── server.js                      Express + WebSocket entry
    ├── middleware/
    │   ├── auth.js                    JWT verification
    │   └── twilio-signature.js        X-Twilio-Signature validator
    ├── routes/
    │   ├── auth.routes.js             register, login, /me
    │   ├── agents.routes.js           CRUD + role + salesAgentId + handoffMessage
    │   ├── scripts.routes.js          Script step CRUD + atomic reorder
    │   ├── numbers.routes.js          Phone number CRUD (ownership-checked)
    │   ├── conversations.routes.js    List + detail (read from dashboard)
    │   ├── settings.routes.js         User preferences + per-tenant API keys
    │   ├── pricing.routes.js          Variables + formula CRUD + test calculator
    │   ├── webhooks.voice.routes.js   Twilio voice inbound + status callback
    │   ├── webhooks.whatsapp.routes.js Twilio WhatsApp inbound
    │   └── v1/
    │       └── output.v1.js           Public API for external modules
    ├── services/
    │   ├── llm.service.js             OpenRouter client + prompt builder
    │   │                              (takes optional salesContext for handoff)
    │   ├── conversation.service.js    State engine for WhatsApp + voice fallback,
    │   │                              including handoff handling
    │   ├── voice.stream.service.js    Twilio Media Streams handler with
    │   │                              mid-call voice/prompt swap on handoff
    │   ├── tts.service.js             ElevenLabs streaming + non-streaming TTS
    │   ├── stt.service.js             Deepgram streaming WebSocket
    │   ├── latency.service.js         Filler phrases + lazy ulaw audio cache
    │   ├── pricing.service.js         expr-eval based formula evaluator
    │   └── output.service.js          webhook + email + WhatsApp + dashboard
    └── utils/
        └── logger.js                  Winston, console transport only
```

**What's NOT in the tree** (and why):

- No `frontend/` directory — the SPA lives in `public/index.html`. When
  it outgrows ~600 lines, migrating to Vite + a build pipeline is
  straightforward.
- No `workers/` directory — no queues, no Redis, no campaign processor.
  Inbound-only flow is fully synchronous.
- No `models/` directory — Prisma generates the client; we use it
  directly without wrapper models.
- No separate `config/` directory — config is in `.env` and parsed
  inline where it's used. The codebase is small enough that indirection
  hurts more than it helps.


---

## 7. Implementation Priority

### Phase 1: Core (MVP)
1. Database setup + Prisma schema + migrations
2. Auth (register, login, JWT)
3. Agent CRUD (create, edit, delete agents with channel config)
4. Script builder (add/edit/reorder questions per agent)
5. Phone number assignment (manual Twilio number entry + agent/language/channel binding)
6. Inbound voice call handler (Twilio webhook → STT → LLM → TTS → response)
7. Inbound WhatsApp handler (Twilio webhook → LLM → text reply)
8. Conversation logging (save transcription/chat, recording, extracted data)
9. Dashboard (conversation list, conversation detail, agent list)

### Phase 2: Polish
10. Voice preview (test agent voice from dashboard)
11. Conversation data export (CSV/JSON)
12. AI summary generation per conversation
13. Confidence scoring
14. Conditional script logic (if/then questions)
15. Cross-channel: send WhatsApp summary after voice call
16. WhatsApp rich messages: buttons, lists, media attachments

### Phase 3: Expand
17. Public API v1 (full REST API with API key auth)
18. Webhook subscriptions (event system for external modules)
19. Outbound single conversation (trigger a voice call or WhatsApp from dashboard or API)
20. Outbound campaigns (batch calling/messaging with scheduling)

---

## 8. Key Technical Decisions

### Voice Latency & Latency Masking Engine
The biggest challenge is keeping perceived response time under 500ms. Humans perceive conversation as natural when the gap between turns is 200-500ms. Above 800ms they notice. Above 1500ms it feels broken.

The raw pipeline (STT → LLM → TTS) will always take 800-1500ms. The solution is NOT to make it faster — it's to **mask the latency** so the user never perceives it. This costs zero extra — it's architecture, not a service.

#### Layer 1: Filler Words (0ms perceived latency)
The LLM prompt includes an instruction to start every response with a natural filler word or acknowledgment: "Mmm", "Veamos", "Claro", "Entendido", "Perfecto". These single words convert to audio in milliseconds and play instantly while the real response is still generating. The user hears immediate acknowledgment instead of silence.

#### Layer 2: Speculative Parallel Processing
When the user finishes speaking, two tracks fire simultaneously:
- **Track A (Filler)**: Immediate conversational acknowledgment sent to TTS ("Déjame comprobar eso...")
- **Track B (Real)**: Full LLM processing + data extraction happening in background

Track A buys 1.5-2 seconds. By the time the filler audio finishes, Track B has the real answer ready. The user hears continuous speech with zero dead air.

#### Layer 3: Full Streaming Pipeline
- **STT streaming**: Deepgram sends partial transcripts while the user is still speaking. The LLM starts reasoning on the first clause, not the last.
- **LLM streaming**: OpenRouter streams tokens as they generate. First tokens go to TTS immediately.
- **TTS streaming**: ElevenLabs starts generating audio from the first tokens. User hears the beginning of the response while the end is still being generated.

#### Layer 4: Caching Common Phrases
Greetings, confirmations, and common transitions are pre-generated and cached as audio. "Hola, gracias por llamar", "Un momento", "Perfecto, lo tengo" — these play from cache with zero latency.

#### Implementation in Voice Call Flow
```
User finishes speaking
        │
        ├──→ [INSTANT] Play cached acknowledgment or LLM filler word
        │
        ├──→ [PARALLEL] STT finalizes → LLM processes with script context
        │                                      │
        │                                      ├──→ [STREAM] First LLM tokens → ElevenLabs TTS
        │                                      │
        │                                      ├──→ [STREAM] Audio chunks → Twilio → User hears response
        │
        └──→ Total perceived latency: < 500ms (user hears filler + seamless continuation)
```

#### Infrastructure optimizations
- Use Twilio Media Streams for real-time bidirectional audio
- Use Deepgram for faster STT (150ms time-to-first-token)
- Use ElevenLabs streaming TTS (audio starts before full text is ready)
- Default to fast models via OpenRouter: openai/gpt-5-nano or openai/gpt-4o-mini for lowest latency
- Keep conversation history compact — summarize older turns if context grows
- OpenRouter's automatic failover ensures if one provider is slow, it routes to another

### Script Engine
The LLM receives the full script context on each turn:
```
System: {agent.system_prompt}

You are conducting a phone call. Follow this script to collect information:

Step 1 (event_type): Ask what type of event. Options: wedding, corporate, portrait, product, other.
Step 2 (date): Ask for the date of the event.
Step 3 (location): Ask where the event will take place.
Step 4 (duration): Ask how many hours of coverage they need.
Step 5 (email): Ask for their email to send the quote.

Current progress:
- event_type: "wedding" ✓
- date: [not yet collected]
- location: [not yet collected]

Conversation so far:
Agent: Hi! Thank you for calling. How can I help you today?
Caller: I need a photographer for my wedding.
Agent: Congratulations! I'd love to help. When is the wedding?
Caller: ...

Instructions:
- Be natural and conversational, not robotic
- Extract data from natural conversation, don't interrogate
- If the caller provides multiple answers at once, acknowledge all of them
- Respond ONLY with what to say next + a JSON block with any new data extracted
```

### Module Communication
Future modules connect via:
1. **REST API** — Pull data anytime (GET /api/v1/conversations)
2. **Webhooks** — Push events in real-time (conversation.completed → module processes it)
3. **Outbound trigger** — Modules can trigger calls or WhatsApp messages (POST /api/v1/conversations/outbound) with custom script parameters

This means the budgeting module doesn't live inside AgentAi. It's a separate service that:
- Listens for `conversation.completed` webhooks
- Reads collected data
- Generates a quote
- (Optionally) triggers a callback or WhatsApp message via POST /api/v1/conversations/outbound

---

## 9. Security Considerations

- All API keys and credentials encrypted at rest (AES-256)
- Twilio webhook signature validation on all incoming webhooks
- Rate limiting on all API endpoints
- API keys are hashed (bcrypt), only prefix stored readable
- JWT tokens expire after 24h, refresh token rotation
- CORS configured per environment
- Call recordings encrypted and access-controlled

---

## 10. Scaling Notes (Post-MVP)

These are not built — they are paths to follow when traffic justifies them.

- **Managed PostgreSQL** (Supabase, Neon, RDS) instead of localhost
  Postgres on the VPS, once you can't lose the database to a single VPS
  failure.
- **Object storage** (Cloudflare R2 or Backblaze B2) for call recordings
  and any other binary blobs. Migration is just changing where the path
  in `Conversation.recordingUrl` points.
- **Redis + Bull** if and when you add **outbound** capabilities
  (campaigns, scheduled callbacks, retry logic). Inbound-only doesn't
  need queues.
- **WebSocket clustering** (sticky sessions or Twilio Media Stream
  affinity) when you need more than one Node process. Each Media Stream
  ties to a single process for the lifetime of the call, so horizontal
  scaling means routing inbound calls to the right node.
- **Frontend build pipeline** (Vite, Next.js, or just esbuild) once
  `public/index.html` exceeds ~600 lines or you need a real component
  library.
- **Multi-region Twilio numbers** for lower latency when serving
  callers across continents.
- **Encrypted secrets at rest** (libsodium, KMS-backed) when going
  multi-tenant SaaS — the `User` table currently stores per-user API
  keys in plaintext.

---

## 11. Pricing Engine and Sales Handoff (MVP addition)

The MVP extends the captador → backend → comercial flow to happen
**inside a single call** without the customer hanging up. This section
documents the design.

### 11.1 Pricing Engine

A configurable, deterministic calculator that the captador agent uses
when its intake script completes.

**Configuration (per agent)**:
- Up to **15 variables**, each with: `label`, `type` (text / number /
  boolean / choice), optional `choices` (for choice type), `required`
- A single **formula** in standard math expression syntax, referencing
  the variable labels

**Engine**: `expr-eval` (npm package, ~50 KB). Parses and evaluates math
expressions in a sandboxed parser with no access to filesystem, network,
or any host objects. Configured to disable assignment, string
concatenation, and the `in` operator. Available operators:
- Arithmetic: `+ - * / % ^`
- Comparison: `== != > < >= <=`
- Conditional: `cond ? a : b`
- Logical: `and or not`
- Built-ins: `min, max, abs, round, floor, ceil, pow, sqrt`

**Choice variables** auto-expose a `<label>_idx` companion (zero-based
index in the choices array) so users can dispatch arithmetically:
```
event_type_idx == 0 ? 1200 : (event_type_idx == 1 ? 350 : 280)
```

**Performance**: ~5ms per calculation. No LLM involvement at runtime.
Fully deterministic: same inputs always yield the same output.

**Validation**: every Save through the dashboard validates the formula
parses, references only declared variables, and (when test inputs are
provided) evaluates to a finite number. Saves with broken configs are
rejected so the agent can never reach a state that crashes at handoff.

**Endpoints** (`src/routes/pricing.routes.js`):
```
GET  /api/pricing/:agentId                     Read config
PUT  /api/pricing/:agentId                     Save config (validated)
POST /api/pricing/:agentId/test                Test with sample inputs
POST /api/pricing/:agentId/calculate-for-conversation
                                                Internal: trigger calc
                                                from completed intake
```

### 11.2 Sales Handoff

Lets a captador agent hand off the same call to a sales agent that
communicates the calculated proposal and captures the customer's decision.

**Configuration on the captador agent**:
- `salesAgentId` — points to a separate agent owned by the same user
- `handoffMessage` — the bridge phrase the captador speaks before
  passing the call (e.g. "Te paso con Marta del comercial...")

The sales agent itself is a normal agent: same 6 + 1 configuration tabs,
its own voice, its own LLM model, its own script (typically a single
`decision` field of choice type).

### 11.3 Flow on a voice call (Media Streams path)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Twilio call connects → /api/webhooks/voice/incoming                  │
│ Conversation created with currentRole=intake                         │
│ TwiML: <Connect><Stream> opens WebSocket                             │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ voice.stream.service.handleMediaStream()                             │
│   loads intakeAgent + salesAgent (if linked)                         │
│   starts Deepgram STT WebSocket                                      │
│   active agent = intakeAgent, voice = intakeAgent.voiceId            │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                        intake turns
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ LLM returns script_complete=true                                     │
│ Check: salesAgent exists && pricing configured?                      │
│   YES → handoffToSales()                                             │
│   NO  → normal completion                                            │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ handoffToSales()                                                     │
│   1. pricing.calculate(intakeAgent, collectedProgress)               │
│      → { amount, currency, inputs }     [~5ms]                       │
│   2. Persist Conversation:                                           │
│        currentRole=sales                                             │
│        calculatedTotal=<amount>                                      │
│        salesAgentId=<id>                                             │
│   3. tts.streamToTwilio(handoffMessage, intakeVoiceId)               │
│      → caller hears "te paso con Marta..." in intake voice           │
│   4. Swap state:                                                     │
│        agent = salesAgent                                            │
│        voiceId = salesAgent.voiceId                                  │
│        scriptSteps = salesAgent's scripts                            │
│        salesContext = { calculatedTotal, currency, intakeData,       │
│                         intakeAgentName }                            │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                       sales turns
                  (same WebSocket, new voice)
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Each sales turn:                                                     │
│   buildPrompt(salesAgent, ..., salesContext)                         │
│      → prompt instructs the agent to communicate the total,          │
│        not to recollect data, to capture the decision                │
│   tts.streamToTwilio(say, salesVoiceId)                              │
│      → caller hears Marta's voice                                    │
│ Until sales script_complete (decision captured)                      │
│   → status=completed, output.notifyConversationComplete fans out     │
└──────────────────────────────────────────────────────────────────────┘
```

Key properties:
- **One WebSocket from start to finish**. The customer's call doesn't
  drop, doesn't transfer, doesn't pause beyond the natural silence
  between voices. Twilio sees a single Media Stream session.
- **Voice changes mid-stream** by virtue of the next ElevenLabs request
  using a different `voiceId`. ElevenLabs supports this without any
  reconnection ceremony.
- **Pricing runs synchronously before the bridge phrase**. The 5ms
  calculation finishes long before the bridge audio reaches the caller,
  so by the time the customer hears "te paso con Marta", the total is
  already in `salesContext` waiting for the sales agent's first turn.

### 11.4 Flow on WhatsApp and the voice fallback

These channels are turn-based (each turn is a separate HTTP request) so
the in-stream voice swap doesn't apply. Instead, on the turn that ends
the intake:

1. Pricing is calculated as above
2. `Conversation.currentRole` is set to `sales`
3. **A second LLM call is made immediately** with the sales agent's
   prompt + handoff context, to generate its opening message
4. The reply returned to the channel handler is the intake's closing +
   the sales agent's opening, joined with `\n\n`

For WhatsApp this is delivered as one message that contains both pieces.
For the voice Gather fallback it's spoken as one Say with the combined
text. Subsequent turns use the sales agent normally.

### 11.5 Why handoff fails gracefully

If pricing calculation fails (formula error, missing required variable,
non-finite result), the system logs the error and falls through to
**normal completion** — the intake agent's closing message is sent,
output notifications fire as if there were no handoff, and the
conversation ends. The customer never experiences a broken state.

If the LLM call for the sales opening fails (network error, rate limit),
the system falls back to the intake's `handoffMessage` alone. Less
ideal but still coherent.

### 11.6 Data persistence after handoff

A conversation that handed off has:
- `currentRole = 'completed'` once it ends
- `calculatedTotal` — the number the formula returned
- `salesAgentId` — which sales agent took it (may differ from the
  current `Agent.salesAgentId` if the captador's link was changed
  later; conversations record their own history)
- `collectedData[]` — the intake data only
- `scriptProgress` JSON — the sales decision data
- `messages[]` — all messages from both phases, in order

The `output.service.notifyConversationComplete()` payload includes
`calculated_total` so downstream modules (your contracts/payments
backend) receive it without a separate API call.

---
