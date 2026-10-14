import { z } from "zod";

const REQUIRED_KEYS = [
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

const envSchema = z.object({
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().min(1),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
  GROQ_API_KEY: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  WHATSAPP_GRAPH_VERSION: z
    .string()
    .min(1)
    .default("v23.0"),
});

export type Env = z.infer<typeof envSchema>;

function buildEnv(): Env {
  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    const value = process.env[key];
    if (value !== undefined && value.trim() !== "") raw[key] = value;
  }

  for (const key of REQUIRED_KEYS) {
    if (raw[key] === undefined) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const name = issue ? String(issue.path[0]) : "unknown";
    throw new Error(`Invalid environment variable: ${name}`);
  }
  return parsed.data;
}

let cached: Env | null = null;

function getEnv(): Env {
  if (!cached) cached = buildEnv();
  return cached;
}

export const env: Env = new Proxy({} as Env, {
  get(_target, prop) {
    return getEnv()[prop as keyof Env];
  },
  has(_target, prop) {
    return prop in getEnv();
  },
  ownKeys() {
    return Reflect.ownKeys(getEnv());
  },
  getOwnPropertyDescriptor(_target, prop) {
    const value = getEnv()[prop as keyof Env];
    return { configurable: true, enumerable: true, value };
  },
});
