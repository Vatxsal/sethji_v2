# Sethji

WhatsApp bot for kirana shopkeepers. One webhook + helpers, no website. The shopkeeper
texts or sends voice notes (Hindi / English / Hinglish) to record orders, udhaar,
payments, balances and GST invoice PDFs.

Stack: Next.js 15 (App Router, API routes only), TypeScript strict, Supabase
(service-role, server only), Groq (LLM + Whisper), Gemini fallback, Meta WhatsApp
Cloud API, `@react-pdf/renderer` for invoices.

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
`processed_messages`, `orders`, `order_items`, `ledger_entries`, `invoices`,
`identity_matches`, `pending_actions` + RPCs `add_ledger_entry`,
`get_customer_balance`, `issue_invoice_number`). Never create or alter tables.
Create two **private** Storage buckets: `voice-notes` and `invoices`.

`src/env.ts` validates keys lazily (zod) and throws naming the missing key.

## 2. Seed

```bash
npm install
npm run seed
```

`data/shops.json` holds shops + catalog (prices are GST-inclusive rupees). Seed
normalizes the shopkeeper phone (10 digits gets `91` prepended), upserts the shop by
phone, then upserts catalog items case-insensitively.

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

## 6. Where to look when X breaks

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
| `health_db` | `src/app/api/health/route.ts` | Health check could not query `shops` |
| `shop` | `src/lib/pipeline/handleMessage.ts` | Shop lookup by shopkeeper phone (`found:false` = number not registered) |
| `handle_error` | `src/lib/pipeline/handleMessage.ts` | Uncaught error in processing (full error object logged) |
| `failed_update_error` | `src/lib/pipeline/handleMessage.ts` | Could not set processed_messages status=failed |
| `error_reply_failed` | `src/lib/pipeline/handleMessage.ts` | Even the generic error reply could not be sent |
| `done_update_error` | `src/lib/pipeline/handleMessage.ts` | Reply was sent but completed-status update failed |
| `pick_cancelled` | `src/lib/pipeline/handleMessage.ts` | Open pick-customer pending cancelled by a normal message |
| `mark_read_fail` | `src/lib/whatsapp/send.ts` | Mark-read/typing call failed (non-fatal) |
| `extract` | `src/lib/pipeline/extract.ts` | LLM intent extraction result (`source` groq/gemini) |
| `extract_groq` / `extract_gemini` | `src/lib/pipeline/extract.ts` | LLM call threw |
| `extract_fail` | `src/lib/pipeline/extract.ts` | Both LLMs failed/invalid, intent treated as unknown |
| `customer_auto_new` | `src/lib/pipeline/customers.ts` | New customer created for an unknown name |
| `customer_not_found` | `src/lib/pipeline/customers.ts` | Name looked up but no customer (payment/balance/bill) |
| `name_unique_match` | `src/lib/pipeline/customers.ts` | Exactly one customer matched |
| `name_ambiguous` | `src/lib/pipeline/customers.ts` | 2+ customers share the name |
| `name_ambiguous_last4_resolved` | `src/lib/pipeline/customers.ts` | Ambiguity resolved via last-4 digits |
| `new_with_last4` | `src/lib/pipeline/customers.ts` | New customer created with disambiguator |
| `identity_match_error` | `src/lib/pipeline/customers.ts` | identity_matches insert failed (non-fatal) |
| `customer_resolve_error` | `src/lib/pipeline/customers.ts` | Customer lookup/create threw |
| `order_saved` | `src/lib/pipeline/order.ts` | Order + items (+ ledger for udhaar) saved |
| `order_gate` | `src/lib/pipeline/order.ts` | Confirmation buttons sent (skipped items or low voice confidence) |
| `order_unbillable` | `src/lib/pipeline/order.ts` | No item could be billed (missing catalog match/unit) |
| `order_no_customer` | `src/lib/pipeline/order.ts` | Udhaar order without a customer name |
| `customer_forced` | `src/lib/pipeline/order.ts` | Customer came from a resolved pick-customer pending |
| `payment_saved` | `src/lib/pipeline/payment.ts` | Payment ledger entry written |
| `payment_gate` | `src/lib/pipeline/payment.ts` | Low-confidence payment waiting for confirmation |
| `balance` / `balance_shop` | `src/lib/pipeline/balance.ts` | Balance reply sent (single / shop-wide) |
| `undo_none` / `undo_done` | `src/lib/pipeline/undo.ts` | Nothing to undo / reversal written |
| `item_upserted` | `src/lib/pipeline/addItem.ts` | Catalog item added or updated |
| `pending_created` / `pending_resolved` | `src/lib/pipeline/pending.ts` | pending_actions lifecycle |
| `confirm_accepted` / `confirm_cancelled` | `src/lib/pipeline/confirm.ts` | Button reply on a confirm gate |
| `pick_resolved` | `src/lib/pipeline/confirm.ts` | Ambiguous-name choice resolved (digits / list number / naya) |
| `media` / `media_error` | `src/lib/pipeline/stt.ts` | Voice note uploaded to `voice-notes` bucket |
| `stt` | `src/lib/pipeline/stt.ts` | Whisper transcript + confidence (below 0.55 forces confirm) |
| `invoice_sent` / `bill_no_order` | `src/lib/pipeline/invoice.ts` | Invoice PDF sent / no confirmed order to bill |

Reply text lives only in `src/lib/pipeline/replies.ts`. Money is integer paise
everywhere; display uses `Intl` (`en-IN`). Ledger sign: positive = customer owes
more, negative = payment received. Balance is always `get_customer_balance()`.
