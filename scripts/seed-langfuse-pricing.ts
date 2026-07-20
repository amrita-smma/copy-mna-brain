const logger = console;

const LANGFUSE_URL = process.env.LANGFUSE_BASE_URL || "http://localhost:3030";
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || "pk-lf-1234567890";
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || "sk-lf-1234567890";

const modelsToSeed = [
  {
    modelName: "claude-sonnet-5",
    matchPattern: "(?i)^(claude-sonnet-5)(-[a-zA-Z0-9]+)?$",
    startDate: "2026-01-01",
    unit: "TOKENS",
    inputPrice: 0.000003,
    outputPrice: 0.000015,
    prices: {
      input: 0.000003,
      output: 0.000015,
      cache_creation_input_tokens: 0.00000375,
      cache_read_input_tokens: 0.0000003
    },
    tokenizerId: "claude",
  },
  {
    modelName: "claude-haiku-4-5-20251001",
    matchPattern: "(?i)^(claude-haiku-4-5-20251001)$",
    startDate: "2025-10-01",
    unit: "TOKENS",
    inputPrice: 0.00000025,
    outputPrice: 0.00000125,
    prices: {
      input: 0.00000025,
      output: 0.00000125,
      cache_creation_input_tokens: 0.0000003,
      cache_read_input_tokens: 0.00000003
    },
    tokenizerId: "claude",
  },
  {
    modelName: "claude-opus-4-7",
    matchPattern: "(?i)^(claude-opus-4-7)(-[a-zA-Z0-9]+)?$",
    startDate: "2026-01-01",
    unit: "TOKENS",
    inputPrice: 0.000005,
    outputPrice: 0.000025,
    prices: {
      input: 0.000005,
      output: 0.000025,
      cache_creation_input_tokens: 0.00000625,
      cache_read_input_tokens: 0.0000005
    },
    tokenizerId: "claude",
  },
  {
    modelName: "claude-opus-4-8",
    matchPattern: "(?i)^(claude-opus-4-8)(-[a-zA-Z0-9]+)?$",
    startDate: "2026-01-01",
    unit: "TOKENS",
    inputPrice: 0.000005,
    outputPrice: 0.000025,
    prices: {
      input: 0.000005,
      output: 0.000025,
      cache_creation_input_tokens: 0.00000625,
      cache_read_input_tokens: 0.0000005
    },
    tokenizerId: "claude",
  },
  {
    modelName: "claude-fable-5",
    matchPattern: "(?i)^(claude-fable-5)(-[a-zA-Z0-9]+)?$",
    startDate: "2026-01-01",
    unit: "TOKENS",
    inputPrice: 0.00001,
    outputPrice: 0.00005,
    prices: {
      input: 0.00001,
      output: 0.00005,
      cache_creation_input_tokens: 0.0000125,
      cache_read_input_tokens: 0.000001
    },
    tokenizerId: "claude",
  }
];

async function seedModels() {
  logger.info(`Seeding Langfuse models at ${LANGFUSE_URL}...`);

  const authHeader = `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`;

  for (const model of modelsToSeed) {
    try {
      const response = await fetch(`${LANGFUSE_URL}/api/public/models`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify(model),
      });

      if (!response.ok) {
        const errorText = await response.text();
        // Langfuse returns 409 or similar if model already exists, which is fine
        if (response.status === 409 || errorText.includes("already exists")) {
          logger.info(`✅ Model ${model.modelName} already exists, skipping.`);
        } else {
          logger.error(`❌ Failed to create model ${model.modelName}: ${response.status} ${errorText}`);
        }
      } else {
        logger.info(`🎉 Successfully seeded model ${model.modelName}`);
      }
    } catch (error) {
      logger.error(`❌ Error seeding model ${model.modelName}: ${error}`);
    }
  }

  logger.info("Done seeding Langfuse pricing!");
}

seedModels().catch(console.error);
