import { sendText } from "@/lib/whatsapp/send";
import { handleAddItemIntent } from "./addItem";
import { handleBalanceIntent } from "./balance";
import type { IntentContext } from "./context";
import type { CatalogItem, ExtractedIntent } from "./extract";
import { handleOrderIntent } from "./order";
import { handlePaymentIntent } from "./payment";
import { handleUndoIntent } from "./undo";
import { replyExtractionFailed, replyHelp, replyNotImplemented } from "./replies";

export type DispatchParams = {
  shopId: string;
  senderPhone: string;
  messageId: string;
  extracted: ExtractedIntent;
  catalog: CatalogItem[];
  sourceMessageId?: string | null;
  forcedCustomerId?: string | null;
  forceConfirm?: boolean;
  rawInputType?: "text" | "voice";
  confidenceScore?: number | null;
  transcript?: string | null;
};

export async function dispatchExtractedIntent(params: DispatchParams): Promise<void> {
  const base: IntentContext = {
    shopId: params.shopId,
    senderPhone: params.senderPhone,
    messageId: params.messageId,
    extracted: params.extracted,
    forcedCustomerId: params.forcedCustomerId ?? null,
    rawInputType: params.rawInputType ?? "text",
    confidenceScore: params.confidenceScore ?? null,
    transcript: params.transcript ?? null,
  };

  switch (params.extracted.intent) {
    case "order":
      await handleOrderIntent({
        ...base,
        sourceMessageId: params.sourceMessageId ?? params.messageId,
        catalog: params.catalog,
        forceConfirm: params.forceConfirm ?? false,
        rawInputType: params.rawInputType,
        confidenceScore: params.confidenceScore,
      });
      break;
    case "payment":
      await handlePaymentIntent(base);
      break;
    case "balance":
      await handleBalanceIntent(base);
      break;
    case "undo":
      await handleUndoIntent(base);
      break;
    case "add_item":
      await handleAddItemIntent(base);
      break;
    case "bill": {
      const { handleBillIntent } = await import("./invoice");
      await handleBillIntent(base);
      break;
    }
    case "help":
      await sendText(params.senderPhone, replyHelp());
      break;
    case "unknown":
      await sendText(params.senderPhone, replyExtractionFailed());
      break;
    default:
      await sendText(params.senderPhone, replyNotImplemented());
      break;
  }
}
