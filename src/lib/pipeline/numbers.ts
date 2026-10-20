import { canonicalizeCustomerCodes } from "./customerCode";

const CARDINALS: Record<string, number> = {
  ek: 1,
  do: 2,
  teen: 3,
  char: 4,
  chaar: 4,
  panch: 5,
  paanch: 5,
  chhe: 6,
  che: 6,
  chah: 6,
  saat: 7,
  aath: 8,
  nau: 9,
  das: 10,
  gyarah: 11,
  barah: 12,
  terah: 13,
  chaudah: 14,
  pandrah: 15,
  bees: 20,
  pachees: 25,
  tees: 30,
  chalis: 40,
  pachas: 50,
  saath: 60,
  assi: 80,
  nabbe: 90,
  sau: 100,
  hazaar: 1000,
  hazar: 1000,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const FRACTIONS: Record<string, number> = {
  aadha: 0.5,
  adha: 0.5,
  half: 0.5,
  paav: 0.25,
  pav: 0.25,
  quarter: 0.25,
  dedh: 1.5,
  dhai: 2.5,
};

const MODIFIERS = new Set(["paune", "saadhe", "sawa"]);

const QTY_CONTEXT = new Set([
  "kilo",
  "kg",
  "kgs",
  "kilogram",
  "kilograms",
  "किलो",
  "gram",
  "gm",
  "ग्राम",
  "litre",
  "liter",
  "ltr",
  "l",
  "लीटर",
  "ml",
  "packet",
  "pkt",
  "pack",
  "पैकेट",
  "piece",
  "pc",
  "pcs",
  "nag",
  "dozen",
  "darjan",
  "sau",
  "hazaar",
  "rupaye",
  "rupees",
  "rupya",
  "rs",
]);

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(parseFloat(value.toFixed(2)));
}

function accumulate(values: number[]): number {
  let result = 0;
  let current = 0;
  for (const value of values) {
    if (value >= 100) {
      current = (current || 1) * value;
    } else {
      if (current >= 100) {
        result += current;
        current = 0;
      }
      current += value;
    }
  }
  return result + current;
}

type Tok = {
  raw: string;
  pre: string;
  core: string;
  post: string;
  kind: "text" | "num" | "drop";
  value: number;
  singleDigit: boolean;
  display: string | null;
  consumed: boolean;
  groupable: boolean;
};

function parseCore(token: string): { pre: string; core: string; post: string } | null {
  const m = token.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}]+)([^\p{L}\p{N}]*)$/u);
  if (!m) return null;
  return { pre: m[1], core: m[2], post: m[3] };
}

function neighborCore(parts: string[], tokenIndex: number, step: number): string | null {
  const idx = tokenIndex + step * 2;
  if (idx < 0 || idx >= parts.length) return null;
  const parsed = parseCore(parts[idx]);
  if (!parsed) return null;
  return parsed.core.toLowerCase();
}

function textTok(raw: string): Tok {
  const parsed = parseCore(raw);
  return {
    raw,
    pre: parsed?.pre ?? "",
    core: parsed?.core ?? raw,
    post: parsed?.post ?? "",
    kind: "text",
    value: 0,
    singleDigit: false,
    display: null,
    consumed: false,
    groupable: false,
  };
}

