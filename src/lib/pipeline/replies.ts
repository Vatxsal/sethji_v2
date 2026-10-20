import { SUPPORT_TEXT } from "@/config";
import { formatBalance, formatPaise } from "@/lib/money";

export function replyNotRegistered(): string {
  return `Aapka number register nahi hua. ${SUPPORT_TEXT}`;
}

export function replyConnected(shopName: string): string {
  return `Namaste ${shopName}, Sethji connected hai.`;
}

export function replyOnlyText(): string {
  return "Abhi main text ya voice note samajh sakta hoon.";
}

export function replyError(): string {
  return "Kuch gadbad ho gayi, dobara bhejein.";
}

export function replyConfirmSendFailed(): string {
  return "Confirm nahi bhej paya, dobara bhejein.";
}

export function replyLast4Only(): string {
  return "Last 4 digits hi bhejein.";
}

export function replyUdhaarNeedsCustomer(): string {
  return "Udhaar kiska? Sirf naam bhejein.";
}

export function replyItemNotInCatalog(itemName: string): string {
  return `${itemName} aapki list me nahi hai. Add karne ke liye: add item ${itemName} <price> rupaye <unit>`;
}

function balanceLine(paise: number): string {
  return paise < 0 ? formatBalance(paise) : `Balance: ${formatPaise(paise)}`;
}

