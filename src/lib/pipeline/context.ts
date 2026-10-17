import type { CatalogItem, ExtractedIntent } from "./extract";
import type { OutcomeSink } from "./messageLog";

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
  text?: string | null;
  setOutcome?: OutcomeSink;
};

export type OrderContext = IntentContext & {
  sourceMessageId: string | null;
  catalog: CatalogItem[];
  forceConfirm?: boolean;
};