export function normalizeNumbers(text: string, catalogNames: string[] = []): string {
  if (!text) return text;
  const src = canonicalizeCustomerCodes(text);
  const parts = src.split(/(\s+)/);

  const catalogWords = new Set<string>();
  for (const name of catalogNames) {
    for (const word of name.toLowerCase().split(/\s+/)) {
      if (word) catalogWords.add(word);
    }
  }

  const nonEmptyCount = parts.filter((part, index) => index % 2 === 0 && part.trim() !== "").length;

  const tokens: Tok[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const raw = parts[i];
    if (raw.trim() === "") {
      tokens.push(textTok(raw));
      continue;
    }
    const parsed = parseCore(raw);
    if (!parsed) {
      tokens.push(textTok(raw));
      continue;
    }
    const { pre, core, post } = parsed;
    const lower = core.toLowerCase();
    const base = { raw, pre, core, post, display: null, consumed: false };

    if (/^\d+$/.test(core)) {
      const value = Number(core);
      tokens.push({
        ...base,
        kind: "num",
        value,
        singleDigit: Number.isInteger(value) && value >= 0 && value <= 9,
        groupable: true,
        display: core,
      });
      continue;
    }
    if (lower === "number" || lower === "numbers") {
      tokens.push({ ...base, kind: "drop", value: 0, singleDigit: false, groupable: false });
      continue;
    }
    if (FRACTIONS[lower] !== undefined) {
      tokens.push({
        ...base,
        kind: "num",
        value: FRACTIONS[lower],
        singleDigit: false,
        groupable: true,
      });
      continue;
    }
    if (MODIFIERS.has(lower)) {
      tokens.push({ ...base, kind: "text", value: 0, singleDigit: false, groupable: false });
      continue;
    }
    if (CARDINALS[lower] !== undefined) {
      const value = CARDINALS[lower];
      if (lower === "do" && nonEmptyCount > 1) {
        const nextCore = neighborCore(parts, i, 1);
        const qtyNext = nextCore !== null && (QTY_CONTEXT.has(nextCore) || catalogWords.has(nextCore));
        if (!qtyNext) {
          tokens.push({ ...base, kind: "text", value: 0, singleDigit: false, groupable: false });
          continue;
        }
      }
      tokens.push({
        ...base,
        kind: "num",
        value,
        singleDigit: value >= 0 && value <= 9 && Number.isInteger(value),
        groupable: true,
      });
      continue;
    }
    tokens.push({ ...base, kind: "text", value: 0, singleDigit: false, groupable: false });
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind !== "text") continue;
    const lower = tok.core.toLowerCase();
    if (MODIFIERS.has(lower)) {
      const next = tokens[i + 1];
      const nextNum =
        next && !next.consumed && next.kind === "num" && next.groupable && Number.isFinite(next.value)
          ? next
          : null;
      if (lower === "paune") {
        tok.kind = "num";
        tok.value = nextNum ? nextNum.value - 0.25 : 0.75;
      } else if (lower === "saadhe") {
        tok.kind = "num";
        tok.value = nextNum ? nextNum.value + 0.5 : 1.5;
      } else {
        tok.kind = "num";
        tok.value = nextNum ? nextNum.value + 0.25 : 1.25;
      }
      if (nextNum) nextNum.consumed = true;
      continue;
    }
    if (lower === "double") {
      const next = tokens[i + 1];
      if (next && !next.consumed && next.kind === "num" && next.singleDigit) {
        const digit = String(next.value);
        tok.kind = "num";
        tok.value = next.value;
        tok.display = digit + digit;
        next.consumed = true;
      }
    }
  }

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.kind === "num" && !tok.consumed && tok.groupable) {
      const run: Tok[] = [];
      let j = i;
      while (j < tokens.length) {
        const next = tokens[j];
        if (next.consumed) {
          j++;
          continue;
        }
        if (next.kind === "num" && next.groupable) {
          run.push(next);
          j++;
          continue;
        }
        break;
      }
      if (run.length > 1) {
        if (run.length === 4 && run.every((entry) => entry.singleDigit)) {
          run[0].display = run.map((entry) => String(entry.value)).join("");
          for (let k = 1; k < run.length; k++) run[k].consumed = true;
        } else {
          run[0].value = accumulate(run.map((entry) => entry.value));
          run[0].display = null;
          run[0].singleDigit = false;
          for (let k = 1; k < run.length; k++) run[k].consumed = true;
        }
      }
      i = j;
    } else {
      i++;
    }
  }

  let out = "";
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    let piece: string | null = null;
    if (tok.kind === "num" && !tok.consumed) {
      piece = tok.pre + (tok.display ?? formatNumber(tok.value)) + tok.post;
    } else if (tok.kind === "text") {
      piece = tok.raw;
    }
    if (piece !== null) out += piece;
    const sep = parts[k * 2 + 1];
    if (sep !== undefined && piece !== null) out += sep;
  }

  return out
    .replace(/(\d)[.!?]+$/u, "$1")
    .trim();
}
