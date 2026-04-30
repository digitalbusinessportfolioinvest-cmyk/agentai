# Deploy AgentAi on [Railway](https://railway.com)

One Node service + managed PostgreSQL. Twilio webhooks use your **public HTTPS URL** (no ngrok in production).

## 1. Create the project

1. [Railway Dashboard](https://railway.app) → **New Project** → **Deploy from GitHub repo** → select `digitalbusinessportfolioinvest-cmyk/agentai`.
2. Railway builds with **Nixpacks** (`railway.toml`). Install runs `postinstall` → `prisma generate`.
3. **Deploy** runs `npm start` → `prisma migrate deploy` then `node src/server.js`.

## 2. Add PostgreSQL

1. In the project → **New** → **Database** → **PostgreSQL**.
2. Open the **Postgres** service → **Variables** → copy **`DATABASE_URL`** (or use **Connect** → **Add to Service** on your **AgentAi** service so `DATABASE_URL` is injected automatically).

## 3. Public URL (Twilio + CORS + TwiML)

1. Open your **web** service (the AgentAi service) → **Settings** → **Networking** → **Generate Domain** (e.g. `agentai-production.up.railway.app`).
2. Set **`APP_URL`** to exactly:

   `https://YOUR_PUBLIC_DOMAIN`

   Example: `https://agentai-production.up.railway.app`  
   (no trailing slash)

3. **Do not set `NGROK_URL` in production** unless you still tunnel; **`APP_URL`** is enough for signature validation and TwiML callback URLs.

## 4. Environment variables (copy into Railway → Service → Variables)

| Variable | Required | Example / notes |
|----------|----------|-------------------|
| `NODE_ENV` | Yes | `production` |
| `PORT` | No | Railway sets this automatically; app reads `process.env.PORT`. |
| `APP_URL` | Yes | `https://<your-railway-domain>` — must match the URL Twilio calls. |
| `DATABASE_URL` | Yes | From Railway PostgreSQL (reference variable or paste). |
| `JWT_SECRET` | Yes | Long random string (≥32 chars). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `TWILIO_ACCOUNT_SID` | Yes | `AC…` |
| `TWILIO_AUTH_TOKEN` | Yes | Auth token for the same Twilio account. |
| `TWILIO_WHATSAPP_FROM` | For WhatsApp | E.164 WhatsApp sender, e.g. `+14155238886` (sandbox) or your approved sender. |
| `SKIP_TWILIO_SIGNATURE` | Yes | **Unset** or `false` in production so webhooks are validated. |
| `OPENROUTER_API_KEY` | Yes | `sk-or-v1-…` |
| `OPENROUTER_DEFAULT_MODEL` | No | Default `openai/gpt-4o-mini` if omitted. |
| `ELEVENLABS_API_KEY` | For best voice | `sk_…` — without it + without Deepgram, voice uses Gather/Say fallback. |
| `DEEPGRAM_API_KEY` | For best voice | Needed with ElevenLabs for Media Streams. |
| `PRISMA_QUERY_LOG` | No | Set `false` to reduce SQL logs in production. |

### Twilio Console (after the app is live)

- **Voice** → *A call comes in* → Webhook **POST**  
  `https://YOUR_PUBLIC_DOMAIN/api/webhooks/voice/incoming`
- **Voice** → *Call status changes* →  
  `https://YOUR_PUBLIC_DOMAIN/api/webhooks/voice/status`
- **WhatsApp** (or Messaging) → inbound → **POST**  
  `https://YOUR_PUBLIC_DOMAIN/api/webhooks/whatsapp/incoming`

Use the **same** `https://…` host as **`APP_URL`**.

## 5. First-time database content

Migrations run on every deploy via `npm start`. To create the demo user once:

```bash
# From your laptop, with Railway CLI linked and DATABASE_URL set, or:
railway run --service <agentai-service-name> npm run db:seed
```

Or run `npm run db:seed` locally with `DATABASE_URL` pointed at the Railway Postgres (temporary allowlist IP if required).

## 6. Verify

- Open `https://YOUR_PUBLIC_DOMAIN/api/health` → JSON `success: true`.
- Open `https://YOUR_PUBLIC_DOMAIN/` → dashboard login.
- Place a test call / WhatsApp and watch **Railway → Deployments → View logs**.

## 7. Troubleshooting

| Symptom | Check |
|---------|--------|
| Build fails on Prisma | `prisma` is in **dependencies**; `postinstall` runs `prisma generate`. |
| Boot fails on migrate | `DATABASE_URL` correct; Postgres reachable; migrations committed in `prisma/migrations/`. |
| Twilio 403 / “Signature invalid” | `APP_URL` exactly matches public URL; `TWILIO_AUTH_TOKEN` correct; `SKIP_TWILIO_SIGNATURE` not `true`. |
| “Server misconfigured” on voice | `APP_URL` (or `NGROK_URL`) set. |
| No LLM replies | `OPENROUTER_API_KEY` set; credits on OpenRouter. |
