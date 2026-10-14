import { Groq, toFile } from "groq-sdk";

import { STT_LANGUAGE, STT_MODEL } from "@/config";
import { env } from "@/env";
import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";

export type SttResult = {
  transcript: string;
  confidence: number | null;
};

type VerboseSegment = { avg_logprob?: number | null };

type VerboseTranscription = {
  text: string;
  segments?: VerboseSegment[] | null;
};

export async function saveVoiceNote(
  shopId: string,
  messageId: string,
  buffer: Buffer,
): Promise<void> {
  try {
    const { error } = await getSupabase()
      .storage.from("voice-notes")
      .upload(`${shopId}/${messageId}.ogg`, buffer, {
        contentType: "audio/ogg",
        upsert: true,
      });
    if (error) throw error;
    log(messageId, "media", { shopId, bytes: buffer.length });
  } catch (error) {
    log(messageId, "media_error", { error });
  }
}

export async function transcribeVoice(buffer: Buffer, msgId: string): Promise<SttResult> {
  const groq = new Groq({ apiKey: env.GROQ_API_KEY });

  const response = (await groq.audio.transcriptions.create({
    file: await toFile(buffer, "voice.ogg"),
    model: STT_MODEL,
    language: STT_LANGUAGE,
    response_format: "verbose_json",
    temperature: 0,
    prompt: "Rahul ko 2 kilo atta, 1 chai patti, udhaar. Hinglish Roman script mein.",
  })) as unknown as VerboseTranscription;

  const transcript = (response.text ?? "").trim();
  const avgLogs = (response.segments ?? [])
    .map((segment) => segment.avg_logprob)
    .filter((value): value is number => typeof value === "number");
  const confidence =
    avgLogs.length > 0 ? Math.exp(avgLogs.reduce((sum, value) => sum + value, 0) / avgLogs.length) : null;

  log(msgId, "stt", { transcript, confidence });
  return { transcript, confidence };
}
