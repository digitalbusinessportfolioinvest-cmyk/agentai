# AgentAi — MVP CHANGES

Builds on top of `CHANGES.md` (the fix pass). This pass adds three things
to make AgentAi the captador + presupuestador + comercial flow you described:

1. **Configurable pricing** per agent, with up to 15 variables and a free-form
   math formula evaluated by a safe expression parser
2. **Sales agent handoff** inside the same call: when the intake script
   completes, the system computes the total, switches voice and prompt to a
   linked sales agent, and that agent communicates the proposal
3. **Dashboard support** for both: a new "💰 Pricing" tab in the agent
   editor, and a sales agent selector + bridge phrase field in the
   "🏁 Closing" tab

Code growth: +377 lines (backend went from 2,419 to 2,796).

---

## What got added

### `src/services/pricing.service.js` (new — 137 lines)

The pricing engine. Three entry points:

- `validateConfig({ variables, formula })` — checks that the variables are
  well-formed (max 15, valid labels, valid types, choices for choice types)
  and that the formula parses cleanly with no undeclared symbols. Used by
  the dashboard's Save action so users can't ship a broken config.
- `calculate(agent, inputs)` — runs the formula with values coerced to the
  declared types. Used at handoff time and by the test endpoint. Returns
  `{ amount, currency, inputs }`. Rounds to 2 decimals.
- `parseVariables` / `compileFormula` — exported for direct reuse.

Formula evaluation uses `expr-eval`, which has no access to the filesystem,
network, or process — only arithmetic, comparisons, conditionals, logical
operators, and a fixed set of math built-ins (`min`, `max`, `abs`, `round`,
`floor`, `ceil`, `pow`, `sqrt`). Assignment is explicitly disabled so a
formula can't mutate state. Choice variables also expose a `<label>_idx`
companion (zero-based index) so users can do arithmetic on them.

### `src/routes/pricing.routes.js` (new — 116 lines)

Four endpoints, all owner-scoped:

- `GET /api/pricing/:agentId` — read variables + formula + currency
- `PUT /api/pricing/:agentId` — save (validates before persisting)
- `POST /api/pricing/:agentId/test` — run the formula against arbitrary
  inputs without affecting any conversation
- `POST /api/pricing/:agentId/calculate-for-conversation` — internal
  endpoint used by the conversation engine when intake completes

### Schema changes (`prisma/schema.prisma`)

`Agent` gains:
- `role` ("intake" | "sales" | "standalone", default "standalone")
- `salesAgentId` (self-relation: which sales agent receives the handoff)
- `handoffMessage` (the bridge phrase the intake says before passing the call)
- `pricingVariables` (JSON array, max 15 entries)
- `pricingFormula` (math expression, max 2000 chars)
- `pricingCurrency` (default "EUR")

`Conversation` gains:
- `currentRole` ("intake" | "sales" | "completed") — tracks where in the
  flow the conversation currently is, so a reload of state on reconnect
  knows whether to use intake or sales agent
- `calculatedTotal` — the amount the formula returned at handoff
- `salesAgentId` — which sales agent took over

### `src/services/voice.stream.service.js` (rewritten)

Loads both the intake agent and the linked sales agent (if any) when the
WebSocket opens. When `script_complete` fires while in intake mode AND a
sales agent + pricing config exist, calls `handoffToSales()` which:

1. Runs `pricing.calculate()` on the captured data
2. Persists `currentRole=sales`, `calculatedTotal`, and `salesAgentId` on
   the conversation
