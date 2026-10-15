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

export function replyUdhaarNeedsCustomer(): string {
  return "Udhaar kiska? Sirf naam bhejein.";
}

export function replyItemNotInCatalog(itemName: string): string {
  return `${itemName} aapki list me nahi hai. Add karne ke liye: add item ${itemName} <price> rupaye <unit>`;
}

export function replyOrderSummary(input: {
  customerName: string | null;
  lines: string[];
  totalPaise: number;
  paymentMethod: string;
  balancePaise: number | null;
}): string {
  const who = input.customerName ? `${input.customerName} - ` : "";
  const summary = `${who}${input.lines.join(", ")} - ${formatPaise(input.totalPaise)} - ${input.paymentMethod}`;
  if (input.paymentMethod === "udhaar" && input.balancePaise !== null) {
    return `${summary}\nBalance: ${formatBalance(input.balancePaise)}`;
  }
  return summary;
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
  return `${name} se ${formatPaise(amountPaise)} mile. Balance: ${formatBalance(balancePaise)}`;
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
  return `Undo ho gaya: ${what}. Balance: ${formatBalance(balancePaise)}`;
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
): string {
  const lines = entries.map(
    (entry, index) =>
      `${index + 1}) ${entry.name} ${entry.disambiguator ?? "no digits"} - baaki ${formatPaise(entry.balancePaise)}`,
  );
  return `${lines.join("\n")}\nLast 4 digits ya number bhejein, ya 'naya' likhein.`;
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
}): string {
  const who = input.customerName ?? "bina naam";
  const lines = [`Ye bill hoga (${who}):`];
  for (const line of input.billLines) lines.push(`- ${line}`);
  if (input.skipped.length > 0) lines.push(`Skip: ${input.skipped.join(", ")}`);
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

export function replyOneThing(): string {
  return "Ek message me ek customer aur ek kaam bhejein. Alag alag bhejein.";
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
