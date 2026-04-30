const logger = require('../utils/logger');

/**
 * Send conversation results to all configured output channels
 * Called when a conversation status changes to 'completed'
 */
async function notifyConversationComplete(agent, conversation, collectedData) {
  const results = {
    conversation_id: conversation.id,
    agent_id: agent.id,
    agent_name: agent.name,
    channel: conversation.channel,
    direction: conversation.direction,
    remote_number: conversation.remoteNumber,
    language: conversation.language,
    status: conversation.status,
    outcome: conversation.outcome,
    duration_seconds: conversation.durationSeconds,
    message_count: conversation.messageCount,
    collected_data: {},
    summary: conversation.summary,
    started_at: conversation.startedAt,
    ended_at: conversation.endedAt,
    timestamp: new Date().toISOString()
  };

  // Format collected data as clean key-value
  if (collectedData && Array.isArray(collectedData)) {
    for (const d of collectedData) {
      results.collected_data[d.label] = d.value;
    }
  }

  const promises = [];

  // 1. Webhook
  if (agent.notifyWebhookUrl) {
    promises.push(sendWebhook(agent.notifyWebhookUrl, results));
  }

  // 2. Email (via simple SMTP or external service — placeholder)
  if (agent.notifyEmail) {
    promises.push(sendEmail(agent.notifyEmail, agent.name, results));
  }

  // 3. WhatsApp notification to owner
  if (agent.notifyWhatsapp) {
    promises.push(sendWhatsAppNotification(agent.notifyWhatsapp, agent.name, results));
  }

  // Run all in parallel, don't block
  const settled = await Promise.allSettled(promises);
  for (const result of settled) {
    if (result.status === 'rejected') {
      logger.error(`Output notification failed: ${result.reason?.message || result.reason}`);
    }
  }

  return results;
}

/**
 * POST results to a webhook URL
 * This is the main integration point for external modules
 */
async function sendWebhook(url, data) {
  logger.info(`Sending webhook to ${url}`);

  const payload = {
    event: 'conversation.completed',
    timestamp: data.timestamp,
    data
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'AgentAi/1.0',
      'X-AgentAi-Event': 'conversation.completed'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000) // 10s timeout
  });

  if (!response.ok) {
    throw new Error(`Webhook ${url} returned ${response.status}`);
  }

  logger.info(`Webhook sent successfully to ${url} (${response.status})`);
  return { channel: 'webhook', status: 'sent', statusCode: response.status };
}

/**
 * Send email notification (placeholder — uses console log for demo)
 * In production: integrate with SendGrid, Resend, or SMTP
 */
async function sendEmail(email, agentName, data) {
  const dataLines = Object.entries(data.collected_data)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');

  const body = `New conversation completed on AgentAi

Agent: ${agentName}
Channel: ${data.channel}
From: ${data.remote_number}
Duration: ${data.duration_seconds || 0}s

Collected Data:
${dataLines}

Summary: ${data.summary || 'N/A'}

---
Conversation ID: ${data.conversation_id}
Timestamp: ${data.timestamp}`;

  // For demo: log the email. In production: use an email service.
  logger.info(`📧 EMAIL notification to ${email}:`);
  logger.info(body);

  // TODO: Integrate with email service
  // Example with Resend:
  // await resend.emails.send({ from: 'AgentAi <noreply@agentai.app>', to: email, subject: `New lead: ${agentName}`, text: body });

  return { channel: 'email', status: 'logged', to: email };
}

/**
 * Send WhatsApp notification to the business owner
 * Uses the same Twilio account to send a message
 */
async function sendWhatsAppNotification(toNumber, agentName, data) {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;

  if (!twilioSid || !twilioToken) {
    logger.warn('Cannot send WhatsApp notification — Twilio credentials not configured');
    return { channel: 'whatsapp', status: 'skipped', reason: 'no_credentials' };
  }

  const dataLines = Object.entries(data.collected_data)
    .map(([k, v]) => `• ${k}: ${v}`)
    .join('\n');

  const message = `🤖 *New lead via ${data.channel}*
Agent: ${agentName}
From: ${data.remote_number}

${dataLines}

${data.summary ? `📝 ${data.summary}` : ''}`;

  try {
    const twilio = require('twilio')(twilioSid, twilioToken);
    const result = await twilio.messages.create({
      body: message,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_FROM || '+14155238886'}`, // Sandbox default
      to: `whatsapp:${toNumber}`
    });

    logger.info(`WhatsApp notification sent to ${toNumber} (${result.sid})`);
    return { channel: 'whatsapp', status: 'sent', sid: result.sid };
  } catch (err) {
    logger.error(`WhatsApp notification failed: ${err.message}`);
    // Fall back to logging
    logger.info(`💬 WHATSAPP notification to ${toNumber}:`);
    logger.info(message);
    return { channel: 'whatsapp', status: 'logged', error: err.message };
  }
}

/**
 * Public API format for external consumption
 * GET /api/v1/conversations/:id/output
 */
function formatOutput(conversation, collectedData) {
  const output = {
    conversation_id: conversation.id,
    agent_id: conversation.agentId,
    channel: conversation.channel,
    remote_number: conversation.remoteNumber,
    language: conversation.language,
    status: conversation.status,
    outcome: conversation.outcome,
    collected_data: {},
    summary: conversation.summary,
    started_at: conversation.startedAt,
    ended_at: conversation.endedAt,
    duration_seconds: conversation.durationSeconds,
    message_count: conversation.messageCount
  };

  if (collectedData) {
    for (const d of collectedData) {
      output.collected_data[d.label] = {
        value: d.value,
        type: d.dataType,
        confidence: d.confidence
      };
    }
  }

  return output;
}

module.exports = { notifyConversationComplete, sendWebhook, formatOutput };
