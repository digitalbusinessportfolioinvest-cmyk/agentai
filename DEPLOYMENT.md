# AgentAi — Deployment Guide

End-to-end guide to run AgentAi 24/7 on a VPS. Replaces the previous
`DEPLOYMENT.pdf` which described localhost + ngrok (fine for testing,
useless for production: when your laptop sleeps, calls drop).

This guide assumes a fresh **Ubuntu 24 LTS VPS** with root access and a
domain you control. Tested on Hetzner CX22 (5€/mes, Falkenstein DC1).
Works the same on DigitalOcean, Vultr, Scaleway, or any other Linux VPS.

---

## What you need before starting

### Infrastructure (~10 min, ~5€/mes)

- **VPS**: Ubuntu 24, ≥2 GB RAM, ≥20 GB disk. Hetzner CX22 sobra.
- **Domain**: any TLD pointing to the VPS. `agent.tudominio.com` works
  fine; doesn't need to be a top-level domain.
- **Email** for Let's Encrypt notifications.

### API accounts (~45 min, ~25€ initial)

| Service | What you need | Cost | Setup time |
|---------|--------------|------|------------|
| Twilio | Account SID, Auth Token, 1 phone number | ~$20 credit + $1/mo per number | 15 min |
| OpenRouter | API Key | $5 credit to start | 5 min |
| ElevenLabs | API Key | Free tier (10 min/mo voice) | 5 min |
| Deepgram | API Key | Free tier ($200 credit) | 5 min |

Minimum to test inbound WhatsApp only: Twilio + OpenRouter (~$25).
For voice with natural sound: add ElevenLabs + Deepgram (free tiers).

---

## Step 1 — Provision the VPS

After creating the VPS, SSH in as root and run the hardening basics:

```bash
# Update system
apt update && apt upgrade -y

# Create a non-root user
adduser agentai
usermod -aG sudo agentai

# Install your SSH key for the new user
mkdir -p /home/agentai/.ssh
cp ~/.ssh/authorized_keys /home/agentai/.ssh/
chown -R agentai:agentai /home/agentai/.ssh
chmod 700 /home/agentai/.ssh
chmod 600 /home/agentai/.ssh/authorized_keys

# Disable root SSH and password auth
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# Firewall
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable

# fail2ban for brute-force SSH protection
apt install -y fail2ban
systemctl enable --now fail2ban
```

From here on, log out as root and log in as `agentai`. All remaining
commands assume that user (`sudo` when root is needed).

---

## Step 2 — Install dependencies

```bash
# Node 20 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PostgreSQL 16
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql

# nginx + certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# Build tools (some npm packages compile native modules)
sudo apt install -y build-essential
```

Verify:

```bash
node --version    # should be v20.x
npm --version
psql --version    # 16.x
nginx -v
```

---

## Step 3 — Create the database

```bash
sudo -u postgres psql <<EOF
CREATE USER agentai WITH PASSWORD 'PUT_A_STRONG_PASSWORD_HERE';
CREATE DATABASE agentai OWNER agentai;
GRANT ALL PRIVILEGES ON DATABASE agentai TO agentai;
EOF
```

Save that password — you'll need it for `.env` in step 5.

---

## Step 4 — Deploy the code

Either `git clone` or `scp` the project tar into `/home/agentai/agentai`:

```bash
# Option A: from a private git repo
cd ~
git clone git@github.com:YOU/agentai.git
cd agentai

# Option B: from your local machine, scp the tarball
# (run on your laptop)
scp agentai-mvp.tar agentai@your.vps.ip:~/
# (back on the VPS)
cd ~ && tar -xf agentai-mvp.tar && cd agentai
```

Install dependencies:

```bash
npm install
```

---

## Step 5 — Configure for Postgres

Edit `prisma/schema.prisma` and change the datasource block:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Create `.env` from the example:

```bash
cp .env.example .env
nano .env
```

Fill in **all** the values:

```ini
NODE_ENV=production
PORT=3000
APP_URL=https://agent.tudominio.com
JWT_SECRET=run-`openssl rand -hex 32`-and-paste-result-here

DATABASE_URL=postgresql://agentai:YOUR_STRONG_PASSWORD@localhost:5432/agentai

TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_WHATSAPP_FROM=+14155238886    # sandbox; replace with your sender once approved
SKIP_TWILIO_SIGNATURE=false           # NEVER set to true in production

ELEVENLABS_API_KEY=your_elevenlabs_key
OPENROUTER_API_KEY=sk-or-your_openrouter_key
OPENROUTER_DEFAULT_MODEL=openai/gpt-4o-mini
DEEPGRAM_API_KEY=your_deepgram_key

# In production this is your real domain (used to generate Twilio webhook URLs).
# Leave NGROK_URL empty here; the code prefers APP_URL.
```

