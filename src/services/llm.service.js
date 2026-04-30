const OpenAI = require('openai');
const logger = require('../utils/logger');

// OpenRouter uses the OpenAI-compatible API
function getClient(apiKey) {
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: apiKey || process.env.OPENROUTER_API_KEY,
  });
}

// Models that reliably support response_format: { type: "json_object" } via OpenRouter.
// For others, we rely on prompt instruction + robust extraction.
const JSON_MODE_MODELS = [
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/gpt-5-nano',
  'openai/gpt-4-turbo',
  'anthropic/claude-haiku',
  'anthropic/claude-sonnet',
  'anthropic/claude-3.5-sonnet',
  'anthropic/claude-3.5-haiku',
  'mistralai/mistral-small',
];

function supportsJsonMode(model) {
  if (!model) return false;
  return JSON_MODE_MODELS.some(m => model.startsWith(m));
}

/**
 * Build the system prompt for a conversation turn.
 *
 * `salesContext` is set when this agent is the sales (commercial) agent
 * receiving a handoff from an intake agent. It contains:
 *   - calculatedTotal: the price computed by the pricing engine
 *   - currency: e.g. "EUR"
 *   - intakeData: { label: value } map of everything the intake captured
 *   - intakeAgentName: name of the agent who handed off
 * When present, the prompt instructs the agent to communicate the proposal
 * to the customer and gather their decision instead of starting fresh.
 */
function buildPrompt(agent, scriptSteps, progress, conversationHistory, channel, language, salesContext) {
  const channelContext = channel === 'whatsapp'
    ? 'You are chatting via WhatsApp. Keep messages short and concise (1-3 sentences max). You can use emojis sparingly.'
    : 'You are on a live phone call. ALWAYS begin your response with a brief natural acknowledgment word (like "Mmm", "Sure", "Right", "Veamos", "Claro") before your actual answer. This creates natural conversation flow and avoids dead air.';

  const langInstruction = `Speak in ${language === 'es' ? 'Spanish' : language === 'en' ? 'English' : language === 'it' ? 'Italian' : language === 'fr' ? 'French' : language === 'de' ? 'German' : language === 'pt' ? 'Portuguese' : language}.`;

  let scriptSection = '';
  if (scriptSteps && scriptSteps.length > 0) {
    scriptSection = '\n## Data to Collect\n';
    for (const step of scriptSteps) {
      const status = progress?.[step.label] ? `✓ "${progress[step.label]}"` : '[not yet collected]';
      const choices = step.choices ? ` Options: ${safeJsonParse(step.choices, []).join(', ')}` : '';
      const required = step.isRequired ? ' (required)' : ' (optional)';
      scriptSection += `- ${step.label}: ${step.promptText}${choices}${required} → ${status}\n`;
    }
  }

  const allCollected = scriptSteps?.length > 0 && scriptSteps
    .filter(s => s.isRequired)
    .every(s => progress?.[s.label]);

  // When this is a sales agent receiving a handoff, override the framing:
  // it's not a cold conversation, the customer already gave their data to
  // the intake agent and the price has been calculated.
  let salesSection = '';
  if (salesContext) {
    const intakeLines = Object.entries(salesContext.intakeData || {})
      .map(([k, v]) => `  - ${k}: ${v}`)
      .join('\n');
    const formattedTotal = `${salesContext.calculatedTotal.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${salesContext.currency || 'EUR'}`;
    salesSection = `

## Handoff Context — IMPORTANT
You are receiving a customer who just spoke with ${salesContext.intakeAgentName || 'a colleague'} from your team. They have already given the following information:
${intakeLines}

The system has calculated the proposed total: **${formattedTotal}**

Your job in this conversation:
1. Greet the customer warmly, acknowledge that you've seen what they discussed (do NOT make them repeat their data)
2. Communicate the total clearly: ${formattedTotal}
3. Answer any questions about what's included, conditions, next steps
4. Capture their decision: do they accept, want to think about it, want to modify something, or reject?
5. When their decision is clear, wrap up naturally

Do NOT recalculate or invent prices. The total is ${formattedTotal} — that is what you communicate.
Do NOT ask for any data already collected above.
`;
  }

  return `${agent.systemPrompt}

${langInstruction}
${channelContext}

## How to Introduce Yourself
When the conversation starts, present yourself like this (adapt naturally to the language):
${agent.greetingMessage || 'Greet them warmly and ask how you can help.'}

## If Asked Whether You Are an AI
IMPORTANT: You must ALWAYS be truthful. NEVER deny being an AI. Use this response (adapt naturally):
"${agent.aiDisclosure || "Yes, I'm an AI assistant. I'm here to help collect your information so our team can assist you. If you'd prefer to speak with a person, just let me know."}"
${salesSection}${scriptSection}
## When All Required Data Is Collected
${allCollected
    ? `All required data has been collected. Deliver the closing message naturally:\n"${agent.closingMessage || "I have all the details I need. Our team will review your request and get back to you shortly. Is there anything else you'd like to add?"}"\nThen wrap up the conversation.`
    : 'Continue collecting the missing data naturally.'}

