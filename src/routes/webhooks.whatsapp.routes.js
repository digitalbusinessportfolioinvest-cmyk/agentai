const express = require('express');
const conversationService = require('../services/conversation.service');
const validateTwilioSignature = require('../middleware/twilio-signature');
const logger = require('../utils/logger');
const { resolveConversationLanguage } = require('../utils/language');
const router = express.Router();

router.use((req, res, next) => {
  logger.info(`[Twilio WhatsApp webhook] ${req.method} ${req.originalUrl}`);
  next();
});

// All Twilio webhooks must be signature-validated to prevent spoofing.
router.use(validateTwilioSignature);

// POST /api/webhooks/whatsapp/incoming
// Twilio sends a POST when a WhatsApp message arrives
router.post('/incoming', async (req, res, next) => {
  try {
    const { Body, From, To, NumMedia, MediaUrl0, MediaContentType0 } = req.body;
    const remoteNumber = From?.replace('whatsapp:', '');
    const localNumber = To?.replace('whatsapp:', '');

    logger.info(`WhatsApp incoming: ${remoteNumber} → ${localNumber}: "${Body}"`);

    if (!Body || !remoteNumber || !localNumber) {
      return res.type('text/xml').send('<Response></Response>');
    }

    const prisma = req.app.locals.prisma;

    // Find which phone number and agent this goes to
    const phoneNumber = await prisma.phoneNumber.findFirst({
      where: { twilioNumber: localNumber, isActive: true },
      include: { agent: true, user: true }
    });

    if (!phoneNumber || !phoneNumber.agent) {
      logger.warn(`No agent configured for number ${localNumber}`);
      const twiml = `<Response><Message>Sorry, this number is not configured. Please try again later.</Message></Response>`;
      return res.type('text/xml').send(twiml);
    }

    const agent = phoneNumber.agent;
    const user = phoneNumber.user;
    const convLang = resolveConversationLanguage(agent, phoneNumber);

    // Check for active conversation or start new one
    let conversation = await conversationService.findActiveWhatsAppConversation(agent.id, remoteNumber);

    if (!conversation) {
      logger.info(`New WhatsApp conversation: ${remoteNumber} with agent "${agent.name}"`);
      const result = await conversationService.startConversation({
        userId: user.id,
        agentId: agent.id,
        phoneNumberId: phoneNumber.id,
        channel: 'whatsapp',
        direction: 'inbound',
        remoteNumber,
        language: convLang
      });
      conversation = result.conversation;

      // If there's a greeting, send it first, then process the message
      if (result.greeting) {
        // Process the user's first message
        const response = await conversationService.processMessage(conversation.id, Body);
        // Combine greeting + response
        const fullReply = `${result.greeting}\n\n${response.reply}`;
        const twiml = `<Response><Message>${escapeXml(fullReply)}</Message></Response>`;
        return res.type('text/xml').send(twiml);
      }
    }

    // Process the message through the conversation engine
    const response = await conversationService.processMessage(conversation.id, Body);

    logger.info(`WhatsApp reply to ${remoteNumber}: "${response.reply.substring(0, 100)}..."`);
    if (Object.keys(response.data).length > 0) {
      logger.info(`Data collected: ${JSON.stringify(response.data)}`);
    }
    if (response.scriptComplete) {
      logger.info(`Script complete! All data: ${JSON.stringify(response.progress)}`);
    }

    const twiml = `<Response><Message>${escapeXml(response.reply)}</Message></Response>`;
    res.type('text/xml').send(twiml);
  } catch (err) {
    logger.error(`WhatsApp webhook error: ${err.message}`);
    const twiml = `<Response><Message>Sorry, something went wrong. Please try again.</Message></Response>`;
    res.type('text/xml').send(twiml);
  }
});

// POST /api/webhooks/whatsapp/status — message delivery status
router.post('/status', (req, res) => {
  logger.debug(`WhatsApp status: ${req.body.MessageStatus} for ${req.body.MessageSid}`);
  res.sendStatus(200);
});

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = router;
