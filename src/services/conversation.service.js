const llm = require('./llm.service');
const output = require('./output.service');
const pricing = require('./pricing.service');
const logger = require('../utils/logger');
const prisma = require('../db');

const HISTORY_WINDOW = 20; // recent messages we feed back to the LLM

/**
 * Process an incoming message (works for both voice transcription and WhatsApp text).
 * For voice via Media Streams the parallel path lives in voice.stream.service.js;
 * this is used by WhatsApp and the Gather/Say voice fallback.
 *
 * Supports the intake → sales handoff: when the intake script completes and
 * the agent has a salesAgentId + pricing config, the conversation transitions
 * to the sales agent in the same channel. The customer keeps writing in the
 * same WhatsApp thread (or stays on the same call in Gather mode); only the
 * agent persona and the framing of the prompt change.
 */
async function processMessage(conversationId, userMessage) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      agent: true,
      user: { select: { id: true, openrouterKey: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: HISTORY_WINDOW },
      collectedData: true
    }
  });

  if (!conversation || !conversation.agent) {
    throw new Error('Conversation or agent not found');
  }

  // The "active agent" depends on which role the conversation is currently in.
  // - intake (default): the original agent on the conversation
  // - sales: the agent referenced by salesAgentId on the conversation
  let activeAgent = conversation.agent;
  let salesContext = null;

  if (conversation.currentRole === 'sales' && conversation.salesAgentId) {
    activeAgent = await prisma.agent.findUnique({ where: { id: conversation.salesAgentId } });
    if (!activeAgent) {
      throw new Error('Sales agent not found for in-progress sales handoff');
    }
    // Rebuild salesContext from stored data + the calculated total
    const intakeData = {};
    for (const cd of conversation.collectedData) intakeData[cd.label] = cd.value;
    salesContext = {
      calculatedTotal: conversation.calculatedTotal,
      currency: conversation.agent.pricingCurrency || 'EUR',
      intakeData,
      intakeAgentName: conversation.agent.name
    };
  }

  const recentMessages = [...conversation.messages].reverse();

  // Get script steps for the ACTIVE agent (intake or sales)
  const scriptSteps = await prisma.scriptStep.findMany({
    where: { agentId: activeAgent.id },
    orderBy: { stepOrder: 'asc' }
  });

  // Build progress. In intake role: aggregate from collectedData. In sales role:
  // sales has its own progress tracked separately via scriptProgress JSON.
  let progress = {};
  if (conversation.currentRole === 'sales') {
    try { progress = JSON.parse(conversation.scriptProgress || '{}'); } catch { progress = {}; }
  } else {
    for (const cd of conversation.collectedData) progress[cd.label] = cd.value;
  }

  // Save incoming message
  await prisma.message.create({
    data: { conversationId, direction: 'inbound', content: userMessage }
  });

  const messages = [
    { role: 'system', content: llm.buildPrompt(activeAgent, scriptSteps, progress, null, conversation.channel, conversation.language || 'es', salesContext) }
  ];
  for (const msg of recentMessages) {
    messages.push({
      role: msg.direction === 'inbound' ? 'user' : 'assistant',
      content: msg.content
    });
  }
  messages.push({ role: 'user', content: userMessage });

  const apiKey = conversation.user?.openrouterKey || process.env.OPENROUTER_API_KEY;
  const rawResponse = await llm.chat(activeAgent, messages, { stream: false, apiKey });
  const parsed = llm.parseResponse(rawResponse);

  await prisma.message.create({
    data: { conversationId, direction: 'outbound', content: parsed.say }
  });

  // Save extracted data — into ConversationData (intake) or scriptProgress (sales)
  for (const [label, value] of Object.entries(parsed.data)) {
    if (value && value !== '') {
      if (conversation.currentRole === 'sales') {
        // Sales decisions are kept on the conversation's scriptProgress JSON
        progress[label] = value;
      } else {
        const scriptStep = scriptSteps.find(s => s.label === label);
        const existing = await prisma.conversationData.findFirst({
          where: { conversationId, label }
        });
        if (existing) {
          await prisma.conversationData.update({
            where: { id: existing.id },
            data: { value: String(value), scriptStepId: scriptStep?.id }
          });
        } else {
          await prisma.conversationData.create({
            data: {
              conversationId, label, value: String(value),
              dataType: scriptStep?.dataType || 'text',
              scriptStepId: scriptStep?.id
            }
          });
        }
        progress[label] = value;
      }
    }
  }

  const updateData = {
    messageCount: { increment: 2 },
    lastActivityAt: new Date(),
    scriptProgress: JSON.stringify(progress)
  };

  // Decide what happens when script_complete fires
  let salesOpening = null;
  if (parsed.scriptComplete) {
    const intakeAgent = conversation.agent; // always the original
    const canHandoff = conversation.currentRole === 'intake'
      && intakeAgent.salesAgentId
      && intakeAgent.pricingFormula
      && intakeAgent.pricingVariables;

    if (canHandoff) {
      // Compute the total from intake data and switch to sales role
      try {
        const intakeInputs = {};
        for (const cd of conversation.collectedData) intakeInputs[cd.label] = cd.value;
        for (const [k, v] of Object.entries(parsed.data)) {
          if (v && v !== '') intakeInputs[k] = v;
        }
        const result = pricing.calculate(intakeAgent, intakeInputs);
        logger.info(`[Handoff] Calculated total: ${result.amount} ${result.currency}`);
        updateData.currentRole = 'sales';
        updateData.calculatedTotal = result.amount;
        updateData.salesAgentId = intakeAgent.salesAgentId;
        updateData.scriptProgress = '{}';

        // Generate the sales agent's opening message in the same turn so the
        // customer receives a continuous reply (intake closing + sales opening).
        // For WhatsApp this means a single combined message; for the voice
        // Gather fallback the caller also hears them in one TwiML response.
        try {
          const salesAgent = await prisma.agent.findUnique({ where: { id: intakeAgent.salesAgentId } });
          const salesScriptSteps = await prisma.scriptStep.findMany({
            where: { agentId: salesAgent.id },
            orderBy: { stepOrder: 'asc' }
          });
          const salesContextNew = {
            calculatedTotal: result.amount,
            currency: result.currency,
            intakeData: { ...result.inputs },
            intakeAgentName: intakeAgent.name
          };
          const salesPrompt = llm.buildPrompt(
            salesAgent, salesScriptSteps, {}, null,
            conversation.channel, conversation.language || 'es', salesContextNew
          );
          // Synthetic kickoff: the sales agent receives the equivalent of
          // "the intake just handed off, deliver your opening". We send a
          // marker user turn so the model produces its first proposal-aware
          // message instead of waiting for real customer input.
          const kickoffMessages = [
            { role: 'system', content: salesPrompt },
            { role: 'user', content: '[Handoff received. Greet the customer and communicate the proposal now.]' }
          ];
          const salesRaw = await llm.chat(salesAgent, kickoffMessages, { stream: false, apiKey });
          const salesParsed = llm.parseResponse(salesRaw);
          if (salesParsed.say) {
            salesOpening = salesParsed.say;
            // Persist the sales agent's first message so it appears in history
            await prisma.message.create({
              data: { conversationId, direction: 'outbound', content: salesOpening }
            });
            updateData.messageCount = { increment: 3 };
          }
        } catch (err) {
          logger.warn(`Could not generate sales opening (will fall back to bridge phrase only): ${err.message}`);
          salesOpening = intakeAgent.handoffMessage
            || `Te paso con ${(await prisma.agent.findUnique({ where: { id: intakeAgent.salesAgentId } }))?.name || 'el equipo comercial'}.`;
        }
      } catch (err) {
        logger.error(`Pricing failed during handoff: ${err.message}`);
        updateData.status = 'completed';
        updateData.outcome = 'data_collected';
        updateData.endedAt = new Date();
        updateData.currentRole = 'completed';
        updateData.summary = Object.entries(progress).map(([k, v]) => `${k}: ${v}`).join(', ');
      }
    } else {
      // Normal completion, no handoff
      updateData.status = 'completed';
      updateData.outcome = 'data_collected';
      updateData.endedAt = new Date();
      updateData.currentRole = 'completed';
      updateData.summary = Object.entries(progress).map(([k, v]) => `${k}: ${v}`).join(', ');
    }
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: updateData
  });

  if (parsed.scriptComplete && updateData.status === 'completed') {
    const updatedConv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { collectedData: true }
    });
    output.notifyConversationComplete(activeAgent, updatedConv, updatedConv.collectedData)
      .catch(err => logger.error(`Output notification error: ${err.message}`));
  }

  // Reply combines the intake's closing + the sales opening when handoff happened
  const fullReply = salesOpening
    ? `${parsed.say}\n\n${salesOpening}`
    : parsed.say;

  return {
    reply: fullReply,
    intakeReply: parsed.say,
    salesOpening,
    data: parsed.data,
    progress,
    scriptComplete: parsed.scriptComplete,
    handoffOccurred: !!salesOpening,
    calculatedTotal: updateData.calculatedTotal
  };
}

