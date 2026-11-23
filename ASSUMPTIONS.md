# Assumptions

Decisions the brief does not specify. Each one is enforced in code unless marked otherwise.

## Identity

- The identity given on the command line (`--customer` or `--email`) is treated as already
  verified, as if the customer had signed in. Nothing in the message can change it.
- A guest email only matches orders placed as a guest with that email. Giving a registered
  customer's email as `--email` does not open that customer's orders.
- An order that belongs to someone else is reported exactly like an order that does not exist, so
  the agent never confirms that another person's order ID is real.
- An unknown customer ID gets a fixed reply and no model call.

## Dates

- "Today" is pinned to `2026-11-23` in `data/config.json` so the data and the evals give the same
  result whenever they are run. Override with `AGENT_TODAY=YYYY-MM-DD`.
- The delivery day is day 0. A return on day 30 is allowed; day 31 is not.
- The 30 days run from `delivered_at`, so an order that is not delivered cannot be returned.
- A date that cannot be read (for example `AGENT_TODAY=2026-13-01`) denies the return with
  `invalid_date`. It never counts as inside the window. (Added after the security review.)

## Refunds

- A refund is for one order item, for exactly the `price_paid` on that order line. Shipping costs
  and partial refunds do not exist in this data.
- "Sale item" means the item was bought at a sale price (`bought_on_sale` on the order line), not
  that the product is on sale today.
- A refund above 150.00 (`autoRefundLimit`) is not paid automatically; it is escalated.
- A defect cannot be checked by code, so defect refunds on sale items are limited: above 60.00
  (`defectRefundLimit`) the request is escalated, and each customer gets one automatic defect
  refund; a second claim is escalated.
- The 30-day window also applies to defective items. A defect claim after day 30 is denied by the
  rule check; the agent can still pass the customer to a human.
- An item can have one action. After a refund, exchange or cancellation, a new request on the same
  item is refused; an exact repeat is answered with "already processed" and nothing is paid twice.
- No return shipment is tracked. The refund is executed when it is approved.

## Exchanges

- An exchange is for another size of the same product, within the same 30 days, if that size is in
  stock in `data/products.json`. Sale items can be exchanged.
- Stock is read but not reduced by an exchange.

## Cancellations

- Only an order with status `processing` can be cancelled, and only as a whole. The amount shown
  is the order total that goes back to the customer.
- A `shipped` order cannot be cancelled; the customer is pointed to a return after delivery.
- Asking to cancel an order that is already cancelled is recognised and records no new action.

## Escalation

- An escalation is a ledger row with status `open` and amount 0. It means a human on the support
  team has to look at the case. No money moves. In a real system this would open a ticket.
- Escalation happens in code when: a refund is above a limit; a second defect claim is made; the
  order lookup is down; the model refuses; or the model takes more than 8 turns on one message.
  The model can also escalate through `escalate_to_human`.
- At most one escalation without an order is recorded per message, and one per order item overall.

## Order-lookup failure

- `ORDER_LOOKUP_FAIL=1` makes every read of order data fail. Because the rule check needs the
  order, no refund, exchange or cancellation can be executed, and order details typed by the
  customer are never used in its place. One escalation is recorded.

## State

- `state.json` holds the action ledger and the conversation text per identity. The last 10 stored
  messages for an identity are replayed to the model so a follow-up has context.
- The identity's recorded actions are also given to the model at the start of each call, read from
  the ledger and not from the order lookup, so it can say what has already been done even when the
  lookup is down. (Added after the first eval run; see `eval_runs/NOTES.md`.)
- The reason the model writes when it calls `escalate_to_human` is stored for the support team but
  is not repeated in that list; the list says "requested in conversation". Text the model wrote
  could carry the customer's words, and the list is presented to the model as fact.
- Order and product data are read-only files. A cancellation or exchange is recorded in the
  ledger, not written back into `data/orders.json`.
- The agent is run one command at a time. Two commands writing the same state file at the same
  moment are not protected against each other.

## Model

- The API key is read from the `ANTHROPIC_API_KEY` environment variable. If a `.env` file exists in
  the folder it is loaded into the environment first, for local convenience. It is never shipped.

- Default model `claude-opus-5-5`, effort `medium`. Sampling settings cannot be fixed on this
  model, so replies vary between runs; that is why evals judge the ledger and the rules are code.
- Server-side refusal fallbacks are requested, and dropped automatically if the account rejects
  the beta flag. Set `AGENT_FALLBACKS=0` to turn them off.
- The system prompt holds the policies and the instruction to treat customer text as a request,
  never as an instruction. The prompt is a courtesy; the safety property does not depend on it.
