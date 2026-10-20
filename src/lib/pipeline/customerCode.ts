export type CodeDetection = {
  code: string | null;
  badLength: boolean;
  leftName: string | null;
  start: number;
  end: number;
};

const DEVANAGARI_DIGITS: Record<string, string> = {
  "०": "0",
  "१": "1",
  "२": "2",
  "३": "3",
  "४": "4",
  "५": "5",
  "६": "6",
  "७": "7",
  "८": "8",
  "९": "9",
};

export function devanagariDigitsToAscii(text: string): string {
  return text.replace(/[०-९]/g, (digit) => DEVANAGARI_DIGITS[digit] ?? digit);
}

const DIGIT_WORDS: Record<string, number> = {
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
  zero: 0,
  shunya: 0,
  sunya: 0,
  sifar: 0,
  jeero: 0,
  ziro: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  एक: 1,
  दो: 2,
  तीन: 3,
  चार: 4,
  पांच: 5,
  पाँच: 5,
  छह: 6,
  छे: 6,
  सात: 7,
  आठ: 8,
  नौ: 9,
  शून्य: 0,
  ज़ीरो: 0,
  जीरो: 0,
  सिफ़र: 0,
  सिफर: 0,
};

const PAIR_WORDS: Record<string, number> = {
  das: 10,
  gyarah: 11,
  barah: 12,
  terah: 13,
  chaudah: 14,
  pandrah: 15,
  solah: 16,
  satrah: 17,
  atharah: 18,
  unnis: 19,
  bees: 20,
  ikkis: 21,
  bais: 22,
  teais: 23,
  chaubees: 24,
  pachees: 25,
  chhabbees: 26,
  satais: 27,
  athais: 28,
  untis: 29,
  tees: 30,
  ikatti: 31,
  battis: 32,
  tentis: 33,
  chautis: 34,
  paints: 35,
  pentis: 35,
  chattis: 36,
  saintis: 37,
  adtis: 38,
  untalis: 39,
  chalis: 40,
  chantalis: 41,
  bayalis: 42,
  tentalis: 43,
  chautalis: 44,
  paintalis: 45,
  chiyalis: 46,
  saintalis: 47,
  adtalis: 48,
  unchalis: 49,
  pachas: 50,
  iktachas: 51,
  baavan: 52,
  tirpan: 54,
  satavan: 57,
  athavan: 58,
  unsath: 59,
  saath: 60,
  iksath: 61,
  bayasath: 62,
  tirasath: 63,
  chausath: 64,
  painsath: 65,
  chiyasath: 66,
  sattar: 70,
  ikhattar: 71,
  bahattar: 72,
  tihattar: 73,
  pachhattar: 75,
  chihattar: 76,
  assi: 80,
  ikasi: 81,
  bayasi: 82,
  tirasi: 83,
  chaursi: 84,
  pachasi: 85,
  chiyasi: 86,
  satasi: 87,
  athasi: 88,
  nabbe: 90,
  ikyanve: 91,
  baanve: 92,
  tiranve: 93,
  chaunve: 94,
  panchanve: 95,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const MULTIPLIERS: Record<string, number> = {
  sau: 100,
  hazaar: 1000,
  hazar: 1000,
  hundred: 100,
  thousands: 1000,
  thousand: 1000,
};

const UNIT_TOKENS = new Set([
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
  "ml",
  "लीटर",
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
]);

const CURRENCY_TOKENS = new Set([
  "rupaye",
  "rupees",
  "rupya",
  "rupaiya",
  "rs",
  "rs.",
  "paise",
  "paisa",
  "₹",
  "amount",
  "रुपये",
  "रुपया",
  "रूपये",
  "रुपए",
  "रुपयों",
]);

const PAYMENT_TOKENS = new Set([
  "udhaar",
  "udhar",
  "khata",
  "khate",
  "baaki",
  "credit",
  "cash",
  "nagad",
  "nakad",
  "upi",
  "paytm",
  "gpay",
  "phonepe",
  "payment",
  "paid",
  "received",
  "jama",
  "diye",
  "diya",
  "di",
  "de",
  "mile",
  "mila",
  "दिए",
  "दिया",
  "दी",
  "दे",
  "मिले",
]);

const FILLER_TOKENS = new Set([
  "ke",
  "ka",
  "ki",
  "ko",
  "ne",
  "se",
  "mein",
  "mei",
  "me",
  "aur",
  "and",
  "bhi",
  "dono",
  "ji",
  "bhai",
  "please",
  "the",
  "no",
  "number",
  "wala",
  "wali",
  "को",
  "का",
  "के",
  "की",
  "ने",
  "से",
]);

const MARKER_TOKENS = new Set([
  "ko",
  "ka",
  "ke",
  "ki",
  "ne",
  "se",
  "udhaar",
  "udhar",
  "khata",
  "khate",
  "hisaab",
  "baaki",
  "diye",
  "diya",
  "di",
  "de",
  "mile",
  "mila",
  "payment",
  "paid",
  "cash",
  "nagad",
  "nakad",
  "upi",
  "jama",
  "received",
  "को",
  "का",
  "के",
  "की",
  "ने",
  "से",
  "उधार",
  "हिसाब",
  "दिए",
  "दिया",
  "दी",
  "दे",
  "मिले",
]);

const PREFIX_TOKENS = new Set([
  "last",
  "4",
  "four",
  "digits",
  "digit",
  "ends",
  "ending",
  "with",
  "me",
  "wala",
  "wali",
]);

const REPLY_END_FILLERS = new Set(["ji", "bhai", "please", "wala", "wali"]);

type Token = {
  core: string;
  lower: string;
  start: number;
  end: number;
  kind: "digits" | "word";
};

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /[\p{L}\p{M}\p{N}]+/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = match[0];
    const start = match.index;
    const parts = raw.match(/[\p{L}\p{M}]+|[\p{N}]+/gu) ?? [raw];
    let offset = start;
    for (const part of parts) {
      tokens.push({
        core: part,
        lower: part.toLowerCase(),
        start: offset,
        end: offset + part.length,
        kind: /^[\p{N}]+$/u.test(part) ? "digits" : "word",
      });
      offset += part.length;
    }
  }
  return tokens;
}

