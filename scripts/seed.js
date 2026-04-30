const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();

async function seed() {
  console.log('Seeding database...');

  // Create demo user
  const passwordHash = await bcrypt.hash('demo1234', 10);
  const user = await prisma.user.upsert({
    where: { email: 'demo@agentai.local' },
    update: {},
    create: {
      email: 'demo@agentai.local',
      passwordHash,
      companyName: 'AgentAi Demo'
    }
  });
  console.log(`User: ${user.email} (password: demo1234)`);

  // Create sample agent — Photography Service
  const agent = await prisma.agent.upsert({
    where: { id: 'demo-agent-photo' },
    update: {},
    create: {
      id: 'demo-agent-photo',
      userId: user.id,
      name: 'Photography Receptionist',
      description: 'AI receptionist for an urgent photography service',
      systemPrompt: `You are the virtual receptionist for an urgent photography service. You are professional, warm, and efficient. Your job is to collect information from potential clients so that the team can prepare a quote.

Key behavior:
- Be friendly but professional
- Don't make promises about pricing — say the team will prepare a personalized quote
- If the client asks about prices, say it depends on the specifics and that's why you need to collect some details
- Confirm each piece of information naturally as you collect it
- At the end, confirm all details and let them know the team will be in touch shortly with a quote`,
      channels: '["voice","whatsapp"]',
      llmModel: 'openai/gpt-4o-mini',
      temperature: 0.7,
      greetingMessage: "Hi! Thanks for reaching out to our photography service. I'm the virtual assistant and I'm here to help you. Could you tell me what type of event or project you need a photographer for?",
      aiDisclosure: "Yes, I'm an AI assistant for the photography team. I'm here to collect your details so we can prepare a personalized quote for you. If you'd prefer to speak with someone from the team directly, just let me know.",
      closingMessage: "I have all the details I need. Our team will review your request and prepare a personalized quote. We'll get back to you shortly. Is there anything else you'd like to add?",
      goodbyeMessage: 'Thank you for your time. We look forward to working with you!',
      isActive: true
    }
  });
  console.log(`Agent: ${agent.name}`);

  // Create script steps for the photography agent
  const steps = [
    { label: 'event_type', promptText: 'What type of event or project is this for?', dataType: 'choice',
      choices: JSON.stringify(['wedding', 'corporate', 'portrait', 'product', 'real_estate', 'event', 'other']) },
    { label: 'date', promptText: 'When is the event or when do you need the photographer?', dataType: 'date' },
    { label: 'location', promptText: 'Where will it take place?', dataType: 'text' },
    { label: 'duration', promptText: 'How many hours of coverage do you need approximately?', dataType: 'number' },
    { label: 'special_requirements', promptText: 'Any special requirements? (drone, studio, editing, specific style)', dataType: 'text', isRequired: false },
    { label: 'name', promptText: 'May I have your name?', dataType: 'text' },
    { label: 'email', promptText: 'What email should we send the quote to?', dataType: 'email' },
    { label: 'phone', promptText: 'And a phone number in case we need to reach you?', dataType: 'phone', isRequired: false }
  ];

  // Delete existing steps first
  await prisma.scriptStep.deleteMany({ where: { agentId: agent.id } });

  for (let i = 0; i < steps.length; i++) {
    await prisma.scriptStep.create({
      data: {
        agentId: agent.id,
        stepOrder: i + 1,
        label: steps[i].label,
        promptText: steps[i].promptText,
        dataType: steps[i].dataType,
        choices: steps[i].choices || null,
        isRequired: steps[i].isRequired !== false
      }
    });
  }
  console.log(`Script: ${steps.length} steps created`);

  console.log('\n--- Demo Ready ---');
  console.log('Login: demo@agentai.local / demo1234');
  console.log('Agent: Photography Receptionist');
  console.log('\nNext steps:');
  console.log('1. Add your Twilio number in the dashboard');
  console.log('2. Point Twilio webhooks to your ngrok URL');
  console.log('3. Test by calling or WhatsApping the number');
}

seed()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