3. Speaks the bridge phrase using the intake voice (so the customer hears
   "te paso con Marta" in Lucía's voice)
4. Swaps the active agent: voice changes to the sales agent's voice, the
   script is replaced with the sales agent's, and `salesContext` is built
   from the calculated total + the captured intake data
5. Subsequent user utterances are processed by the sales agent with the
   handoff context inlined into its system prompt

The handoff is one continuous WebSocket: the customer doesn't hang up, the
call doesn't drop, only the persona/voice/prompt change.

### `src/services/conversation.service.js` (extended)

Same handoff logic for WhatsApp and the voice Gather/Say fallback. Since
those channels don't have a live audio stream where you can mid-utterance
swap voices, the implementation is slightly different:

- When `script_complete` fires and handoff is possible, the system runs
  pricing, marks the conversation as `currentRole=sales`, and **also runs
  one extra LLM call right then** with the sales agent's prompt to get its
  opening message (the proposal communication)
- The reply returned to the WhatsApp / voice fallback handler combines the
  intake's closing + the sales opening, separated by `\n\n`, so the
  customer receives both in a single outbound message
- All subsequent messages from the customer are handled by the sales
  agent with the proposal context

### `src/services/llm.service.js` (extended)

`buildPrompt` now takes an optional `salesContext` parameter. When set, the
prompt is rewritten to instruct the agent that this is a handoff: it
mustn't re-collect data, it must communicate the supplied total, and it
must capture the customer's decision instead of starting a new intake.

### `src/routes/agents.routes.js` (extended)

POST and PUT now accept `role`, `salesAgentId`, and `handoffMessage` and
validate that the sales agent is owned by the same user (and isn't the
agent pointing to itself).

### `public/index.html` (extended — +121 lines)

- New **💰 Pricing** tab in the agent editor with: variable builder
  (label, type, required, choices), formula textarea with operator hints,
  currency field, save button, and a test calculator that runs the
  formula client→server with sample inputs
- The **🏁 Closing** tab gains a "Sales Agent Handoff" section: a
  dropdown to pick which agent receives the handoff (filtered to agents
  the user owns, excluding the current one), and a textarea for the
  bridge phrase

### `package.json`

Added `expr-eval` (no other new dependencies).

---

## How it ties together

```
Cliente llama
   ↓
Twilio → AgentAi (currentRole=intake)
   ↓
Lucía (intake) saluda y va recogiendo los datos del script
   ↓
Último dato extraído → script_complete=true
   ↓
voice.stream.service detecta:
   - Intake completo
   - El agente tiene salesAgentId apuntando a Marta
   - El agente tiene pricingFormula y pricingVariables configurados
   ↓
pricing.service.calculate(intakeAgent, datos)
   → 1.754,50 EUR  (5ms, determinista)
   ↓
Conversation.update({
   currentRole: 'sales',
   calculatedTotal: 1754.50,
   salesAgentId: marta.id
})
   ↓
TTS habla el handoffMessage de Lucía:
   "Te paso con Marta del comercial. Un momento por favor."
   ↓
[silencio natural ~1.5-2s, mientras se prepara el primer turno de Marta]
   ↓
Cliente dice algo (saludo, pregunta, lo que sea)
   ↓
voice.stream procesa con:
   - voiceId = voz de Marta
   - systemPrompt = buildPrompt(marta, ..., salesContext={
        calculatedTotal: 1754.50,
        currency: 'EUR',
        intakeData: { event_type: 'boda', duration_hours: 4, ... },
        intakeAgentName: 'Lucía'
     })
   ↓
Marta responde con la voz nueva, sabiendo qué propuesta comunicar y qué
datos ya están en mano
   ↓
Conversación de cierre, recoge decisión (aceptar/pensar/modificar/rechazar)
   ↓
Marta marca script_complete → conversation status=completed
   ↓
Webhook a /presupuestador o donde se haya configurado el output, con la
decisión final del cliente y el total
```

---

## Files touched / created

```
A  src/services/pricing.service.js
A  src/routes/pricing.routes.js
M  prisma/schema.prisma                  (+29 lines: 8 fields on Agent, 3 on Conversation)
M  src/server.js                         (mount pricing routes)
M  src/routes/agents.routes.js           (accept role/salesAgentId/handoffMessage)
M  src/services/voice.stream.service.js  (handoff logic for Media Streams)
M  src/services/conversation.service.js  (handoff logic for WhatsApp/fallback)
M  src/services/llm.service.js           (salesContext parameter)
M  public/index.html                     (Pricing tab + Closing handoff section)
M  package.json                          (expr-eval dep)
```

---

## What's NOT in the MVP (deliberate)

- **Outbound calls.** This MVP is the inbound flow you confirmed: cliente
  llama → Lucía capta → presupuestador calcula → Marta comunica, todo en
  la misma llamada. Outbound (que el sistema llame al cliente) seguiría
  siendo otro módulo si en el futuro lo necesitas.
- **Voice preview in the dashboard.** Para elegir voz sigues yendo a la
  biblioteca de ElevenLabs y copiando el voice ID. Es un detalle de UX que
  se puede meter en 30 líneas pero no afecta al flow.
- **Email real para los outputs.** Sigue siendo el mismo placeholder que
  loguea por consola — cuando quieras email de verdad, integramos Resend.
- **Encriptación de las API keys** guardadas en la BD. Sigue plano. Para
  uso propio en VPS controlado por ti, suficiente. Para SaaS comercial,
  hay que cifrar.
- **Workflow de las otras 9 etapas** que mencionaste. Eso requiere su
  propio diseño cuando llegue el momento. AgentAi como capa de
  comunicación está listo para que cualquier módulo le hable por webhook.

---

## Cómo lo pruebas tú

1. Descomprimes el tar, `npm install` (instala `expr-eval` además de lo
   anterior), `cp .env.example .env` y rellenas las claves.
2. `npm run setup` (esto ejecuta la migración nueva del schema y reseed).
3. `npm run dev`, login con `demo@agentai.local` / `demo1234`.
4. Creas un nuevo agente "Marta - Comercial" con su personalidad, voz
   distinta, sin script (lo dejas vacío para que solo recoja la decisión)
   o con un script de un único campo "decision" tipo choice.
5. Vas al agente "Photography Receptionist" sembrado:
   - Pestaña Pricing: defines tus variables (event_type, duration_hours,
     etc.) y la fórmula
   - Pestaña Closing: en "Sales Agent Handoff" eliges Marta y escribes la
     bridge phrase
6. Asignas el número Twilio al agente Photography Receptionist.
7. Llamas. Lucía capta los datos. En cuanto da el último dato, oyes la
   bridge phrase y luego entra Marta con la propuesta calculada.

Si algo del cálculo no cuadra, vas a la pestaña Pricing del captador y
usas el botón "🧪 Calculate" con datos de prueba. Iteras la fórmula hasta
que da el número correcto, sin tocar código.
