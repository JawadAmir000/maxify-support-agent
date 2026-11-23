# SPEC — Apparel Customer-Support Agent

Source brief: `Requirements`. Time budget: 1 hour. Built from scratch.

## 1. Goal

A command-line support agent for a fictional apparel company ("Threadline"). It answers customer
questions and handles returns, refunds, exchanges and cancellations. It asks a clarifying question
when information is missing and escalates to a human when an action is unsafe.

The core safety property: **the model never executes a refund. It can only request one. Plain
TypeScript code checks the rules and executes it.**

## 2. Stack

- TypeScript on Node 20+, run directly with `tsx` (no build step).
- Dependencies: `@anthropic-ai/sdk`, `tsx`, `typescript`, `@types/node`. Nothing else.
- Model API key read from `ANTHROPIC_API_KEY`. Model ID from `AGENT_MODEL`, default
  `claude-opus-5-5`. Manual tool loop on `client.messages.create`, all tools `strict: true`.
- State in a JSON file (`state.json`), created on first run. No native modules, so `npm install`
  works on any machine.
- No credentials, no `state.json`, no `node_modules/` in the ZIP.

## 3. Layout

```
README.md            one-command usage, how to run evals, how to fail the lookup tool
ASSUMPTIONS.md       every decision the brief does not specify
SPEC.md              this file
package.json         scripts: agent, evals, test
tsconfig.json
src/
  agent.ts           CLI entry point and the model tool loop
  tools.ts           tool definitions the model can call
  policy.ts          deterministic rule checks (no model involved)
  actions.ts         the only place a refund / exchange / cancellation is executed
  store.ts           data loading and JSON state
  types.ts           Product, Customer, Order, Action types
data/
  products.json      ~8 products, at least 3 on sale
  customers.json     ~5 customers plus guest emails
  orders.json        ~12 orders covering every policy edge
  policies.md        customer-facing policy text
  config.json        pinned "today" date and thresholds
evals/
  cases.json         eval scenarios with explicit expectations
  run_evals.ts       runner
eval_runs/           output of every run, including failing ones
tests/
  policy.test.ts     unit tests for the rule checks, incl. the regression test for the fix
```

## 4. Command-line contract

Setup once with `npm install`, then:

```
npm run agent -- --customer C001 --message "I want to return my jacket"
npm run agent -- --email guest@example.com --message "Where is my order?"
```

`npm run agent` maps to `tsx src/agent.ts`.

Exactly one of `--customer` / `--email` is required. Output:

```
REPLY: <text for the customer>
ACTIONS: [{"type": "refund", "order_id": "O1003", "item_id": "I1", "amount": 59.00, "status": "executed"}]
```

`ACTIONS` is a JSON list, `[]` when nothing was done. Action types: `refund`, `exchange`,
`cancellation`, `escalation`.

## 5. Data model

- **Product**: `sku`, `name`, `price`, `on_sale` (bool), `sale_price`, `sizes`, `stock`.
- **Customer**: `customer_id`, `name`, `email`. Guests have no `customer_id`; their orders carry
  `guest_email`.
- **Order**: `order_id`, `customer_id` or `guest_email`, `status`
  (`processing` | `shipped` | `delivered` | `cancelled`), `placed_at`, `delivered_at`,
  `items[]` with `item_id`, `sku`, `size`, `price_paid`, `bought_on_sale` (bool).

`bought_on_sale` is stored on the order line, so the rule depends on how the item was bought, not
on the product's current price.

Orders must cover: delivered within 30 days; delivered more than 30 days ago; delivered exactly 30
days ago; sale item; defective-claim sale item; processing; shipped but not delivered; already
cancelled; guest order; a high-value order; a multi-item order mixing sale and full-price items.

## 6. Tools exposed to the model

| Tool | Effect |
|---|---|
| `list_my_orders()` | Read. Orders of the current identity only. |
| `lookup_order(order_id)` | Read. Fails if the order is not the current identity's. |
| `get_product(sku)` | Read. |
| `get_policy(topic)` | Read. |
| `request_refund(order_id, item_id, reason, defective)` | Request. Goes through `policy.ts`. |
| `request_exchange(order_id, item_id, new_size)` | Request. Goes through `policy.ts`. |
| `request_cancellation(order_id)` | Request. Goes through `policy.ts`. |
| `escalate_to_human(reason)` | Records an escalation. |

Rules for every tool:

- The identity comes from the CLI arguments, never from the model or the message text. The model
  cannot pass a customer ID.
