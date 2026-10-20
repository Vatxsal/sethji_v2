import { log } from "@/lib/log";
import { getSupabase } from "@/lib/supabase";
import { sendDocument } from "@/lib/whatsapp/send";
import { customerLabel } from "./customers";
import { buildInvoicePdf, type InvoicePdfLine } from "./invoicePdf";
import { replyInvoiceCaption } from "./replies";

const SIGNED_URL_SECONDS = 3600;

type OrderRow = {
  id: string;
  total_amount_paise: number;
  customer_id: string | null;
};

type OrderItemRow = {
  item_name_raw: string;
  quantity: number;
  unit_type: string;
  unit_price_paise: number;
  line_total_paise: number;
  catalog_items: { gst_rate_percent: number | null } | null;
};

function dateLabelKolkata(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date());
}

function toPdfLines(items: OrderItemRow[]): InvoicePdfLine[] {
  return items.map((item) => {
    const gstRate = Number(item.catalog_items?.gst_rate_percent ?? 0) || 0;
    const lineTotal = Number(item.line_total_paise);
    const taxablePaise = Math.round((lineTotal * 100) / (100 + gstRate));
    const gstPaise = lineTotal - taxablePaise;
    return {
      itemName: item.item_name_raw,
      quantity: Number(item.quantity),
      unit: item.unit_type,
      unitPricePaise: Number(item.unit_price_paise),
      lineTotalPaise: lineTotal,
      gstRatePercent: gstRate,
      taxablePaise,
      gstPaise,
    };
  });
}

async function latestConfirmedOrder(
  shopId: string,
  customerId: string | null,
): Promise<OrderRow | null> {
  let query = getSupabase()
    .from("orders")
    .select("id, total_amount_paise, customer_id")
    .eq("shop_id", shopId)
    .eq("status", "confirmed")
    .order("created_at", { ascending: false })
    .limit(1);
  if (customerId) query = query.eq("customer_id", customerId);

  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as OrderRow[])[0] ?? null;
}

async function getOrCreateInvoice(shopId: string, orderId: string): Promise<string> {
  const sb = getSupabase();

  const { data: existing, error: existingError } = await sb
    .from("invoices")
    .select("id, invoice_number")
    .eq("order_id", orderId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return String(existing.invoice_number);

  const { data: numberResult, error: numberError } = await sb.rpc("issue_invoice_number", {
    p_shop_id: shopId,
  });
  if (numberError) throw numberError;

  const { error: insertError } = await sb.from("invoices").insert({
    shop_id: shopId,
    order_id: orderId,
    invoice_number: numberResult,
  });
  if (insertError) throw insertError;

  return String(numberResult);
}

export async function performBill(
  shopId: string,
  senderPhone: string,
  customerId: string | null,
  msgId?: string,
): Promise<{ invoiceNumber: string; totalPaise: number } | "no_order"> {
  const sb = getSupabase();

  let customerName: string | null = null;
  let captionName: string | null = null;

  if (customerId) {
    const { data: customer, error } = await sb
      .from("customers")
      .select("id, display_name, disambiguator")
      .eq("id", customerId)
      .maybeSingle();
    if (error) throw error;
    if (customer) {
      customerName = String(customer.display_name);
      captionName = await customerLabel(shopId, customer, msgId);
    }
  }

  const order = await latestConfirmedOrder(shopId, customerId);
  if (!order) {
    log(msgId, "bill_no_order", { customerId });
    return "no_order";
  }

  if (!customerName && order.customer_id) {
    const { data: customer, error } = await sb
      .from("customers")
      .select("id, display_name, disambiguator")
      .eq("id", order.customer_id)
      .maybeSingle();
    if (error) throw error;
    if (customer) {
      customerName = String(customer.display_name);
      captionName = await customerLabel(shopId, customer, msgId);
    }
  }

  const { data: itemRows, error: itemsError } = await sb
    .from("order_items")
    .select(
      "item_name_raw, quantity, unit_type, unit_price_paise, line_total_paise, catalog_items(gst_rate_percent)",
    )
    .eq("order_id", order.id);
  if (itemsError) throw itemsError;
  const lines = toPdfLines((itemRows ?? []) as unknown as OrderItemRow[]);

  const invoiceNumber = await getOrCreateInvoice(shopId, order.id);

  const { data: shop, error: shopError } = await sb
    .from("shops")
    .select("name, address, gstin")
    .eq("id", shopId)
    .maybeSingle();
  if (shopError) throw shopError;

  const totalPaise = Number(order.total_amount_paise);
  const pdfBuffer = await buildInvoicePdf({
    shopName: String(shop?.name ?? ""),
    shopAddress: shop?.address ?? null,
    shopGstin: shop?.gstin ?? null,
    invoiceNumber,
    dateLabel: dateLabelKolkata(),
    customerName,
    lines,
    totalPaise,
  });

  const storagePath = `${shopId}/${invoiceNumber}.pdf`;
  const { error: uploadError } = await sb.storage
    .from("invoices")
    .upload(storagePath, pdfBuffer, { contentType: "application/pdf", upsert: true });
  if (uploadError) throw uploadError;

  const { data: signed, error: signedError } = await sb.storage
    .from("invoices")
    .createSignedUrl(storagePath, SIGNED_URL_SECONDS);
  if (signedError || !signed) throw signedError ?? new Error("signed url missing");

  const { error: urlError } = await sb
    .from("invoices")
    .update({ pdf_url: signed.signedUrl })
    .eq("shop_id", shopId)
    .eq("order_id", order.id);
  if (urlError) throw urlError;

  log(msgId, "invoice_sent", { invoiceNumber, orderId: order.id, totalPaise });

  const caption = replyInvoiceCaption(invoiceNumber, captionName ?? customerName, totalPaise);
  await sendDocument(senderPhone, signed.signedUrl, `${invoiceNumber}.pdf`, caption);
  return { invoiceNumber, totalPaise };
}
