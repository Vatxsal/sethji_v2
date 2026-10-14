import type { CatalogItem, ExtractedIntent } from "./extract";

export type InputType = "text" | "voice";

export type IntentContext = {
  shopId: string;
  senderPhone: string;
  messageId: string;
  extracted: ExtractedIntent;
  forcedCustomerId?: string | null;
  rawInputType?: InputType;
  confidenceScore?: number | null;
  transcript?: string | null;
};

export type OrderContext = IntentContext & {
  processedId: string;
  catalog: CatalogItem[];
  forceConfirm?: boolean;
};
