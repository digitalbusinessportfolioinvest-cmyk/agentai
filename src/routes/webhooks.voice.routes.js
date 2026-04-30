const express = require('express');
const conversationService = require('../services/conversation.service');
const validateTwilioSignature = require('../middleware/twilio-signature');
const logger = require('../utils/logger');
const { resolveConversationLanguage } = require('../utils/language');
const router = express.Router();

router.use((req, res, next) => {
  logger.info(`[Twilio Voice webhook] ${req.method} ${req.originalUrl}`);
  next();
});

// All Twilio webhooks must be signature-validated to prevent spoofing.
router.use(validateTwilioSignature);

// POST /api/webhooks/voice/incoming
router.post('/incoming', async (req, res) => {
  try {
    const { From, To, CallSid } = req.body;
    logger.info(`Voice incoming: ${From} → ${To} (CallSid: ${CallSid})`);

    const prisma = req.app.locals.prisma;
    const phoneNumber = await prisma.phoneNumber.findFirst({
      where: { twilioNumber: To, isActive: true },
      include: { agent: true, user: true }
    });

    if (!phoneNumber || !phoneNumber.agent) {
      logger.warn(`No agent configured for number ${To}`);
      return res.type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this number is not configured.</Say><Hangup/></Response>'
      );
    }

    const agent = phoneNumber.agent;
    const convLang = resolveConversationLanguage(agent, phoneNumber);
    logger.info(`Conversation language: ${convLang}${agent.languageOverride ? ' [agent override]' : ''}`);
    const hasElevenLabs = !!process.env.ELEVENLABS_API_KEY;
    const hasDeepgram = !!process.env.DEEPGRAM_API_KEY;

    const { conversation } = await conversationService.startConversation({
      userId: phoneNumber.user.id,
      agentId: agent.id,
      phoneNumberId: phoneNumber.id,
      channel: 'voice',
      direction: 'inbound',
      remoteNumber: From,
      language: convLang
    });

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { twilioCallSid: CallSid }
    });

    const baseUrl = process.env.NGROK_URL || process.env.APP_URL;
    if (!baseUrl) {
      logger.error('Neither NGROK_URL nor APP_URL is set — cannot generate TwiML callback URLs.');
      return res.type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Server misconfigured.</Say><Hangup/></Response>'
      );
    }

    // Level 3: Media Streams (ElevenLabs + Deepgram = best experience)
    if (hasElevenLabs && hasDeepgram) {
      logger.info('Using Media Streams mode (ElevenLabs + Deepgram)');
      const wsUrl = baseUrl.replace('https://', 'wss://').replace('http://', 'ws://');

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}/api/webhooks/voice/media-stream">
      <Parameter name="conversationId" value="${conversation.id}"/>
      <Parameter name="agentId" value="${agent.id}"/>
      <Parameter name="language" value="${convLang}"/>
    </Stream>
  </Connect>
</Response>`;
      return res.type('text/xml').send(twiml);
    }

    // Level 1 fallback: Gather/Say (no ElevenLabs/Deepgram)
    logger.info('Using Gather/Say fallback mode');
    const voiceLang = getVoiceLanguage(convLang);
    const greetingText = agent.greetingMessage || getDefaultGreeting(convLang);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${voiceLang}" voice="Google.${voiceLang}-Standard-A">${escapeXml(greetingText)}</Say>
  <Gather input="speech" language="${voiceLang}" speechTimeout="2" action="${baseUrl}/api/webhooks/voice/respond?cid=${conversation.id}" method="POST">
    <Say language="${voiceLang}" voice="Google.${voiceLang}-Standard-A"></Say>
  </Gather>
  <Say language="${voiceLang}" voice="Google.${voiceLang}-Standard-A">${convLang === 'es' ? 'No he escuchado nada. Adiós.' : "I didn't hear anything. Goodbye."}</Say>
</Response>`;
    res.type('text/xml').send(twiml);
  } catch (err) {
    logger.error(`Voice incoming error: ${err.message}`);
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, an error occurred.</Say><Hangup/></Response>');
  }
});

// POST /api/webhooks/voice/respond — Gather/Say fallback
router.post('/respond', async (req, res) => {
  try {
    const { SpeechResult, Confidence } = req.body;
    const cid = req.query.cid;
    const baseUrl = process.env.NGROK_URL || process.env.APP_URL;

    if (!SpeechResult || !cid) {
      return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>I didn't catch that.</Say>
<Gather input="speech" speechTimeout="2" action="${baseUrl}/api/webhooks/voice/respond?cid=${cid}" method="POST"><Say></Say></Gather></Response>`);
    }

    logger.info(`Voice (Gather): "${SpeechResult}" (confidence: ${Confidence})`);

    const prisma = req.app.locals.prisma;
    const conversation = await prisma.conversation.findUnique({ where: { id: cid } });
    if (!conversation) {
      return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Conversation not found.</Say><Hangup/></Response>');
    }

    const response = await conversationService.processMessage(cid, SpeechResult);
    const voiceLang = getVoiceLanguage(conversation.language || 'es');

    if (response.scriptComplete) {
      return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say language="${voiceLang}" voice="Google.${voiceLang}-Standard-A">${escapeXml(response.reply)}</Say><Hangup/></Response>`);
    }

    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="${voiceLang}" voice="Google.${voiceLang}-Standard-A">${escapeXml(response.reply)}</Say>
  <Gather input="speech" language="${voiceLang}" speechTimeout="3" action="${baseUrl}/api/webhooks/voice/respond?cid=${cid}" method="POST"><Say></Say></Gather>
  <Say language="${voiceLang}" voice="Google.${voiceLang}-Standard-A">${conversation.language === 'es' ? 'Gracias. Adiós.' : 'Thanks. Goodbye.'}</Say>
  <Hangup/>
</Response>`);
  } catch (err) {
    logger.error(`Voice respond error: ${err.message}`);
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Error occurred.</Say><Hangup/></Response>');
  }
});

// POST /api/webhooks/voice/status
// Configure this URL in Twilio Console as the "call status changes" webhook,
// or it'll never be invoked and durationSeconds will stay null.
router.post('/status', async (req, res) => {
  const { CallSid, CallStatus, CallDuration, RecordingUrl } = req.body;
  logger.debug(`Voice status: ${CallSid} → ${CallStatus}`);
  if (CallStatus === 'completed' && CallSid) {
    try {
      const prisma = req.app.locals.prisma;
      const updateData = {
        durationSeconds: parseInt(CallDuration) || 0,
        endedAt: new Date()
      };
      if (RecordingUrl) updateData.recordingUrl = RecordingUrl;

      // Only mark completed if not already completed by the conversation engine
      const conv = await prisma.conversation.findFirst({ where: { twilioCallSid: CallSid } });
      if (conv && conv.status === 'active') {
        updateData.status = 'completed';
        if (!conv.outcome) updateData.outcome = 'partial';
      }

      await prisma.conversation.updateMany({
        where: { twilioCallSid: CallSid },
        data: updateData
      });
    } catch (err) { logger.error(`Status update: ${err.message}`); }
  }
  res.sendStatus(200);
});

function getVoiceLanguage(lang) {
  return { es: 'es-ES', en: 'en-US', it: 'it-IT', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR' }[lang] || 'en-US';
}
function getDefaultGreeting(lang) {
  return { es: 'Hola, gracias por llamar. ¿En qué puedo ayudarle?', en: 'Hello, thanks for calling. How can I help you?' }[lang] || 'Hello, thanks for calling.';
}
function escapeXml(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = router;
