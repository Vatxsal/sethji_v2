import { ENV_KEY_NAMES } from "@/config";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result: Record<string, boolean> = {};

  for (const key of ENV_KEY_NAMES) {
    const value = process.env[key];
    result[key] = value !== undefined && value.trim() !== "";
  }

  let db = false;
  try {
    const { getSupabase } = await import("@/lib/supabase");
    const { error } = await getSupabase().from("shops").select("id").limit(1);
    db = !error;
    if (error) log(null, "health_db", { error });
  } catch (error) {
    db = false;
    log(null, "health_db", { error });
  }

  return Response.json({ ...result, db });
}
