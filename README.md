# Sethji

WhatsApp bot for kirana shopkeepers. One webhook + helpers, no website. The shopkeeper
texts or sends voice notes (Hindi / English / Hinglish) to record orders, udhaar,
payments, balances and GST invoice PDFs.

Stack: Next.js 15 (App Router, API routes only), TypeScript strict, Supabase
(service-role, server only), Groq (LLM + Whisper), Gemini fallback, Meta WhatsApp
Cloud API, `pdf-lib` for invoice PDFs.

## 1. Environment

```bash
cp .env.example .env.local
```

Fill every key (all required unless noted):

| Key | Where to get it |
| --- | --- |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta App > WhatsApp > Getting Started |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Meta App > WhatsApp > Configuration |
| `WHATSAPP_ACCESS_TOKEN` | Meta App > WhatsApp > API Setup (permanent token recommended) |
| `WHATSAPP_APP_SECRET` | Meta App > Settings > Basic > App Secret (webhook signature check) |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Make up any random string; you will enter it in Meta too |
| `GROQ_API_KEY` | console.groq.com |
| `GEMINI_API_KEY` | aistudio.google.com (fallback only) |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project Settings > API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase project Settings > API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase project Settings > API (server only, never expose) |
| `WHATSAPP_GRAPH_VERSION` | optional, defaults to `v23.0` |

The Supabase schema already exists (`shops`, `customers`, `catalog_items`,
`processed_messages`, `orders` (with `source_message_id` -> `processed_messages`),
`order_items`, `ledger_entries`, `invoices`, `identity_matches`, `pending_actions`,
`message_log` + RPCs `add_ledger_entry`, `get_customer_balance`,
`issue_invoice_number`). Never create or alter tables.
Create two **private** Storage buckets: `voice-notes` and `invoices`.

`src/env.ts` validates keys lazily (zod) and throws naming the missing key.

## 2. Seed & eval

```bash
npm install
npm run seed          # data/shops.json -> shops + catalog
npm run eval:extract  # 32 golden cases against Groq (needs GROQ_API_KEY)
```

`data/shops.json` holds shops + catalog (prices are GST-inclusive rupees). Seed
normalizes the shopkeeper phone (10 digits gets `91` prepended), upserts the shop by
phone, then upserts catalog items case-insensitively.

`npm run eval:extract` runs `data/extract-cases.json` through the real extraction
pipeline (prompt + post-processing) and asserts intent, customer name, customer-name
count, last-4 digits, payment method, amount, item names and quantities (including
`null` for invalid quantities), and `add_item` payloads. Current result:
**32/32 passed**. `npm run typecheck` runs `tsc --noEmit`.

## 3. Run locally

```bash
npm run dev
# or
npm run build && npm run start
```

Check `GET /api/health` — every env key should be `true` and `db` should be `true`.

## 4. Deploy to Vercel

1. Push the repo to GitHub and import it in Vercel (framework: Next.js, no changes needed).
2. Add all env vars from `.env.local` in Project > Settings > Environment Variables.
3. Deploy. Your base URL is now `https://<app>.vercel.app`.

## 5. Meta webhook