Generate a strong JWT secret:

```bash
openssl rand -hex 32
```

Run database migrations and seed:

```bash
npx prisma migrate deploy
node scripts/seed.js
```

Test that the server boots:

```bash
npm start
# In another terminal: curl http://localhost:3000/api/health
# Should return: {"success":true,"data":{"status":"ok",...}}
# Stop with Ctrl+C
```

---

## Step 6 — Run as a systemd service

Create the unit file:

```bash
sudo nano /etc/systemd/system/agentai.service
```

Paste:

```ini
[Unit]
Description=AgentAi Voice & WhatsApp Platform
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=agentai
WorkingDirectory=/home/agentai/agentai
EnvironmentFile=/home/agentai/agentai/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=agentai

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/agentai/agentai

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agentai
sudo systemctl status agentai

# Logs:
sudo journalctl -u agentai -f
```

If status shows `active (running)`, the server is up.

---

## Step 7 — nginx reverse proxy with WebSockets

This is the step where most people trip. Twilio Media Streams (live voice)
go over a WebSocket on `/api/webhooks/voice/media-stream`. nginx must be
configured to upgrade those connections explicitly, or voice calls will
silently fail with no error.

Create the site config:

```bash
sudo nano /etc/nginx/sites-available/agentai
```

Paste:

```nginx
server {
    listen 80;
    server_name agent.tudominio.com;
    # certbot will rewrite this block to add SSL — leave it for now
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name agent.tudominio.com;

    # certbot fills these in:
    # ssl_certificate /etc/letsencrypt/live/agent.tudominio.com/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/agent.tudominio.com/privkey.pem;

    # Generous timeouts because phone calls can be long
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    # Body size: leave headroom for Twilio multipart payloads
    client_max_body_size 25M;

    # Standard HTTP traffic (dashboard, REST API, Twilio HTTP webhooks)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Twilio Media Streams WebSocket — MUST upgrade Connection
    location /api/webhooks/voice/media-stream {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Enable and test:

```bash
sudo ln -s /etc/nginx/sites-available/agentai /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Get the SSL certificate (certbot will edit the config to add the
`ssl_certificate` lines):

```bash
sudo certbot --nginx -d agent.tudominio.com --email tu@email.com --agree-tos --no-eff-email
```

Renewal is automatic via the certbot timer that ships with the package.
Check it:

```bash
sudo systemctl list-timers | grep certbot
```

Now visit `https://agent.tudominio.com` in a browser. You should see the
AgentAi login screen.

---

## Step 8 — Configure Twilio webhooks

In the Twilio Console:

### For voice calls

1. Phone Numbers → Manage → Active Numbers → click your number
2. **Voice Configuration**:
   - "When a call comes in": Webhook
   - URL: `https://agent.tudominio.com/api/webhooks/voice/incoming`
   - HTTP method: `POST`
3. **Status callback** (so duration and outcome are recorded):
   - URL: `https://agent.tudominio.com/api/webhooks/voice/status`
   - Method: `POST`
   - Events: select `completed` at minimum
4. Save

### For WhatsApp (sandbox first, real sender later)

1. Messaging → Try it out → Send a WhatsApp message
2. Follow the sandbox setup (your phone must send the join code once)
3. Once joined: Messaging → Settings → WhatsApp Sandbox Settings
4. "When a message comes in":
   - URL: `https://agent.tudominio.com/api/webhooks/whatsapp/incoming`
   - Method: `POST`
5. Save

For a real (non-sandbox) WhatsApp sender you need Facebook Business
Manager verification and approved templates — start that process in
parallel; approval can take 1–14 days.

---

## Step 9 — Add your number in the dashboard

1. Open `https://agent.tudominio.com`
2. Login with `demo@agentai.local` / `demo1234`
   (delete this account or change the password as your first action — see
   the "Production hardening" section below)
3. Go to **Numbers** → **+ Add Number**
4. Fill in:
   - Twilio number (e.g. `+34612345678`)
   - Language (assigns the language for the AI on this number)
   - Agent: select the seeded "Photography Receptionist" or any agent
     you've created
   - Label: anything for your own reference
5. Add

---

## Step 10 — Test end-to-end

### WhatsApp test

