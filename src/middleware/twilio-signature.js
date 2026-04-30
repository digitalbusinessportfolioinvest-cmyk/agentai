const twilio = require('twilio');
const logger = require('../utils/logger');

/**
 * Express middleware that validates the X-Twilio-Signature header on
 * inbound webhook requests. Without this, anyone with the public ngrok / app
 * URL can spoof voice + WhatsApp events and pollute the database, burn
 * OpenRouter / ElevenLabs / Deepgram credit, or trigger arbitrary
 * conversations.
 *
 * Set SKIP_TWILIO_SIGNATURE=true in .env for local testing without Twilio
 * (e.g. when manually POSTing test payloads with curl).
 */
function validateTwilioSignature(req, res, next) {
  if (process.env.SKIP_TWILIO_SIGNATURE === 'true') {
    return next();
  }

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    logger.warn('TWILIO_AUTH_TOKEN not set — cannot validate webhook signature. Refusing request.');
    return res.status(500).type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Server misconfigured.</Say><Hangup/></Response>'
    );
  }

  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    logger.warn(`Missing Twilio signature on ${req.path} from ${req.ip}`);
    return res.status(403).type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Unauthorized.</Say><Hangup/></Response>'
    );
  }

  // Reconstruct the URL Twilio used to sign the request.
  // In production behind a reverse proxy / ngrok, req.protocol may be wrong,
  // so prefer NGROK_URL or APP_URL.
  const baseUrl = process.env.NGROK_URL || process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const url = baseUrl.replace(/\/$/, '') + req.originalUrl;

  // Twilio signs the full POST body (form params) for HTTP webhooks.
  const params = req.body || {};

  const valid = twilio.validateRequest(authToken, signature, url, params);
  if (!valid) {
    logger.warn(`Invalid Twilio signature on ${req.path} (url=${url}) from ${req.ip}`);
    return res.status(403).type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Signature invalid.</Say><Hangup/></Response>'
    );
  }

  next();
}

module.exports = validateTwilioSignature;
