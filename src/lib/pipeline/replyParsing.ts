import { normalizeNumbers } from "./numbers";

export type PickReply =
  | { type: "index"; value: number }
  | { type: "last4"; value: string }
  | { type: "new" }
  | { type: "none" };

const PICK_FILLERS = new Set(["number", "no", "wala", "wali", "ji", "bhai", "please"]);

const ORDINALS: Record<string, number> = {
  pehla: 1,
  pehli: 1,
  first: 1,
  doosra: 2,
  dusra: 2,
  doosri: 2,
  dusri: 2,
  second: 2,
  teesra: 3,
  teesri: 3,
  third: 3,
  chautha: 4,
  chauthi: 4,
  fourth: 4,
};

const YES_WORDS = new Set(["haan", "ha", "yes", "ok", "okay", "sahi"]);
const YES_PHRASES = new Set(["theek hai", "save kar do"]);
const NO_WORDS = new Set(["nahi", "no", "cancel", "ruko", "mat"]);
const NO_PHRASES = new Set(["rehne do"]);

const YESNO_FILLERS = new Set(["ji", "bhai", "please", "kar", "kardo", "do"]);

function stripFillers(text: string, fillers: Set<string>): string {
  return text
    .split(/\s+/)
    .filter((word) => word !== "" && !fillers.has(word))
    .join(" ");
}

function stripNoise(text: string): string {
  return text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parsePickReply(raw: string, candidateCount: number): PickReply {
  const cleaned = stripNoise(normalizeNumbers(raw));
  if (cleaned === "") return { type: "none" };

  const words = cleaned.toLowerCase().split(/\s+/).filter(Boolean);
  const kept = stripFillers(words.join(" "), PICK_FILLERS).toLowerCase();
  const finalWords = kept === "" ? [] : kept.split(" ");

  if (finalWords.length === 1) {
    const word = finalWords[0];
    if (/^\d{4}$/.test(word)) return { type: "last4", value: word };
    if (/^\d{1,2}$/.test(word)) {
      const value = Number(word);
      if (value >= 1 && value <= candidateCount) return { type: "index", value };
      return { type: "none" };
    }
    if (word === "naya" || word === "new") return { type: "new" };
    const ordinal = ORDINALS[word];
    if (ordinal !== undefined) {
      if (ordinal >= 1 && ordinal <= candidateCount) return { type: "index", value: ordinal };
      return { type: "none" };
    }
  }

  return { type: "none" };
}

export function parseYesNo(raw: string): "yes" | "no" | "none" {
  const cleaned = stripNoise(raw).toLowerCase();
  if (cleaned === "") return "none";

  if (YES_WORDS.has(cleaned) || YES_PHRASES.has(cleaned)) return "yes";
  if (NO_WORDS.has(cleaned) || NO_PHRASES.has(cleaned)) return "no";

  const stripped = stripFillers(cleaned, YESNO_FILLERS).toLowerCase();
  if (stripped !== "" && (YES_WORDS.has(stripped) || YES_PHRASES.has(stripped))) return "yes";
  if (stripped !== "" && (NO_WORDS.has(stripped) || NO_PHRASES.has(stripped))) return "no";

  return "none";
}