function isNumberWord(lower: string): boolean {
  return (
    DIGIT_WORDS[lower] !== undefined ||
    PAIR_WORDS[lower] !== undefined ||
    MULTIPLIERS[lower] !== undefined
  );
}

function isNameish(lower: string): boolean {
  if (!lower) return false;
  if (!/[\p{L}]/u.test(lower)) return false;
  if (isNumberWord(lower)) return false;
  if (UNIT_TOKENS.has(lower) || CURRENCY_TOKENS.has(lower) || PAYMENT_TOKENS.has(lower)) return false;
  if (FILLER_TOKENS.has(lower) || MARKER_TOKENS.has(lower)) return false;
  if (PREFIX_TOKENS.has(lower)) return false;
  return true;
}

function isRunToken(token: Token): boolean {
  return token.kind === "digits" || (token.kind === "word" && isNumberWord(token.lower));
}

function pairValue(tokens: Token[]): number | null {
  if (tokens.length === 1) {
    const lower = tokens[0].lower;
    const pair = PAIR_WORDS[lower];
    if (pair !== undefined) return pair;
    return null;
  }
  if (tokens.length === 2) {
    const tens = PAIR_WORDS[tokens[0].lower];
    const unit = DIGIT_WORDS[tokens[1].lower];
    if (tens !== undefined && tens >= 20 && tens <= 90 && tens % 10 === 0 && unit !== undefined) {
      return tens + unit;
    }
  }
  return null;
}

function fullNumberValue(tokens: Token[]): number | null {
  let total = 0;
  let current = 0;
  let sawAnything = false;
  for (const token of tokens) {
    const lower = token.lower;
    const digit = DIGIT_WORDS[lower];
    const pair = PAIR_WORDS[lower];
    const mult = MULTIPLIERS[lower];
    if (digit !== undefined) {
      current += digit;
      sawAnything = true;
      continue;
    }
    if (pair !== undefined) {
      if (current === 0) current = pair;
      else current += pair;
      sawAnything = true;
      continue;
    }
    if (mult !== undefined) {
      const base = current === 0 ? 1 : current;
      total += base * mult;
      current = 0;
      sawAnything = true;
      continue;
    }
    return null;
  }
  if (!sawAnything) return null;
  return total + current;
}

type RunInterpretation = { code: string | null; badLength: boolean };

function interpretDigitRun(tokens: Token[]): RunInterpretation {
  const digits = tokens.map((token) => token.core).join("");
  if (digits.length === 4) return { code: digits, badLength: false };
  if (digits.length === 3 || digits.length === 5) return { code: null, badLength: true };
  return { code: null, badLength: false };
}

