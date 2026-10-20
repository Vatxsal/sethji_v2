import { sendText } from "@/lib/whatsapp/send";
import { handlePlan, type PlanStartParams } from "./plan";
import { replyExtractionFailed, replyHelp, replyOutOfScope, replyShukriya } from "./replies";

export type DispatchPlanParams = PlanStartParams;

export async function dispatchPlan(params: DispatchPlanParams): Promise<void> {
  if (params.plan.actions.length > 0) {
    await handlePlan(params);
    return;
  }

  switch (params.plan.intent) {
    case "help":
      params.setOutcome?.("info");
      await sendText(params.senderPhone, replyHelp());
      return;
    case "chitchat":
      params.setOutcome?.("info");
      await sendText(params.senderPhone, replyShukriya());
      return;
    case "out_of_scope":
      params.setOutcome?.("out_of_scope");
      await sendText(params.senderPhone, replyOutOfScope());
      return;
    case "unknown":
      params.setOutcome?.("not_understood");
      await sendText(params.senderPhone, replyExtractionFailed());
      return;
    default:
      params.setOutcome?.("not_understood");
      await sendText(params.senderPhone, replyExtractionFailed());
      return;
  }
}
