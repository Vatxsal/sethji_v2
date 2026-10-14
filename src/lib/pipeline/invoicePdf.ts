import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";

export type InvoicePdfLine = {
  itemName: string;
  quantity: number;
  unit: string;
  unitPricePaise: number;
  lineTotalPaise: number;
  gstRatePercent: number;
  taxablePaise: number;
  gstPaise: number;
};

export type InvoicePdfData = {
  shopName: string;
  shopAddress: string | null;
  shopGstin: string | null;
  invoiceNumber: string;
  dateLabel: string;
  customerName: string | null;
  lines: InvoicePdfLine[];
  totalPaise: number;
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 44;

function rupees(paise: number): string {
  const hasPaise = paise % 100 !== 0;
  return `Rs. ${(paise / 100).toFixed(hasPaise ? 2 : 0)}`;
}

function sanitize(text: string): string {
  return text
    .replace(/₹/g, "Rs.")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\u0020-\u007E\u00A0-\u00FF]/g, "");
}

function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const clean = sanitize(text);
  if (font.widthOfTextAtSize(clean, size) <= maxWidth) return clean;
  let out = clean;
  while (out.length > 0 && font.widthOfTextAtSize(`${out}...`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

function taxSummary(lines: InvoicePdfLine[]): Array<{
  rate: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
}> {
  const byRate = new Map<number, { taxablePaise: number; cgstPaise: number; sgstPaise: number }>();
  for (const line of lines) {
    const entry = byRate.get(line.gstRatePercent) ?? { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 };
    entry.taxablePaise += line.taxablePaise;
    entry.cgstPaise += Math.floor(line.gstPaise / 2);
    entry.sgstPaise += line.gstPaise - Math.floor(line.gstPaise / 2);
    byRate.set(line.gstRatePercent, entry);
  }
  return [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, entry]) => ({ rate, ...entry }));
}

export async function buildInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([PAGE_W, PAGE_H]);

  const rightEdge = PAGE_W - MARGIN;
  let y = PAGE_H - MARGIN;

  const draw = (
    text: string,
    x: number,
    opts: { size?: number; bold?: boolean; maxWidth?: number } = {},
  ): void => {
    const size = opts.size ?? 9;
    const active = opts.bold ? bold : font;
    const value = opts.maxWidth ? fit(text, active, size, opts.maxWidth) : sanitize(text);
    page.drawText(value, { x, y, size, font: active });
  };

  const drawRight = (text: string, right: number, opts: { size?: number; bold?: boolean } = {}): void => {
    const size = opts.size ?? 9;
    const active = opts.bold ? bold : font;
    const value = sanitize(text);
    page.drawText(value, {
      x: right - active.widthOfTextAtSize(value, size),
      y,
      size,
      font: active,
    });
  };

  draw(data.shopName, MARGIN, { size: 16, bold: true });
  y -= 16;
  if (data.shopAddress) {
    draw(data.shopAddress, MARGIN, { size: 9, maxWidth: rightEdge - MARGIN });
    y -= 13;
  }
  if (data.shopGstin) {
    draw(`GSTIN: ${data.shopGstin}`, MARGIN, { size: 9 });
    y -= 13;
  }

  y -= 20;
  draw("Invoice", MARGIN, { size: 11, bold: true });
  draw("Customer", PAGE_W / 2, { size: 11, bold: true });
  y -= 15;
  draw(`No: ${data.invoiceNumber}`, MARGIN, { size: 9 });
  draw(data.customerName ?? "Walk-in", PAGE_W / 2, {
    size: 9,
    maxWidth: rightEdge - PAGE_W / 2,
  });
  y -= 13;
  draw(`Date: ${data.dateLabel}`, MARGIN, { size: 9 });

  y -= 26;
  const colQty = MARGIN + 250;
  const colRate = MARGIN + 330;
  draw("Item", MARGIN, { size: 9.5, bold: true });
  draw("Qty", colQty, { size: 9.5, bold: true });
  draw("Rate", colRate, { size: 9.5, bold: true });
  drawRight("Amount", rightEdge, { size: 9.5, bold: true });
  y -= 6;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: rightEdge, y },
    thickness: 1,
  });

  y -= 14;
  for (const line of data.lines) {
    draw(`${line.itemName} `, MARGIN, { size: 9, maxWidth: 240 });
    draw(`${line.quantity} ${line.unit}`, colQty, { size: 9 });
    draw(rupees(line.unitPricePaise), colRate, { size: 9 });
    drawRight(rupees(line.lineTotalPaise), rightEdge, { size: 9 });
    y -= 14;
  }

  const summary = taxSummary(data.lines);
  const taxableTotal = data.lines.reduce((sum, line) => sum + line.taxablePaise, 0);
  const cgstTotal = summary.reduce((sum, row) => sum + row.cgstPaise, 0);
  const sgstTotal = summary.reduce((sum, row) => sum + row.sgstPaise, 0);

  y -= 12;
  const totalsLeft = PAGE_W / 2 + 20;
  const labelWidth = 130;

  const totalsRow = (label: string, value: string, opts: { bold?: boolean } = {}): void => {
    draw(label, totalsLeft, { size: 9, bold: opts.bold, maxWidth: labelWidth });
    drawRight(value, rightEdge, { size: 9, bold: opts.bold });
    y -= 13;
  };

  totalsRow("Taxable", rupees(taxableTotal));
  for (const row of summary) {
    totalsRow(`GST ${row.rate}% (CGST+SGST)`, rupees(row.cgstPaise + row.sgstPaise));
  }
  totalsRow("CGST", rupees(cgstTotal));
  totalsRow("SGST", rupees(sgstTotal));

  y -= 3;
  page.drawLine({
    start: { x: totalsLeft, y: y + 8 },
    end: { x: rightEdge, y: y + 8 },
    thickness: 1,
  });
  totalsRow("Total", rupees(data.totalPaise), { bold: true });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