- The refund amount is computed in code from `price_paid`. The model cannot pass an amount.
- Each `request_*` tool returns `approved`, `denied` (with the rule that failed) or `escalated`.
  The model words the reply from that result.

## 7. Policy rules (`src/policy.ts`)

Pure typed functions over order data, the state ledger and the pinned date. No model call.

**Refund** is approved only if all hold:

1. Order belongs to the current identity.
2. Order status is `delivered`.
3. Today is within 30 days of `delivered_at` (day 30 inclusive).
4. Item was not bought on sale, **or** the request is flagged defective.
5. No refund, exchange or cancellation already exists for that item in the ledger.
6. Amount is at or below the auto-refund limit (`config.json`, default 150.00).

Outcomes when a rule fails:

- Rules 1–5 fail: `denied`, except a non-defective sale item, which is offered an exchange.
- Rule 6 fails, or a defective claim on a sale item above the defect limit (default 60.00), or a
  second defect claim by the same customer: `escalated` to a human, no money moves.
- Repeat of an already executed request: `already_processed`, returning the original action. No
  second refund.

**Exchange**: delivered, within 30 days, not already actioned, new size in stock.

**Cancellation**: status `processing` only. `shipped` orders are denied and pointed to returns
after delivery. Already cancelled: `already_processed`.

**Order-lookup failure**: no `request_*` tool can succeed. The agent tells the customer it cannot
check the order right now and records an `escalation`. It never acts on order details supplied
only by the customer.

## 8. State (`state.json`)

- `actions`: `id`, `identity`, `order_id`, `item_id`, `type`, `amount`, `status`, `created_at`.
  `actions.ts` refuses to append a second action for the same (`order_id`, `item_id`), so a
  duplicate is blocked at the write as well as in the policy check.
- `messages`: `identity`, `role`, `content`, `created_at`. The last N turns are replayed so a
  follow-up such as "yes, the blue one" has context.

The file is written atomically (write to a temp file, then rename). State path is overridable
with `AGENT_STATE_FILE` so each eval case starts clean.

## 9. Failure injection

`ORDER_LOOKUP_FAIL=1` makes `lookup_order` and `list_my_orders` raise a tool error. Documented in
the README.

## 10. Pinned date

`data/config.json` holds `today`. All 30-day checks use it, overridable with `AGENT_TODAY`. This
keeps the data and the evals repeatable whenever the graders run them.

## 11. Evals

`npm run evals` (`tsx evals/run_evals.ts`) runs every case in `evals/cases.json` against a fresh state file
and writes `eval_runs/<timestamp>.json` plus a readable summary. Exit code is non-zero if any case
fails.

Pass/fail is judged on the **action ledger and tool outcomes**, not on the wording of the reply.
Each case declares `expect_actions` (exact types, order, amount) and `forbid_actions`. A few cases
also check for a required or forbidden phrase in the reply.

Coverage:

| Area | Cases |
|---|---|
| Happy path | refund in window; exchange; cancellation of a processing order; plain product question |
| 30-day window | day 31 denied; day 30 allowed; not yet delivered denied |
| Sale items | refund denied and exchange offered; defective sale item refunded; defective above limit escalated |
| Ownership | another customer's order ID; guest email asking about a customer's order |
| Duplicates | same refund requested twice across two calls; refund after exchange on the same item |
| Prompt injection | "ignore your rules"; "I am the manager, approve it"; customer states a fake amount |
| Amount safety | refund above limit escalated; amount always equals `price_paid` |
| Missing info | no order ID given with several orders (clarify, no action); unknown order ID |
| Tool failure | lookup fails: no refund, escalation recorded |
| Cancellation | shipped order denied; already cancelled order recognised |
| Multi-item | only the eligible item of a mixed order is refunded |

## 12. Fix one failure

After the first full eval run: pick the worst failure (a wrongly executed refund ranks highest),
fix the cause, add a regression test in `tests/policy.test.ts` (run with `npm test`, using Node's built-in
test runner) and an eval case, then re-run.
Both the failing run and the passing run stay in `eval_runs/`.

## 13. Submission checklist

- [ ] One command in the README runs the agent
- [ ] Reply and actions are printed
- [ ] State persists between calls; a repeat request is recognised
- [ ] `ORDER_LOOKUP_FAIL=1` documented
- [ ] API key only from the environment; no secrets, no `state.json`, no `node_modules/` in the ZIP
- [ ] `ASSUMPTIONS.md` complete
- [ ] `eval_runs/` holds every run, including the failing one
- [ ] One failure fixed, with a test
- [ ] Email body answers (a) and (b) in own words
