#!/usr/bin/env node
/**
 * Smoke-test HTTP endpoints locally. Requires the dev server: npm run dev
 *
 * For POST /api/webhooks/* to succeed without a valid Twilio signature, set in .env:
 *   SKIP_TWILIO_SIGNATURE=true
 *
 * Watch the same terminal as npm run dev for:
 *   [Twilio Voice webhook] / [Twilio WhatsApp webhook]
 *   [Twilio] POST … → status
 *   [Prisma] …ms SELECT …
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const http = require('http');

const port = Number(process.env.PORT || 3000);

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () =>
        resolve({ status: res.statusCode, body: data })
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  console.log('\n--- AgentAi local webhook test ---\n');

  console.log(`GET /api/health`);
  const health = await httpRequest({
    hostname: '127.0.0.1',
    port,
    path: '/api/health',
    method: 'GET'
  });
  console.log(`  → ${health.status} ${health.body.slice(0, 120)}\n`);

  const waBody = new URLSearchParams({
    Body: 'Hello from trigger-local-webhook.js',
    From: 'whatsapp:+15551230001',
    To: 'whatsapp:+15559876543'
  }).toString();

  console.log(`POST /api/webhooks/whatsapp/incoming (sandbox-style payload)`);
  const wa = await httpRequest(
    {
      hostname: '127.0.0.1',
      port,
      path: '/api/webhooks/whatsapp/incoming',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(waBody)
      }
    },
    waBody
  );
  console.log(`  → ${wa.status} (Twilio XML/Messaging response)\n`);

  const voiceBody = new URLSearchParams({
    From: '+15551230001',
    To: '+15559876543',
    CallSid: 'CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  }).toString();

  console.log(`POST /api/webhooks/voice/incoming (will return TwiML or “not configured” if To is unknown)`);
  const voice = await httpRequest(
    {
      hostname: '127.0.0.1',
      port,
      path: '/api/webhooks/voice/incoming',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(voiceBody)
      }
    },
    voiceBody
  );
  console.log(`  → ${voice.status}\n`);

  console.log('Done. Server logs should show [Twilio … webhook], [Twilio], Voice/WhatsApp lines, and [Prisma] on DB hits.');
  console.log('If POST returned 403, set SKIP_TWILIO_SIGNATURE=true and restart npm run dev.\n');
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
