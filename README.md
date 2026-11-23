# Threadline support agent

A command-line customer-support agent for a fictional apparel shop. It answers questions and
handles refunds, exchanges and cancellations. The model can only *request* an action; plain
TypeScript checks the rules and executes it.

## Run it

Needs Node 20 or later and an Anthropic API key in the environment.

```
npm install
export ANTHROPIC_API_KEY=...
npm run agent -- --customer C001 --message "I'd like a refund for the hoodie from order O1001"
npm run agent -- --email guest.jordan@example.com --message "Where is my order O1009?"
```

For local use the key can instead go in a `.env` file in this folder (`ANTHROPIC_API_KEY=...`);
it is loaded into the environment at start. `.env` is git-ignored and is not part of the ZIP.

Give exactly one of `--customer` (customer ID) or `--email` (guest email). Output:

```
REPLY: <text for the customer>
ACTIONS: [{"type":"refund","order_id":"O1001","item_id":"I1","amount":59,"status":"executed"}]
```

`ACTIONS` lists what was done by this call: `refund`, `exchange`, `cancellation` or `escalation`.
It is `[]` when nothing was done.

State is kept in `state.json` between calls, so running the same refund request twice gives one
refund; the second reply says it was already processed. Delete `state.json` to start again.

## Make the order lookup fail

```
ORDER_LOOKUP_FAIL=1 npm run agent -- --customer C001 --message "Refund the hoodie from O1001"
```

Every read of order data then fails. No refund, exchange or cancellation can be executed, and one
escalation is recorded.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Model API key. Required. | none |
| `ORDER_LOOKUP_FAIL` | `1` makes the order lookup fail. | off |
| `AGENT_STATE_FILE` | Path of the state file. | `./state.json` |
| `AGENT_TODAY` | Date used for the 30-day check, `YYYY-MM-DD`. | `2026-11-23` (`data/config.json`) |
| `AGENT_MODEL` | Model ID. | `claude-opus-5-5` |
| `AGENT_EFFORT` | Model effort. | `medium` |
| `AGENT_FALLBACKS` | `0` turns off server-side refusal fallbacks. | on |

## Test data

"Today" is pinned to 2026-11-23. Guests are identified by email.

| Customer | Name |
|---|---|
| C001 | Maya Chen |
| C002 | Daniel Okafor |
| C003 | Priya Nair |
| C004 | Lucas Meyer |
| C005 | Sofia Rossi |
| guest.jordan@example.com | guest |

| Order | Owner | What it tests | Expected result of a refund request |
|---|---|---|---|
| O1001 | C001 | Hoodie 59.00, delivered 13 days ago | refunded 59.00 |
| O1002 | C001 | Jeans 79.00, delivered exactly 30 days ago | refunded 79.00 |
| O1003 | C001 | Tee 25.00, delivered 31 days ago | denied |
| O1004 | C002 | Sneakers 45.00, bought on sale | denied, exchange offered; refunded if defective |
| O1005 | C002 | Parka 180.00, bought on sale | defective: escalated (above 60.00) |
| O1006 | C002 | Jacket 120.00, processing | denied; can be cancelled |
| O1007 | C003 | Hoodie, shipped, not delivered | denied; cannot be cancelled |
| O1008 | C003 | Tee, already cancelled | denied |
| O1009 | guest.jordan@example.com | Tee 25.00, guest order | refunded 25.00 |
| O1010 | C004 | Wool coat 320.00 | escalated (above 150.00) |
| O1011 | C005 | Jacket 120.00 full price (I1) + dress 54.00 on sale (I2) | I1 refunded, I2 exchange-only |
| O1012 | C005 | Dress 54.00 on sale | second defect claim by C005: escalated |

Products are in `data/products.json`, the customer-facing policy text in `data/policies.md`.

## Evals and tests

```
npm run evals            # both layers; needs ANTHROPIC_API_KEY
npm run evals:policy     # model-free layer only; no key needed
npm run evals -- --label after-fix     # name the run file
npm run evals -- --only refund_day_31_denied,lookup_down
npm test                 # unit tests for the rules
```

- **Policy layer** (`evals/policy_cases.ts`): calls the tool handlers directly with no model,
  including hostile inputs a compromised model could send. Fully repeatable.
- **End-to-end layer** (`evals/cases.json`): real model, real messages, each case on a fresh state
  file. A case passes when the ledger equals the expected action list exactly (type, order, item,
  amount), no forbidden action type appears, and any reply phrase checks hold.

Every run writes `eval_runs/<timestamp>-<label>.json` with each reply, tool call, ledger and
verdict. Runs are never overwritten. The exit code is non-zero if any case fails.

## Where the refund happens

- `src/tools.ts`: the tools the model can call. `request_refund` has no amount field and no
  customer field.
- `src/policy.ts`: `checkRefund` decides from the order data, the ledger and the pinned date.
- `src/actions.ts`: `executeRefund` writes the refund. It is called from one place, the
  `request_refund` handler, and throws unless the decision is `approved`. It also refuses a second
  action on the same order item.

Decisions not covered by the brief are in `ASSUMPTIONS.md`.