Send any message to the Twilio sandbox number (the one you joined). The
agent should reply. Check the **Conversations** tab in the dashboard;
your message and the AI response should appear there in real time.

### Voice test

Call your Twilio number from any phone. The agent should pick up and
greet you. If you configured ElevenLabs + Deepgram in `.env`, you'll hear
a natural ElevenLabs voice with sub-second response times. If not, you
get the Twilio default Google TTS voice with 2–3 second pauses (still
works, just less natural).

If the call hangs up immediately:

```bash
sudo journalctl -u agentai -n 100 --no-pager
```

Look for errors. Common causes:

- `APP_URL` not set or pointing at localhost (Twilio webhooks generate
  `wss://` URLs from this — must be your real domain)
- `SKIP_TWILIO_SIGNATURE=true` left from testing (the prod path requires
  signed requests)
- nginx not upgrading the WebSocket on `/api/webhooks/voice/media-stream`
  (revisit step 7)

---

## Step 11 — Configure pricing and sales handoff (for the full flow)

This is what makes a call go captador → presupuesto → comercial in one
continuous conversation.

### Create the comercial agent

1. **Agents** → **+ New Agent**
2. Personality: e.g. "Marta, comercial. Cálida, clara, recoge la decisión
   sin presionar"
3. Voice: pick a different ElevenLabs voice ID from the captador (so the
   handoff is audibly distinct)
4. Channels: voice + whatsapp (matching the captador)
5. Greeting: leave the default — at handoff time the system rebuilds it
   with the proposal context
6. Script: add a single field `decision` of type `choice` with options
   `accept, modify, think, reject`. This is what Marta captures
7. Closing: write the goodbye for after the decision is captured
8. Save

### Configure pricing on the captador

Open the captador agent (e.g. "Photography Receptionist") → **💰 Pricing**.

1. Add variables (max 15). For photography example:
   - `event_type` — choice — boda, corporativo, retrato, producto
   - `duration_hours` — number
   - `second_photographer` — yes/no
   - `drone` — yes/no
   - `distance_km` — number, optional
2. Write the formula. Example:
   ```
   ((event_type_idx == 0 ? 1200 : event_type_idx == 1 ? 350 : 280)
    + max(0, duration_hours - 4) * 180
    + (second_photographer ? 350 : 0)
    + (drone ? 250 : 0)
    + distance_km * 0.40) * 1.21
   ```
3. Test with a sample (Boda, 4h, no extras) → should return `1452.00 EUR`
4. Save Pricing

### Wire the handoff

Same captador agent → **🏁 Closing**.

1. "Sales agent to hand off to": pick Marta
2. Bridge phrase: e.g. "Perfecto, ya tengo todos los datos. Te paso con
   Marta del equipo comercial. Un momento por favor."
3. Save Agent

### Verify the script matches the variables

The captador's **📋 Script** must collect every variable referenced by
the pricing formula. If you added `duration_hours` as a pricing variable
but the script never asks about it, the formula will fail at runtime.

For each pricing variable, make sure there's a script step with the same
`label`. The script step's `dataType` should match the variable's type
(`number`/`number`, `boolean`/`yes-no`, `choice`/`choice`, etc.).

### Test the full flow

Call the number. Lucía (captador) asks for the data. After the last
required field, you'll hear the bridge phrase in Lucía's voice, a brief
pause (~1.5 s), and then Marta (with a different voice) comes in saying
something like "Hola Pedro, soy Marta. He visto los detalles… el total
de la propuesta son 1.452 €…". She'll capture your decision and end the
call.

The conversation in the dashboard shows both phases in a single
conversation log, with `calculatedTotal` saved on the record.

---

## Production hardening checklist

Before letting real customers hit the system:

### Security

- [ ] Delete or change password of `demo@agentai.local`. Register a new
      account with your real email and remove the demo account from the DB:
      ```sql
      DELETE FROM "User" WHERE email = 'demo@agentai.local';
      ```
- [ ] Confirm `SKIP_TWILIO_SIGNATURE=false` (or unset) in `.env`
- [ ] Confirm `JWT_SECRET` is a 32+ byte random string, not the placeholder
- [ ] Twilio webhook signature validation is on for both voice and WhatsApp
      (it is by default — the middleware refuses requests with a missing
      or invalid signature)
- [ ] Postgres password is strong and only `localhost` accepts connections
      (default in Ubuntu)
- [ ] SSH password auth disabled, only key-based login
- [ ] ufw firewall enabled, only 22/80/443 open
- [ ] fail2ban running

