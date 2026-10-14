export const LLM_MODEL = "llama-3.3-70b-versatile";
export const GEMINI_MODEL = "gemini-2.5-flash";
export const STT_MODEL = "whisper-large-v3";
export const STT_LANGUAGE = "hi";
export const STT_CONFIDENCE_THRESHOLD = 0.55;
export const PENDING_TTL_MINUTES = 30;
export const SUPPORT_TEXT = "Sethji se judne ke liye humse sampark karein.";

export const ENV_KEY_NAMES = [
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
  "WHATSAPP_GRAPH_VERSION",
] as const;

export type EnvKeyName = (typeof ENV_KEY_NAMES)[number];