1. In Meta App > WhatsApp > Configuration > Webhook:
   - **Callback URL**: `https://<app>.vercel.app/api/webhook`
   - **Verify token**: exactly the value of `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
     (Meta sends `hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`; the
     route returns the challenge when the token matches, else 403).
2. Subscribe the webhook to the **messages** field.
3. Every POST is signature-checked (`x-hub-signature-256` HMAC of the raw body with
   `WHATSAPP_APP_SECRET`); mismatches get 403.
4. The route always returns 200 after the signature check (Meta retries only on
   non-200); real work runs afterwards via `after()`.
5. Duplicates (`processed_messages` conflict) are ignored, and messages older than
   10 minutes (`STALE_MESSAGE_SECONDS = 600`) are marked completed without replying —
   Meta redeliveries never trigger stale replies.

## 6. Message flow & guard rails

**Intents** (LLM extraction in `src/lib/pipeline/extract.ts`, Groq `llama-3.3-70b`
with Gemini fallback, then deterministic post-processing in `understand.ts`):
`order`, `payment`, `balance`, `bill`, `undo`, `add_item`, `help`. Both text and
voice notes are accepted; voice goes through Whisper (`stt.ts`, language `hi`) and
keeps the transcript + confidence in the log. Reply text lives only in
`src/lib/pipeline/replies.ts`.

**Understanding rules**

- Customer names are matched exactly, then partially; ambiguous names (2+ customers)
  send a numbered pick list with last-4 disambiguator labels and current balances.
  Answer with the number / last 4 digits, or `naya` (orders only) to create a new
  customer.
- A new customer whose name has a last-4 digit hint (`rahul 7777`) needs a
  **Haan / Cancel** button confirmation before the order is saved.
- Items are matched exactly then partially (`matchCatalogItem`); kg/g and l/ml are
  converted, but a non-convertible unit (e.g. `2 kilo chai` for a packet item) is
  refused with the unit-mismatch reply. Missing/invalid quantity → quantity-unclear
  reply (never billed as 0). Money is integer paise everywhere; ledger sign:
  positive = customer owes more, negative = payment received; balance always comes
  from `get_customer_balance()`.

**Safety rails**

| Rail | Behaviour |
| --- | --- |
| Two customers / mixed message in one text | Refused: send one customer + one work per message |
| Order or payment > ₹5,000 (`LARGE_AMOUNT_PAISE`) | Never saved directly — confirm buttons required first (audit outcome stays `refused` until confirmed) |
| Skipped items, voice confidence < 0.55, forced re-confirm | Confirm buttons (Haan / Cancel); pending lives 30 min (`PENDING_TTL_MINUTES`) |
| Balance edit (`set`/`zero`/`clear`/`reset`/`waive`/`0 kar`) | Blocked — use payment or undo |
| Direct balance write | Not possible from chat; only ledger RPCs mutate balances |
| Invalid customer name (digits/symbols) | Refused, name re-asked |
| Duplicate / stale (>10 min) webhook messages | Ignored (dedupe + stale guard) |
| Unregistered number | Replied "not registered", nothing written |

**Confirmations** are `pending_actions` rows: `confirm_action` (Haan/Cancel buttons)
and `pick_customer` (name/list follow-ups). Button replies, or an exact `haan/yes/ok`
text while a confirm pending is open, run the saved payload. An answer that matches
no candidate cancels a pick pending and the message is re-extracted from scratch;
the confirm pending itself stays open until it expires (30 min).

**Audit log** — every processed message writes exactly one row to `message_log`
(inserted via `after()` at the end of `handleMessage`, including the error path):
`(shop_id, whatsapp_message_id, input_type, input_text, stt_confidence, parsed jsonb,
outcome, error_text)`. `outcome` is one of `saved | asked_customer | asked_confirm |
refused | not_understood | error`; `input_text` is the text / transcript / button id
(truncated to 1000 chars), `parsed` is the post-processed intent (null for button and
greeting messages). Insert failures are logged, never thrown.

## 7. Where to look when X breaks

Every stage logs one line: `[msg:<last 6 chars of whatsapp id>] <stage> <json>`.
Search your Vercel logs for the stage name.

| Stage | File | Meaning |
| --- | --- | --- |
| `sig` | `src/app/api/webhook/route.ts` | WhatsApp signature check (`ok:false` = bad/missing HMAC) |
| `parse_json` | `src/app/api/webhook/route.ts` | Body was not valid JSON |
| `no_message` | `src/app/api/webhook/route.ts` | Status/read receipt webhook, nothing to do |
| `self_message` | `src/app/api/webhook/route.ts` | Message from the business number itself, ignored |
| `received` | `src/app/api/webhook/route.ts` | Message accepted for processing |
| `dup` | `src/app/api/webhook/route.ts` | Duplicate whatsapp_message_id, ignored |
| `insert_error` | `src/app/api/webhook/route.ts` | processed_messages insert failed (DB down?) |
| `stale` / `stale_update_error` | `src/app/api/webhook/route.ts` | Message older than 10 min, skipped / status update failed |
| `health_db` | `src/app/api/health/route.ts` | Health check could not query `shops` |
| `shop` | `src/lib/pipeline/handleMessage.ts` | Shop lookup by shopkeeper phone (`found:false` = number not registered) |
| `handle_error` | `src/lib/pipeline/handleMessage.ts` | Uncaught error in processing (full error object logged) |
| `failed_update_error` | `src/lib/pipeline/handleMessage.ts` | Could not set processed_messages status=failed |
| `error_reply_failed` | `src/lib/pipeline/handleMessage.ts` | Even the generic error reply could not be sent |
| `done_update_error` | `src/lib/pipeline/handleMessage.ts` | Reply was sent but completed-status update failed |
| `pick_cancelled` / `name_pending_cancelled` | `src/lib/pipeline/handleMessage.ts` | Open pending cancelled by a normal message |
| `message_log` / `message_log_error` | `src/lib/pipeline/messageLog.ts` | message_log audit row written / insert failed (non-fatal) |
| `mark_read_fail` | `src/lib/whatsapp/send.ts` | Mark-read/typing call failed (non-fatal) |
| `extract` | `src/lib/pipeline/extract.ts` | LLM intent extraction result (`source` groq/gemini) |
| `extract_groq` / `extract_gemini` | `src/lib/pipeline/extract.ts` | LLM call threw |
| `extract_fail` | `src/lib/pipeline/extract.ts` | Both LLMs failed/invalid, intent treated as unknown |
| `understand` | `src/lib/pipeline/understand.ts` | Post-extraction summary (intent/customer/items) |
| `customers_load_error` | `src/lib/pipeline/understand.ts` | Known-customers list could not be loaded for extraction |
| `customer_auto_new` | `src/lib/pipeline/customers.ts` | New customer created for an unknown name |
| `customer_not_found` | `src/lib/pipeline/customers.ts` | Name looked up but no customer (payment/balance/bill) |
| `name_unique_match` | `src/lib/pipeline/customers.ts` | Exactly one customer matched |
| `name_ambiguous` | `src/lib/pipeline/customers.ts` | 2+ customers share the name (pick list sent) |
| `name_ambiguous_last4_resolved` | `src/lib/pipeline/customers.ts` | Ambiguity resolved via last-4 digits |
| `new_last4_confirm_needed` | `src/lib/pipeline/customers.ts` | New customer needs Haan/Cancel button confirm |
| `new_with_last4` | `src/lib/pipeline/customers.ts` | New customer created with disambiguator |
| `invalid_name` | `src/lib/pipeline/customers.ts` | Name rejected by validation (digits/symbols) |
| `customer_label_error` | `src/lib/pipeline/customers.ts` | Disambiguator label lookup failed (reply still sent) |
| `identity_match_error` | `src/lib/pipeline/customers.ts` | identity_matches insert failed (non-fatal) |
| `customer_resolve_error` | `src/lib/pipeline/customers.ts` | Customer lookup/create threw |
| `multi_customer` / `mixed_message` | `src/lib/pipeline/dispatch.ts` | Refused: two customers, or items + amount in one message |
| `order_saved` | `src/lib/pipeline/order.ts` | Order + items (+ ledger for udhaar) saved |
| `order_gate` | `src/lib/pipeline/order.ts` | Confirm buttons sent (skipped items, low voice confidence, large amount, force) |
| `order_bad_quantity` | `src/lib/pipeline/order.ts` | Quantity missing/<=0, refused |
| `order_unit_mismatch` | `src/lib/pipeline/order.ts` | Spoken unit not convertible to catalog unit |
| `order_unbillable` | `src/lib/pipeline/order.ts` | No item could be billed (missing catalog match/unit) |
| `order_no_customer` | `src/lib/pipeline/order.ts` | Udhaar order without a customer name (name asked) |
| `new_customer_confirm` | `src/lib/pipeline/order.ts` | Naya-customer confirm buttons sent |
| `customer_forced` | `src/lib/pipeline/order.ts` | Customer came from a resolved pick-customer pending |
| `payment_saved` | `src/lib/pipeline/payment.ts` | Payment ledger entry written |
| `payment_gate` | `src/lib/pipeline/payment.ts` | Low-confidence / large payment waiting for confirmation |
| `payment_bad_amount` | `src/lib/pipeline/payment.ts` | Amount missing or <= 0 |
| `balance` / `balance_shop` | `src/lib/pipeline/balance.ts` | Balance reply sent (single / shop-wide) |
| `balance_modify_blocked` | `src/lib/pipeline/balance.ts` | Attempt to edit balance directly, refused |
| `undo_none` / `undo_done` | `src/lib/pipeline/undo.ts` | Nothing to undo / reversal written |
| `item_upserted` | `src/lib/pipeline/addItem.ts` | Catalog item added or updated |
| `pending_created` / `pending_resolved` | `src/lib/pipeline/pending.ts` | pending_actions lifecycle |
| `confirm_accepted` / `confirm_cancelled` | `src/lib/pipeline/confirm.ts` | Button reply on a confirm gate |
| `name_pending_resolved` / `name_pending_invalid` | `src/lib/pipeline/confirm.ts` | Name follow-up answered (saved / refused) |
| `pick_resolved` | `src/lib/pipeline/confirm.ts` | Ambiguous-name choice resolved (digits / list number / naya) |
| `pick_no_match` | `src/lib/pipeline/confirm.ts` | Pick answer matched no candidate, list re-sent |
| `pick_naya_wrong_intent` / `pick_new_invalid_name` | `src/lib/pipeline/confirm.ts` | `naya` used outside an order / name invalid |
| `new_customer_created` | `src/lib/pipeline/confirm.ts` | Naya customer created on button confirm |
| `media` / `media_error` | `src/lib/pipeline/stt.ts` | Voice note uploaded to `voice-notes` bucket |
| `stt` | `src/lib/pipeline/stt.ts` | Whisper transcript + confidence (below 0.55 forces confirm) |
| `invoice_sent` / `bill_no_order` | `src/lib/pipeline/invoice.ts` | Invoice PDF sent / no confirmed order to bill |

Reply text lives only in `src/lib/pipeline/replies.ts`. Money is integer paise
everywhere; display uses `Intl` (`en-IN`). Ledger sign: positive = customer owes
more, negative = payment received. Balance is always `get_customer_balance()`.