/**
 * Start a new conversation
 */
async function startConversation({ userId, agentId, phoneNumberId, channel, direction, remoteNumber, language }) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw new Error('Agent not found');

  const conversation = await prisma.conversation.create({
    data: {
      userId, agentId, phoneNumberId, channel, direction,
      remoteNumber, language: language || 'es',
      status: 'active',
      startedAt: new Date(),
      lastActivityAt: new Date(),
      scriptProgress: '{}'
    }
  });

  // Save greeting as first outbound message so it appears in history
  if (agent.greetingMessage) {
    await prisma.message.create({
      data: { conversationId: conversation.id, direction: 'outbound', content: agent.greetingMessage }
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { messageCount: { increment: 1 } }
    });
  }

  return { conversation, greeting: agent.greetingMessage };
}

/**
 * Find an active WhatsApp conversation for a phone number, respecting the
 * agent's whatsappTimeout (in minutes). Idle conversations beyond the timeout
 * are auto-closed and the next message starts a fresh one.
 */
async function findActiveWhatsAppConversation(agentId, remoteNumber) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { whatsappTimeout: true }
  });
  const timeoutMinutes = agent?.whatsappTimeout || 1440; // default 24h

  const candidate = await prisma.conversation.findFirst({
    where: {
      agentId,
      remoteNumber,
      channel: 'whatsapp',
      status: 'active'
    },
    orderBy: { createdAt: 'desc' }
  });

  if (!candidate) return null;

  const lastActivity = candidate.lastActivityAt || candidate.startedAt || candidate.createdAt;
  const ageMinutes = (Date.now() - new Date(lastActivity).getTime()) / 60000;

  if (ageMinutes > timeoutMinutes) {
    // Conversation is stale — close it out and let the caller start fresh
    logger.info(`Closing stale WhatsApp conversation ${candidate.id} (idle ${Math.round(ageMinutes)}min, limit ${timeoutMinutes}min)`);
    await prisma.conversation.update({
      where: { id: candidate.id },
      data: {
        status: 'abandoned',
        outcome: candidate.outcome || 'partial',
        endedAt: new Date()
      }
    });
    return null;
  }

  return candidate;
}

module.exports = { processMessage, startConversation, findActiveWhatsAppConversation };