### Backups

Set up daily Postgres backups offsite. The cheapest is Backblaze B2
(~5€/TB/mo). Install rclone and configure a B2 remote, then add a cron:

```bash
# Edit the agentai user's crontab
crontab -e

# Daily at 04:00, dump and upload
0 4 * * * pg_dump agentai | gzip > /tmp/agentai-$(date +\%Y\%m\%d).sql.gz && \
  rclone copy /tmp/agentai-*.sql.gz b2:your-bucket/agentai/ && \
  rm /tmp/agentai-*.sql.gz
```

Test the restore at least once before you trust it.

### Monitoring

Bare minimum: UptimeRobot (free) pinging `https://agent.tudominio.com/api/health`
every 5 minutes with an email alert on failure. Set this up in 2 minutes
and you're covered for "is the server up".

For more depth later: Logtail or BetterStack for log aggregation,
Grafana Cloud free tier for metrics. Not needed at MVP scale.

### API key handling

The `User` table stores per-user API keys (Twilio, ElevenLabs,
OpenRouter) in plaintext. For your own single-tenant use this is fine on
a hardened VPS. **Before opening multi-tenant SaaS to external users**,
encrypt these at rest (libsodium secret-box or similar). This is
explicitly listed as out-of-scope for the MVP in `CHANGES.md`.

---

## Daily operations

### Updating the code

```bash
cd ~/agentai
git pull                            # or rsync new tarball
npm install                         # if dependencies changed
npx prisma migrate deploy           # if schema changed
sudo systemctl restart agentai
sudo journalctl -u agentai -f       # watch it come back up
```

### Restarting after `.env` changes

```bash
sudo systemctl restart agentai
```

### Reading logs

```bash
sudo journalctl -u agentai -n 200 --no-pager   # last 200 lines
sudo journalctl -u agentai -f                   # follow live
sudo journalctl -u agentai --since "1 hour ago"
```

### Database access

```bash
sudo -u postgres psql agentai
# or
psql postgresql://agentai:PASSWORD@localhost/agentai
```

### Manually checking pricing config from the DB

```sql
SELECT name, "pricingVariables", "pricingFormula", "salesAgentId"
FROM "Agent"
WHERE "userId" = (SELECT id FROM "User" WHERE email = 'tu@email.com');
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| 502 Bad Gateway from nginx | Node process not running | `sudo systemctl status agentai`, then check journal |
| Voice call connects but agent silent | nginx not upgrading WebSocket | Verify the `/api/webhooks/voice/media-stream` block in step 7 |
| Voice call hangs up immediately | `APP_URL` wrong, or signature validation rejecting | Check `.env`, check `journalctl` for "Invalid Twilio signature" |
| WhatsApp returns "this number is not configured" | Number not assigned to an agent in the dashboard | Numbers tab → assign an agent |
| Dashboard login fails with the seeded account | You ran seed against a non-empty DB | Drop and recreate the DB, or change the password manually |
| Pricing tab "Calculate" returns "Required variable X is missing" | The script doesn't collect variable X with the matching label | Open the Script tab, add a step with the exact label from the pricing variable |
| Handoff to comercial doesn't happen | Either: pricing not configured, or no salesAgentId set, or both | Verify both Pricing tab and Closing → Sales Agent Handoff |
| Robot voice instead of natural | `ELEVENLABS_API_KEY` and/or `DEEPGRAM_API_KEY` missing/invalid | Check `.env`, restart service |
| `Cannot find module '@prisma/client'` after `git pull` | Prisma client out of sync after schema changes | `npx prisma generate && sudo systemctl restart agentai` |

---

## Cost estimate (single-tenant production, low traffic)

For your own use with ~50 conversations/month:

| Item | Monthly cost |
|------|--------------|
| Hetzner CX22 VPS | 5€ |
| Twilio number (Spain) | ~$1 |
| Twilio voice minutes (~2hr/mo) | ~$2 |
| Twilio WhatsApp messages | ~$0.50 (or free in sandbox) |
| OpenRouter (GPT-4o Mini, ~50 conversations) | ~$0.50 |
| ElevenLabs Starter (30 min/mo) | $5 |
| Deepgram | free (within $200 credit) |
| Backblaze B2 (backups) | ~$0.05 |
| Domain | ~$1 (annual prorated) |
| **Total** | **~14€/mo** |

For reference: a single B2B lead converted at €1.500 covers roughly 9
years of operation. The unit economics are wildly favourable for serious
business use.