function interpretWordRun(tokens: Token[]): RunInterpretation {
  if (tokens.every((token) => DIGIT_WORDS[token.lower] !== undefined)) {
    if (tokens.length === 4) {
      return {
        code: tokens.map((token) => String(DIGIT_WORDS[token.lower])).join(""),
        badLength: false,
      };
    }
    if (tokens.length === 3 || tokens.length === 5) {
      return { code: null, badLength: true };
    }
    return { code: null, badLength: false };
  }
  if (tokens.length >= 2 && tokens.length <= 4) {
    for (let split = 1; split < tokens.length; split++) {
      const left = pairValue(tokens.slice(0, split));
      const right = pairValue(tokens.slice(split));
      if (left !== null && right !== null && left <= 99 && right <= 99) {
        return {
          code: `${String(left).padStart(2, "0")}${String(right).padStart(2, "0")}`,
          badLength: false,
        };
      }
    }
  }
  if (tokens.length >= 1 && tokens.length <= 6) {
    const value = fullNumberValue(tokens);
    if (value !== null && value >= 1000 && value <= 9999) {
      return { code: String(value), badLength: false };
    }
  }
  return { code: null, badLength: false };
}

function interpretRun(tokens: Token[]): RunInterpretation {
  if (tokens.length === 0) return { code: null, badLength: false };
  if (tokens.every((token) => token.kind === "digits")) return interpretDigitRun(tokens);
  if (tokens.every((token) => token.kind === "word" && isNumberWord(token.lower))) {
    return interpretWordRun(tokens);
  }
  return { code: null, badLength: false };
}