## Instructions
- Be natural and conversational, not robotic
- Extract data from what the person says — don't interrogate
- If they provide multiple answers at once, acknowledge all of them
- If they go off-topic, gently steer back to collecting the needed information
- NEVER lie about being an AI if asked directly or indirectly

IMPORTANT: Respond with valid JSON only, with NO surrounding text, NO markdown fences, NO commentary. The JSON must be a single object with this exact shape:
{"say": "Your spoken/written response here", "data": {"field_label": "extracted value"}, "script_complete": false}

If no new data was extracted in this turn, use an empty data object: {"say": "...", "data": {}, "script_complete": false}
When all required data is collected and you've confirmed with the person, set "script_complete" to true.`;
}

/**
 * Chat with the LLM (streaming for voice, non-streaming for WhatsApp)
 */
async function chat(agent, messages, options = {}) {
  const apiKey = options.apiKey || process.env.OPENROUTER_API_KEY;
  const client = getClient(apiKey);
  const model = agent.llmModel || process.env.OPENROUTER_DEFAULT_MODEL || 'openai/gpt-4o-mini';

  logger.debug(`LLM request: model=${model}, messages=${messages.length}, stream=${!!options.stream}`);

  const params = {
    model,
    messages,
    temperature: agent.temperature ?? 0.7,
  };

  // Use JSON mode when supported. Otherwise rely on prompt + parser robustness.
  if (supportsJsonMode(model)) {
    params.response_format = { type: 'json_object' };
  }

  if (options.stream) {
    params.stream = true;
    return client.chat.completions.create(params);
  }

  const response = await client.chat.completions.create(params);
  const content = response.choices[0]?.message?.content || '';
  logger.debug(`LLM response: ${content.substring(0, 200)}`);
  return content;
}

/**
 * Parse LLM response — extract say text, data, and script_complete flag.
 * Robust against markdown fences, leading/trailing prose, and minor format drift.
 */
function parseResponse(text) {
  if (!text || typeof text !== 'string') {
    return { say: '', data: {}, scriptComplete: false };
  }

  // Strip markdown fences if present
  let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  // Try direct JSON parse first
  try {
    const parsed = JSON.parse(cleaned);
    return normaliseParsed(parsed);
  } catch (_) { /* fall through */ }

  // Extract first balanced JSON object using a brace counter
  const extracted = extractFirstJsonObject(cleaned);
  if (extracted) {
    try {
      const parsed = JSON.parse(extracted);
      return normaliseParsed(parsed);
    } catch (e) {
      logger.warn(`Extracted JSON failed to parse: ${e.message}`);
    }
  }

  // Last resort: treat the entire text as the spoken reply, with no data.
  // This avoids accidentally speaking JSON braces to the caller, since we
  // strip anything that looks like a JSON-y fragment.
  const fallback = cleaned.replace(/[{}\[\]"]/g, '').trim();
  logger.warn('Failed to parse LLM response as JSON; using stripped fallback text');
  return { say: fallback || cleaned, data: {}, scriptComplete: false };
}

function normaliseParsed(parsed) {
  return {
    say: typeof parsed.say === 'string' ? parsed.say : '',
    data: (parsed.data && typeof parsed.data === 'object') ? parsed.data : {},
    scriptComplete: parsed.script_complete === true
  };
}

/**
 * Find the first balanced {...} block in a string. Handles nested braces and
 * ignores braces inside strings.
 */
function extractFirstJsonObject(s) {
  const start = s.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < s.length; i++) {
    const c = s[i];

    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.substring(start, i + 1);
    }
  }
  return null;
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

module.exports = { buildPrompt, chat, parseResponse, getClient, supportsJsonMode };