export function formatRupees(paise: number): string {
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

export function replyOrderSummary(input: {
  customerName: string | null;
  lines: string[];
  totalPaise: number;
  paymentMethod: string;
  balancePaise: number | null;
  prefixLine?: string | null;
  splitLine?: string | null;
}): string {
  const who = input.customerName ? `${input.customerName} - ` : "";
  const summary = `${who}${input.lines.join(", ")} - ${formatPaise(input.totalPaise)} - ${input.paymentMethod}`;
  const parts: string[] = [];
  if (input.prefixLine) parts.push(input.prefixLine);
  parts.push(summary);
  if (input.splitLine) parts.push(input.splitLine);
  if (input.paymentMethod === "udhaar" && input.balancePaise !== null) {
    parts.push(balanceLine(input.balancePaise));
  }
  return parts.join("\n");
}

export function replyNotImplemented(): string {
  return "Ye feature abhi shuru nahi hua.";
}

export function replyCustomerNotFound(name: string): string {
  return `${name} naam ka customer nahi mila.`;
}

export function replyPaymentNeedsCustomer(): string {
  return "Kiska payment hai? Naam ke saath bhejein.";
}

export function replyPaymentNeedsAmount(): string {
  return "Kitne mile? Amount rupaye me bhejein.";
}

export function replyPaymentDone(name: string, amountPaise: number, balancePaise: number): string {
  return `${name} se ${formatPaise(amountPaise)} mile. ${balanceLine(balancePaise)}`;
}

export function replyNoBalance(name: string): string {
  return `${name} ka kuch baaki nahi hai.`;
}

export function replyBalance(customerName: string, balancePaise: number): string {
  return `${customerName} ka baaki: ${formatBalance(balancePaise)}`;
}

export function replyShopBalance(
  totalPaise: number,
  top: Array<{ name: string; balancePaise: number }>,
): string {
  if (top.length === 0) return "Abhi kisi ka udhaar nahi hai.";
  const lines = top.map((entry, index) => `${index + 1}) ${entry.name} - ${formatPaise(entry.balancePaise)}`);
  return `Total udhaar: ${formatPaise(totalPaise)}\nSabse zyada:\n${lines.join("\n")}`;
}

export function replyUndoNone(): string {
  return "Abhi kuch undo nahi hai.";
}

export function replyUndoDone(what: string, balancePaise: number): string {
  return `Undo ho gaya: ${what}. ${balanceLine(balancePaise)}`;
}

export function replyAddItem(name: string, pricePaise: number, unit: string): string {
  return `${name} add ho gaya: ${formatPaise(pricePaise)}/${unit}`;
}

export function replyAddItemMissing(): string {
  return "Item ka naam, price aur unit bhejein. Jaise: add item biscuit 10 rupaye packet";
}

export function replyAddItemBadUnit(): string {
  return "Unit samajh nahi aaya. Ye chalte hain: kg, g, l, ml, packet, piece, dozen.";
}

export function replyHelp(): string {
  return [
    "Aise message bhejein:",
    "- 2 kilo atta, 1 chai patti, Rahul udhaar",
    "- Rahul ne 200 diye",
    "- Rahul ka hisaab",
    "- undo",
  ].join("\n");
}

export function replyPickCustomerList(
  entries: Array<{ name: string; disambiguator: string | null; balancePaise: number }>,
  allowNaya = true,
): string {
  const lines = entries.map(
    (entry, index) =>
      `${index + 1}) ${entry.name} ${entry.disambiguator ?? "no digits"} - baaki ${formatPaise(entry.balancePaise)}`,
  );
  const tail = allowNaya
    ? "Last 4 digits ya number bhejein, ya 'naya' likhein."
    : "Last 4 digits ya number bhejein.";
  return `${lines.join("\n")}\n${tail}`;
}

export function replyPickNoMatch(): string {
  return "Ye kisi se match nahi hua. Last 4 digits ya number bhejein.";
}

export function replyNayaOnlyForOrders(): string {
  return "Naya customer sirf order me ban sakta hai. List me se chunein.";
}

export function replyNewCustomerConfirm(name: string, last4: string): string {
  return `Naya customer: ${name} (${last4}). Order uske naam pe save karein?`;
}

export function replyNearMatch(enteredName: string, matchedLabel: string): string {
  return `${enteredName} naam ka customer nahi mila. ${matchedLabel} hai kya?`;
}

export function replyNewCustomerMade(name: string, last4: string | null): string {
  return last4
    ? `Naya customer bana: ${name} (${last4})`
    : `Naya customer bana: ${name}`;
}

export function replyUnitMismatch(itemName: string, catalogUnit: string): string {
  const capitalized = catalogUnit.charAt(0).toUpperCase() + catalogUnit.slice(1);
  return `${itemName} ${catalogUnit} me bikta hai. ${capitalized} me bhejein, jaise: 2 ${catalogUnit} ${itemName.toLowerCase()} swayam udhaar`;
}

export function replyCancelled(): string {
  return "Cancel kar diya.";
}

export function replyConfirmSummary(input: {
  customerName: string | null;
  billLines: string[];
  skipped: string[];
  totalPaise: number;
  paymentMethod: string;
  transcript?: string | null;
  splitLine?: string | null;
  sahi?: boolean;
}): string {
  const who = input.customerName ?? "bina naam";
  const lines = [input.sahi ? `Ye bill sahi hai (${who}):` : `Ye bill hoga (${who}):`];
  for (const line of input.billLines) lines.push(`- ${line}`);
  if (input.skipped.length > 0) lines.push(`Skip: ${input.skipped.join(", ")}`);
  if (input.splitLine) lines.push(input.splitLine);
  lines.push(`Total: ${formatPaise(input.totalPaise)} - ${input.paymentMethod}`);
  if (input.transcript) lines.push(`Voice bola: ${input.transcript}`);
  return lines.join("\n");
}

export function replyConfirmPayment(input: {
  customerName: string;
  amountPaise: number;
  transcript?: string | null;
}): string {
  const lines = ["Ye save karun?", `${input.customerName} ka payment ${formatPaise(input.amountPaise)}`];
  if (input.transcript) lines.push(`Voice bola: ${input.transcript}`);
  return lines.join("\n");
}

export function replyVoiceUnclear(): string {
  return "Awaaz saaf nahi aayi, dobara bhejein.";
}

export function replyNoOrderForBill(): string {
  return "Abhi bill banane ke liye koi order nahi hai.";
}

export function replyInvoiceCaption(
  invoiceNumber: string,
  customerName: string | null,
  totalPaise: number,
): string {
  return `Invoice #${invoiceNumber} - ${customerName ?? "Walk-in"} - ${formatPaise(totalPaise)}`;
}

export function replyPendingExpired(): string {
  return "Ye request purani ho gayi, dobara bhejein.";
}

export function replyExtractionFailed(): string {
  return "Samajh nahi aaya. Aise bhejein: 2 kilo atta Rahul udhaar";
}

export function replyQuantityUnclear(itemName: string): string {
  return `${itemName} ki quantity samajh nahi aayi. Dobara bhejein, jaise: 2 kilo atta`;
}

export function replyWholeUnitsOnly(itemName: string, unit: string): string {
  return `${itemName} ${unit} me bhejein, jaise: 2 ${unit} ${itemName.toLowerCase()}`;
}

export function replySplitPreview(input: {
  totalPaise: number;
  discountPaise: number;
  paidPaise: number;
}): string {
  const parts = [formatPaise(input.totalPaise)];
  if (input.discountPaise > 0) parts.push(`${formatPaise(input.discountPaise)} chhoot`);
  if (input.paidPaise > 0) parts.push(`${formatPaise(input.paidPaise)} diye`);
  const balance = input.totalPaise - input.discountPaise - input.paidPaise;
  const tail = balance > 0 ? `${formatPaise(balance)} baaki` : formatPaise(balance);
  return `${parts.join(" - ")} = ${tail}`;
}

export function replySplitOverTotal(): string {
  return "Diye aur chhoot milkar total se zyada ho gaya. Dobara bhejein.";
}

export function replyEditRequest(): string {
  return "Order edit nahi hota. 'undo' bhejein, phir sahi order dobara bhejein.";
}

export function replyPlanTooManyActions(): string {
  return "Ek message me 5 se zyada kaam nahi le sakta. Thoda alag alag bhejein.";
}

export function replyPlanPreview(input: { transcript: string | null; lines: string[] }): string {
  const out: string[] = [];
  if (input.transcript) out.push(`Maine suna: "${input.transcript}"`);
  input.lines.forEach((line, index) => out.push(`${index + 1}) ${line}`));
  return out.join("\n");
}

export function replyPlanDone(input: { lines: string[]; balances: string[] }): string {
  const out: string[] = [];
  input.lines.forEach((line, index) => out.push(`${index + 1}) ${line}`));
  out.push(...input.balances);
  return out.join("\n");
}

export function replyPlanFailed(): string {
  return "Kuch gadbad hui, kuch save nahi hua.";
}

export function replyPlanBillLine(invoiceNumber: string): string {
  return `Bill #${invoiceNumber} bhej diya`;
}

export function replyPlanBillsCapped(): string {
  return "Ek saath zyada se 2 bill bhej sakta hoon.";
}

export function replyAmountInvalid(): string {
  return "Amount samajh nahi aaya.";
}

export function replyBalanceNoChange(): string {
  return "Balance seedha nahi badla ja sakta. Payment ya undo use karein.";
}

export function replyInvalidName(): string {
  return "Naam samajh nahi aaya. Sirf naam bhejein, jaise: Rahul";
}

export function replyCatalogItemLine(itemName: string, pricePaise: number, unit: string): string {
  return `${itemName} - Rs ${formatRupees(pricePaise)}/${unit}`;
}

export function replyCatalogList(shownLines: string[], totalItems: number): string {
  const lines = [`Aapki list (${totalItems} items):`, ...shownLines];
  const hidden = totalItems - shownLines.length;
  if (hidden > 0) lines.push(`aur ${hidden} items`);
  lines.push("Stock ginti abhi nahi hoti.");
  return lines.join("\n");
}

export function replyShukriya(): string {
  return "Shukriya! Kuch aur ho to bhejein.";
}

export function replyOutOfScope(): string {
  return [
    "Ye abhi main nahi kar sakta. Main ye kar sakta hoon:",
    "2 kilo atta Rahul udhaar",
    "Rahul ne 200 diye",
    "Rahul ka hisaab",
    "Rahul ka bill",
    "undo",
    "item list",
  ].join("\n");
}
