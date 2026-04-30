const WebSocket = require('ws');
const stt = require('./stt.service');
const tts = require('./tts.service');
const llm = require('./llm.service');
const latency = require('./latency.service');
const pricing = require('./pricing.service');
const logger = require('../utils/logger');

const prisma = require('../db');

const HISTORY_WINDOW = 20;

/**
 * Handle a Twilio Media Stream WebSocket connection — real-time bidirectional
 * audio for live phone calls.
 *
 * Supports the intake → sales handoff inside the same call:
 *   1. Intake agent (e.g. recepcionista) collects the script
 *   2. When script_complete fires AND the agent has a salesAgentId, the
 *      pricing engine calculates the total from collected data
 *   3. The intake agent's last message is its handoffMessage (bridge phrase)
 *   4. The conversation transitions: voice changes, system prompt is
 *      rebuilt as the sales agent with handoff context including the total
 *   5. The sales agent communicates the proposal and captures the decision
 *      The customer never hangs up; it's one continuous call.
 */
function handleMediaStream(twilioWs, conversationId, agentId, language) {
  let streamSid = null;
  let deepgramConn = null;
  let transcriptBuffer = '';
  let isProcessing = false;
  let conversationHistory = [];
  let collectedProgress = {};
  let agent = null;          // currently-active agent (intake or sales)
  let intakeAgent = null;    // always the original captador
  let salesAgent = null;     // the comercial, if configured
  let user = null;
  let scriptSteps = [];      // current agent's steps
  let voiceId = null;
  let turnCount = 0;
  let currentRole = 'intake';
  let salesContext = null;   // populated at handoff time

  const ready = (async () => {
    try {
      intakeAgent = await prisma.agent.findUnique({
        where: { id: agentId },
        include: { user: { select: { id: true, openrouterKey: true } } }
      });
      if (!intakeAgent) throw new Error(`Agent ${agentId} not found`);
      user = intakeAgent.user;
      agent = intakeAgent;

      if (intakeAgent.salesAgentId) {
        salesAgent = await prisma.agent.findUnique({
          where: { id: intakeAgent.salesAgentId }
        });
      }

      scriptSteps = await prisma.scriptStep.findMany({
        where: { agentId: intakeAgent.id },
        orderBy: { stepOrder: 'asc' }
      });
      voiceId = intakeAgent.voiceId || tts.getDefaultVoice(language).id;

      const conv = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: {
          collectedData: true,
          messages: { orderBy: { createdAt: 'desc' }, take: HISTORY_WINDOW }
        }
      });
      if (conv) {
        currentRole = conv.currentRole || 'intake';
        for (const cd of conv.collectedData) {
          collectedProgress[cd.label] = cd.value;
        }
        const recent = [...conv.messages].reverse();
        for (const msg of recent) {
          conversationHistory.push({
            role: msg.direction === 'inbound' ? 'user' : 'assistant',
            content: msg.content
          });
        }
      }

      logger.info(`Voice stream ready: intake="${intakeAgent.name}", sales="${salesAgent?.name || '(none)'}", voice=${voiceId}, lang=${language}`);
    } catch (err) {
      logger.error(`Failed to load agent: ${err.message}`);
      throw err;
    }
  })();

  function startDeepgram() {
    deepgramConn = stt.createStreamingConnection(language, {
      onInterim(text) { logger.debug(`[STT interim] ${text}`); },

      onTranscript(text, speechFinal) {
        logger.info(`[STT final] "${text}" (speechFinal: ${speechFinal})`);
        transcriptBuffer += (transcriptBuffer ? ' ' : '') + text;

        if (speechFinal) {
          const fullUtterance = transcriptBuffer.trim();
          transcriptBuffer = '';
          if (fullUtterance && !isProcessing) {
            processUserUtterance(fullUtterance);
          }
        }
      },

      onUtteranceEnd() {
        if (transcriptBuffer.trim() && !isProcessing) {
          const fullUtterance = transcriptBuffer.trim();
          transcriptBuffer = '';
          processUserUtterance(fullUtterance);
        }
      },

      onError(err) { logger.error(`Deepgram error: ${err.message}`); },
      onClose() { logger.debug('Deepgram connection closed'); }
    });
  }

  /**
   * Run pricing for the intake agent's collected data and switch the
   * active agent/voice/prompt to the sales agent. Speaks the handoff
   * bridge phrase from the intake agent first, then the sales agent
   * takes over for the next user utterance.
   */
  async function handoffToSales() {
    if (!salesAgent) {
      logger.warn('handoffToSales called but no salesAgent configured');
      return false;
    }

    // 1. Calculate the total using the intake agent's pricing config
    let priceResult;
    try {
      priceResult = pricing.calculate(intakeAgent, collectedProgress);
    } catch (err) {
      logger.error(`Pricing failed during handoff: ${err.message}`);
      // If pricing fails, fall back to the intake agent's normal closing
      // (no handoff) so the customer isn't left hanging
      return false;
    }
    logger.info(`[Handoff] Calculated total: ${priceResult.amount} ${priceResult.currency}`);

    // 2. Persist the total and the new role on the conversation
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        currentRole: 'sales',
        calculatedTotal: priceResult.amount,
        salesAgentId: salesAgent.id
      }
    });

    // 3. Speak the intake agent's handoff bridge phrase. This gives the
    //    customer a few seconds of natural audio while we swap agents.
    //    e.g. "Perfecto, ya tengo todos los datos. Te paso con Marta..."
    const bridgePhrase = intakeAgent.handoffMessage
      || (language === 'es'
        ? `Perfecto, ya tengo todos los datos. Te paso con ${salesAgent.name} del equipo comercial, que te va a explicar la propuesta. Un momento por favor.`
        : `Perfect, I've got everything I need. Let me pass you to ${salesAgent.name} from our team to explain the proposal. One moment please.`);

    await tts.streamToTwilio(bridgePhrase, voiceId, twilioWs, streamSid);
    await prisma.message.create({
      data: { conversationId, direction: 'outbound', content: bridgePhrase }
    });

    // 4. Swap the active agent. Voice changes to the sales agent's voice,
    //    scriptSteps becomes the sales agent's steps (the decision script),
    //    and we set up salesContext so subsequent prompts include the
    //    handoff framing and the calculated total.
    agent = salesAgent;
    voiceId = salesAgent.voiceId || tts.getDefaultVoice(language).id;
    scriptSteps = await prisma.scriptStep.findMany({
      where: { agentId: salesAgent.id },
      orderBy: { stepOrder: 'asc' }
    });
    // Sales agent has its own progress (decision, etc.), separate from intake
    collectedProgress = {};
    salesContext = {
      calculatedTotal: priceResult.amount,
      currency: priceResult.currency,
      intakeData: { ...priceResult.inputs },
      intakeAgentName: intakeAgent.name
    };
    currentRole = 'sales';

    return true;
  }

  async function processUserUtterance(text) {
    isProcessing = true;
    turnCount++;
    logger.info(`[Turn ${turnCount}, role=${currentRole}] User: "${text}"`);

    try {
      await prisma.message.create({
        data: { conversationId, direction: 'inbound', content: text }
      });
      conversationHistory.push({ role: 'user', content: text });
      if (conversationHistory.length > HISTORY_WINDOW * 2) {
        conversationHistory = conversationHistory.slice(-HISTORY_WINDOW);
      }

      const fillerContext = turnCount === 1 ? 'data_received' : 'thinking';
      const fillerText = latency.getFiller(language, fillerContext);

      const [, llmResult] = await Promise.all([
        streamFillerToTwilio(fillerText),
        processWithLLM(text)
      ]);

      if (llmResult && llmResult.say) {
        logger.info(`[Turn ${turnCount}] Agent: "${llmResult.say.substring(0, 100)}..."`);

        await tts.streamToTwilio(llmResult.say, voiceId, twilioWs, streamSid);

        await prisma.message.create({
          data: { conversationId, direction: 'outbound', content: llmResult.say }
        });
        conversationHistory.push({ role: 'assistant', content: llmResult.say });

        await saveExtractedData(llmResult.data);

        // Handle script completion. If we're in intake and there's a sales
        // agent configured WITH pricing, hand off instead of finishing.
        if (llmResult.scriptComplete) {
          const canHandoff = currentRole === 'intake'
            && salesAgent
            && intakeAgent.pricingFormula
            && intakeAgent.pricingVariables;

          if (canHandoff) {
            logger.info(`[Handoff] Intake complete, transitioning to sales agent`);
            const ok = await handoffToSales();
            if (ok) {
              // Don't close — the call continues with the sales agent
              isProcessing = false;
              return;
            }
            // If handoff failed, fall through to normal completion
          }

          // Normal completion (no handoff or handoff failed)
          logger.info(`[Script complete] Data: ${JSON.stringify(collectedProgress)}`);
          await prisma.conversation.update({
            where: { id: conversationId },
            data: {
              status: 'completed',
              outcome: 'data_collected',
              endedAt: new Date(),
              scriptProgress: JSON.stringify(collectedProgress),
              currentRole: 'completed',
              summary: Object.entries(collectedProgress).map(([k, v]) => `${k}: ${v}`).join(', ')
            }
          });

          const output = require('./output.service');
          const updatedConv = await prisma.conversation.findUnique({
            where: { id: conversationId },
            include: { collectedData: true }
          });
          // Notify with whichever agent was active when the conversation closed
          output.notifyConversationComplete(agent, updatedConv, updatedConv.collectedData)
            .catch(err => logger.error(`Output notification error: ${err.message}`));

          setTimeout(() => {
            if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
          }, 5000);
        }
      }
    } catch (err) {
      logger.error(`Process utterance error: ${err.message}`);
      try {
        const errorMsg = language === 'es'
          ? 'Disculpa, hubo un error. ¿Puedes repetir?'
          : 'Sorry, there was an error. Could you repeat that?';
        await tts.streamToTwilio(errorMsg, voiceId, twilioWs, streamSid);
      } catch (_) { /* ignore */ }
    }

    isProcessing = false;
  }

  async function streamFillerToTwilio(fillerText) {
    try {
      const cacheKey = `${voiceId}:${fillerText}`;
      let cached = latency.getCachedAudio(cacheKey);

      if (!cached) {
        try {
          cached = await tts.synthesize(fillerText, voiceId, null, 'ulaw_8000');
          latency.setCachedAudio(cacheKey, cached);
          logger.debug(`Cached filler audio: "${fillerText}" for ${voiceId}`);
        } catch (err) {
          logger.warn(`Filler synth failed (non-critical): ${err.message}`);
          return;
        }
      }

      if (twilioWs.readyState !== WebSocket.OPEN) return;

      const CHUNK = 8000;
      for (let i = 0; i < cached.length; i += CHUNK) {
        if (twilioWs.readyState !== WebSocket.OPEN) break;
        const slice = cached.slice(i, i + CHUNK);
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: slice.toString('base64') }
        }));
      }
    } catch (err) {
      logger.warn(`Filler TTS error (non-critical): ${err.message}`);
    }
  }

  async function processWithLLM(userText) {
    const systemPrompt = llm.buildPrompt(
      agent, scriptSteps, collectedProgress, null,
      'voice', language,
      currentRole === 'sales' ? salesContext : null
    );
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory
    ];

    const apiKey = user?.openrouterKey || process.env.OPENROUTER_API_KEY;
    const rawResponse = await llm.chat(agent, messages, { stream: false, apiKey });
    return llm.parseResponse(rawResponse);
  }

  async function saveExtractedData(data) {
    if (!data || typeof data !== 'object') return;

    for (const [label, value] of Object.entries(data)) {
      if (value && value !== '') {
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
        collectedProgress[label] = value;
      }
    }

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { scriptProgress: JSON.stringify(collectedProgress), lastActivityAt: new Date() }
    });
  }

  twilioWs.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);

      switch (msg.event) {
        case 'connected':
          logger.info('Twilio Media Stream connected');
          break;

        case 'start':
          streamSid = msg.start.streamSid;
          logger.info(`Twilio stream started: ${streamSid}`);
          await ready;
          startDeepgram();
          break;

        case 'media':
          if (deepgramConn && !isProcessing) {
            const audio = Buffer.from(msg.media.payload, 'base64');
            deepgramConn.sendAudio(audio);
          }
          break;

        case 'mark':
          logger.debug(`Twilio mark: ${msg.mark.name}`);
          break;

        case 'stop':
          logger.info('Twilio stream stopped');
          break;
      }
    } catch (err) {
      logger.error(`Media stream message error: ${err.message}`);
    }
  });

  twilioWs.on('close', () => {
    logger.info('Twilio WebSocket closed');
    if (deepgramConn) deepgramConn.close();
  });

  twilioWs.on('error', (err) => {
    logger.error(`Twilio WebSocket error: ${err.message}`);
    if (deepgramConn) deepgramConn.close();
  });
}

module.exports = { handleMediaStream };

