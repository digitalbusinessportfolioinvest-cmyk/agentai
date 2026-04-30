-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "companyName" TEXT,
    "twilioSid" TEXT,
    "twilioToken" TEXT,
    "elevenlabsKey" TEXT,
    "openrouterKey" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "systemPrompt" TEXT NOT NULL,
    "greetingMessage" TEXT,
    "aiDisclosure" TEXT NOT NULL DEFAULT 'Yes, I''m an AI assistant. I''m here to collect your information accurately so our team can get back to you with a personalized response. If at any point you''d prefer to speak with a person, just let me know.',
    "closingMessage" TEXT,
    "goodbyeMessage" TEXT,
    "channels" TEXT NOT NULL DEFAULT '["voice","whatsapp"]',
    "voiceId" TEXT,
    "voiceName" TEXT,
    "llmModel" TEXT NOT NULL DEFAULT 'openai/gpt-4o-mini',
    "languageOverride" TEXT,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "maxCallDuration" INTEGER NOT NULL DEFAULT 600,
    "whatsappTimeout" INTEGER NOT NULL DEFAULT 1440,
    "fallbackBehavior" TEXT NOT NULL DEFAULT 'take_message',
    "fallbackTransferNumber" TEXT,
    "crossChannelSummary" BOOLEAN NOT NULL DEFAULT true,
    "role" TEXT NOT NULL DEFAULT 'standalone',
    "salesAgentId" TEXT,
    "handoffMessage" TEXT,
    "pricingVariables" TEXT,
    "pricingFormula" TEXT,
    "pricingCurrency" TEXT NOT NULL DEFAULT 'EUR',
    "notifyDashboard" BOOLEAN NOT NULL DEFAULT true,
    "notifyEmail" TEXT,
    "notifyWhatsapp" TEXT,
    "notifyWebhookUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScriptStep" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "promptText" TEXT NOT NULL,
    "dataType" TEXT NOT NULL,
    "choices" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "conditionStepId" TEXT,
    "conditionValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScriptStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneNumber" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT,
    "twilioNumber" TEXT NOT NULL,
    "twilioSid" TEXT,
    "countryCode" TEXT,
    "language" TEXT NOT NULL DEFAULT 'es',
    "channels" TEXT NOT NULL DEFAULT '["voice","whatsapp"]',
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhoneNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT,
    "phoneNumberId" TEXT,
    "linkedConversationId" TEXT,
    "channel" TEXT NOT NULL,
    "twilioCallSid" TEXT,
    "direction" TEXT NOT NULL,
    "remoteNumber" TEXT,
    "language" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "outcome" TEXT,
    "durationSeconds" INTEGER,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "recordingUrl" TEXT,
    "aiConfidence" DOUBLE PRECISION,
    "transcription" TEXT,
    "summary" TEXT,
    "scriptProgress" TEXT,
    "metadata" TEXT,
    "currentRole" TEXT NOT NULL DEFAULT 'intake',
    "calculatedTotal" DOUBLE PRECISION,
    "salesAgentId" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "twilioMessageSid" TEXT,
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationData" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "scriptStepId" TEXT,
    "label" TEXT NOT NULL,
    "value" TEXT,
    "dataType" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "label" TEXT,
    "permissions" TEXT NOT NULL DEFAULT '["read"]',
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_salesAgentId_key" ON "Agent"("salesAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_twilioCallSid_key" ON "Conversation"("twilioCallSid");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_salesAgentId_fkey" FOREIGN KEY ("salesAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptStep" ADD CONSTRAINT "ScriptStep_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptStep" ADD CONSTRAINT "ScriptStep_conditionStepId_fkey" FOREIGN KEY ("conditionStepId") REFERENCES "ScriptStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_phoneNumberId_fkey" FOREIGN KEY ("phoneNumberId") REFERENCES "PhoneNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationData" ADD CONSTRAINT "ConversationData_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationData" ADD CONSTRAINT "ConversationData_scriptStepId_fkey" FOREIGN KEY ("scriptStepId") REFERENCES "ScriptStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