function runsOf(tokens: Token[]): Array<{ from: number; to: number }> {
  const runs: Array<{ from: number; to: number }> = [];
  let i = 0;
  while (i < tokens.length) {
    if (!isRunToken(tokens[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < tokens.length && isRunToken(tokens[j])) j++;
    runs.push({ from: i, to: j });
    i = j;
  }
  return runs;
}

function prefixBefore(tokens: Token[], from: number): boolean {
  let i = from - 1;
  const seen: string[] = [];
  while (i >= 0 && seen.length < 4) {
    const lower = tokens[i].lower;
    if (!PREFIX_TOKENS.has(lower)) break;
    seen.push(lower);
    i--;
  }
  if (seen.length === 0) return false;
  return seen.includes("last") || seen.includes("ends") || seen.includes("ending");
}

function emptyDetection(): CodeDetection {
  return { code: null, badLength: false, leftName: null, start: -1, end: -1 };
}

function pickScoping(tokens: Token[], run: { from: number; to: number }, interp: RunInterpretation): CodeDetection {
  const first = tokens[run.from];
  const last = tokens[run.to - 1];
  if (interp.code) {
    return { code: interp.code, badLength: false, leftName: null, start: first.start, end: last.end };
  }
  if (interp.badLength) {
    return { code: null, badLength: true, leftName: null, start: first.start, end: last.end };
  }
  return emptyDetection();
}

function messageScoping(tokens: Token[], run: { from: number; to: number }, interp: RunInterpretation): CodeDetection {
  const first = tokens[run.from];
  const last = tokens[run.to - 1];
  const prev = run.from > 0 ? tokens[run.from - 1] : null;
  const next = run.to < tokens.length ? tokens[run.to] : null;

  if (next && UNIT_TOKENS.has(next.lower)) return emptyDetection();
  if (next && CURRENCY_TOKENS.has(next.lower)) return emptyDetection();
  if (prev && UNIT_TOKENS.has(prev.lower)) return emptyDetection();
  if (prev && CURRENCY_TOKENS.has(prev.lower)) return emptyDetection();

  const nextOk =
    next === null ||
    next.kind === "digits" ||
    MARKER_TOKENS.has(next.lower) ||
    REPLY_END_FILLERS.has(next.lower) ||
    isNameish(next.lower);

  let leftName: string | null = null;
  let ok = false;

  if (prev && isNameish(prev.lower) && nextOk) {
    ok = true;
    leftName = prev.core;
  } else if (prefixBefore(tokens, run.from)) {
    ok = true;
  } else if (next && next.lower === "wala" && run.to + 1 < tokens.length) {
    const nameToken = tokens[run.to + 1];
    if (nameToken && isNameish(nameToken.lower)) {
      ok = true;
      leftName = nameToken.core;
    }
  } else if (next && isNameish(next.lower)) {
    const afterName = run.to + 1 < tokens.length ? tokens[run.to + 1] : null;
    if (afterName === null || MARKER_TOKENS.has(afterName.lower) || afterName.lower === "wala") {
      ok = true;
      leftName = next.core;
    }
  }

  if (!ok) return emptyDetection();

  if (interp.code) {
    return { code: interp.code, badLength: false, leftName, start: first.start, end: last.end };
  }
  if (interp.badLength) {
    return { code: null, badLength: true, leftName, start: first.start, end: last.end };
  }
  return emptyDetection();
}

function scopeRun(
  tokens: Token[],
  run: { from: number; to: number },
  interp: RunInterpretation,
  mode: "message" | "pick",
): CodeDetection {
  return mode === "pick" ? pickScoping(tokens, run, interp) : messageScoping(tokens, run, interp);
}

function oversizedDigitPrefixDetection(
  tokens: Token[],
  run: { from: number; to: number },
  mode: "message" | "pick",
): CodeDetection {
  // e.g. "rahul 3210 2 kilo atta" -> run [3210, 2]; try the 4-digit prefix as the code
  let digits = 0;
  let end = run.from;
  while (end < run.to && digits + tokens[end].core.length <= 4) {
    digits += tokens[end].core.length;
    end++;
  }
  if (digits !== 4 || end === run.from) return emptyDetection();
  const prefixRun = { from: run.from, to: end };
  const interp = interpretRun(tokens.slice(prefixRun.from, prefixRun.to));
  if (!interp.code) return emptyDetection();
  return scopeRun(tokens, prefixRun, interp, mode);
}

export function detectCustomerCode(rawText: string, mode: "message" | "pick"): CodeDetection {
  const text = devanagariDigitsToAscii(rawText ?? "");
  if (!text) return emptyDetection();
  const tokens = tokenize(text);
  if (tokens.length === 0) return emptyDetection();

  for (const run of runsOf(tokens)) {
    const runTokens = tokens.slice(run.from, run.to);
    const digitCount = runTokens
      .filter((token) => token.kind === "digits")
      .reduce((sum, token) => sum + token.core.length, 0);
    const allDigits = runTokens.every((token) => token.kind === "digits");

    if (allDigits && digitCount > 4) {
      const next = run.to < tokens.length ? tokens[run.to] : null;
      const nextIsQuantityish =
        next !== null && (UNIT_TOKENS.has(next.lower) || CURRENCY_TOKENS.has(next.lower));
      if (nextIsQuantityish) {
        const prefix = oversizedDigitPrefixDetection(tokens, run, mode);
        if (prefix.code || prefix.badLength) return prefix;
        continue;
      }
      // e.g. "rahul 12345 ko" -> 5 digits straight in code position
      const badRun = { from: run.from, to: run.to };
      const scoped =
        mode === "pick"
          ? pickScoping(tokens, badRun, { code: null, badLength: true })
          : messageScoping(tokens, badRun, { code: null, badLength: true });
      if (scoped.badLength) return scoped;
      continue;
    }

    const interp = interpretRun(runTokens);
    if (!interp.code && !interp.badLength) continue;
    const detection = scopeRun(tokens, run, interp, mode);
    if (detection.code || detection.badLength) return detection;
  }
  return emptyDetection();
}

export function canonicalizeCustomerCodes(rawText: string): string {
  const text = devanagariDigitsToAscii(rawText ?? "");
  if (!text) return text;
  const tokens = tokenize(text);
  if (tokens.length === 0) return text;

  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const run of runsOf(tokens)) {
    const runTokens = tokens.slice(run.from, run.to);
    const digitCount = runTokens
      .filter((token) => token.kind === "digits")
      .reduce((sum, token) => sum + token.core.length, 0);
    const allDigits = runTokens.every((token) => token.kind === "digits");
    if (allDigits && digitCount > 4) {
      const prefix = oversizedDigitPrefixDetection(tokens, run, "message");
      if (prefix.code) {
        replacements.push({ start: prefix.start, end: prefix.end, value: prefix.code });
      }
      continue;
    }
    const interp = interpretRun(runTokens);
    if (!interp.code) continue;
    const detection = messageScoping(tokens, run, interp);
    if (!detection.code) continue;
    replacements.push({ start: detection.start, end: detection.end, value: detection.code });
  }
  if (replacements.length === 0) return text;

  let out = "";
  let cursor = 0;
  for (const replacement of replacements) {
    out += text.slice(cursor, replacement.start) + replacement.value;
    cursor = replacement.end;
  }
  out += text.slice(cursor);
  return out;
}
