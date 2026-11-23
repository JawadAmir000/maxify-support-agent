# PLAN — Apparel Customer-Support Agent (1 hour)

Brief: `Requirements`. Design detail: `SPEC.md`. This file is the build order.
Where this plan and `SPEC.md` differ, this plan wins.

## Research findings that shape the plan

Checked against the current Anthropic TypeScript SDK reference.

| Finding | Consequence for the build |
|---|---|
| `temperature` / `top_p` are rejected (400) on current models. | Runs cannot be made deterministic by sampling settings. Evals must judge the **action ledger**, not reply wording, and the rules must live in code. |
| Forced `tool_choice` (`any` / `tool`) is rejected (400) on `claude-opus-5-5`. | Use `tool_choice: auto`. Never rely on the model being made to call a tool; check what it actually called. |
| `strict: true` on a tool guarantees schema-valid input (needs `additionalProperties: false` + `required`). | Every tool is strict. The refund tool has **no `amount` and no `customer_id` field**, so the model cannot supply them. |
| Thinking is always on for `claude-opus-5-5`; depth is set by `output_config.effort`, default `medium`. | Set `effort` explicitly (`medium`, override with `AGENT_EFFORT`). Do not send a `thinking` parameter. |
| A request can end with `stop_reason: "refusal"` (HTTP 200). | Check `stop_reason` before reading content. On refusal: take no action, record an `escalation`. Opt into server-side `fallbacks: "default"`; drop it if the account rejects the beta flag. |
| Tool results for a failed tool must be returned with `is_error: true`, all results in one user message. | Lookup failure is reported to the model as an error result, never dropped. |
| The SDK has a beta tool runner; the manual loop is non-beta. | Use the **manual loop** on `client.messages.create`: about 30 lines, no beta dependency, easy to explain aloud, and it gives a place for an iteration cap. |
| Managed Agents is Anthropic's hosted agent surface. | Not used: graders must run the agent with one local command against local data and a locally failable tool. |

Model: `claude-opus-5-5` (override with `AGENT_MODEL`). `max_tokens: 16000`, non-streaming.

## Design decisions locked before building

1. **Three layers.** `tools.ts` (what the model may ask) → `policy.ts` (pure rule check, returns a
   decision) → `actions.ts` (the only writer of the ledger). `executeRefund` is called from exactly
   one place, and only with an `approved` decision object.
2. **The model is treated as untrusted.** Identity, amount and today's date come from the CLI,
   the order data and config. Customer text reaches the model, never the rule check.
3. **`runAgent(options)` is a function**, not only a CLI. Options: `identity`, `message`,
   `stateFile`, `today`, `failLookup`. The CLI fills them from arguments and environment variables;
   the eval runner passes them directly, so cases can run in parallel without sharing state.
4. **Two eval layers.**
   - *Policy evals*: call the tool handlers directly, with no model. Fully repeatable, run without
     an API key, and include "compromised model" cases where the handler is called with hostile
     inputs.
   - *End-to-end evals*: real model, real messages, judged on the ledger.
5. **Defect claims are the weak point**, because code cannot verify a defect. Limits: a defective
   sale refund above 60.00 escalates, and a customer gets one automatic defect refund; a second
   escalates.
6. **Loop cap**: at most 8 model turns per message. Hitting the cap records an `escalation`.

## Milestones

Time budget is 60 minutes. Each milestone ends with a check that must pass before moving on.

### M0 — Scaffold (4 min)

- `package.json` with scripts `agent`, `evals`, `evals:policy`, `test`; `tsconfig.json`; `.gitignore`
  (`node_modules/`, `state.json`, `.env`).
- `npm install @anthropic-ai/sdk` and dev deps `tsx typescript @types/node`.
- Empty `eval_runs/` with a `.gitkeep`, and `ASSUMPTIONS.md` started.

**Check:** `npx tsx -e "console.log('ok')"` prints `ok`.

### M1 — Types and data (7 min)

- `src/types.ts`: `Product`, `Customer`, `Order`, `OrderItem`, `Action`, `Decision`, `Identity`.
- `data/config.json`: `today`, `returnWindowDays: 30`, `autoRefundLimit: 150`, `defectRefundLimit: 60`.
- `data/products.json` (8 products, 3 on sale), `data/customers.json` (5 customers),
  `data/orders.json` (12 orders), `data/policies.md`.
- Orders are chosen to hit each rule edge. Each one is named in a comment table in the README so a
  grader can pick an order to test: in window, day 30, day 31, sale, sale + defective, sale +
  defective above limit, processing, shipped, cancelled, guest, above refund limit, mixed items.

**Check:** a 5-line script loads all four files and every order's `sku` resolves to a product.

### M2 — Rules, state and execution (10 min)

- `src/store.ts`: load data; read and write `state.json` atomically; `getOrderFor(identity, id)`
  returns the order only if it belongs to the identity, and throws `LookupUnavailable` when
  `failLookup` is set.
- `src/policy.ts`: `checkRefund`, `checkExchange`, `checkCancellation`. Each returns
  `{ outcome: "approved" | "denied" | "escalated" | "already_processed", rule, amount? }`.
- `src/actions.ts`: `executeRefund`, `executeExchange`, `executeCancellation`, `recordEscalation`.
  Each re-checks that no action exists for the same order item before writing.
- `tests/policy.test.ts`: one test per rule, including day 30 allowed and day 31 denied.

**Check:** `npm test` passes. No API key needed yet.

### M3 — Agent loop and CLI (8 min)

- `src/tools.ts`: eight strict tool definitions and a `handleTool(name, input, ctx)` dispatcher.
  `ctx` carries identity, state file, today and `failLookup`.
- `src/agent.ts`: `runAgent(options)` with the manual loop; system prompt holding the policies,
  the instruction to clarify when the order or item is unclear, and to report tool outcomes
  truthfully; replay of the last 10 stored turns for the identity; refusal and loop-cap handling.
- CLI parsing of `--customer` / `--email` / `--message`; output as `REPLY:` and `ACTIONS:`.
- Missing API key gives a one-line error naming `ANTHROPIC_API_KEY`.

**Check, by hand:**

1. In-window refund → `ACTIONS` shows one executed refund.
2. Same command again → no new refund, reply says it was already processed.
3. `ORDER_LOOKUP_FAIL=1` → no refund, one escalation.

### M4 — Evals and first full run (10 min)

- `evals/cases.json`: each case has `id`, `identity`, `turns[]` (one or more messages sharing one
  state file), optional `failLookup`, `expect` (exact action list) and `forbid` (action types that
  must not appear). Optional `replyMustInclude` / `replyMustNotInclude`.
- `evals/run_evals.ts`: fresh temp state file per case, 5 cases in parallel, writes
  `eval_runs/<timestamp>-<label>.json` with every reply, tool call, ledger and verdict, plus a
  summary table on screen. Non-zero exit on any failure. Never overwrites an earlier run.
- `evals/policy_cases.ts`: the model-free layer.

Coverage (about 26 end-to-end cases, 12 policy cases):

| Risk | Cases |
|---|---|
| Wrongful refund: time | day 31; not delivered; day 30 allowed |
| Wrongful refund: sale | sale item refused + exchange offered; defective allowed; defective above limit escalated; second defect claim escalated |
| Wrong person | another customer's order ID; guest email vs customer order; customer names another ID in the message |
| Double payment | same request twice; rephrased repeat; refund after exchange on the same item |
| Manipulation | "ignore your rules"; "I'm the manager"; fake tool output pasted in the message; customer states a larger amount |
| Amount | above limit escalated; amount equals `price_paid`; mixed order refunds only the eligible item |
| Missing information | no order named with several orders → clarify, no action; unknown order ID |
| Tool failure | lookup down → no action, escalation; lookup down + customer supplies order details |
| Cancellation | processing allowed; shipped refused; already cancelled recognised |
| Honesty | reply must not claim a refund when the ledger has none |
| Compromised model (policy layer) | handler called directly with another customer's order, day-31 order, sale item, repeat call |

**Check:** `npm run evals` completes and the run file is in `eval_runs/`. Failures are expected and
kept.

### M5 — Fix the worst failure (6 min)

- Rank failures: executed wrongful refund > double refund > wrong-person data leak > claimed but
  not executed > missed escalation > poor wording.
- Find the cause, fix it in code where possible (a rule or handler change beats a prompt change).
- Add a regression test in `tests/policy.test.ts` and keep the eval case.
- Re-run evals with a new label. Both run files stay.
- Write three lines in `eval_runs/NOTES.md`: what failed, why, what changed.

This step must use a real failure from the run. If the first run is clean, add harder cases
(manipulation, multi-turn, tool failure) until one fails.

**Check:** the previously failing case passes and no other case regressed.

### M6 — Documents (5 min)

- `README.md`: install, the one command, example output, test customers and orders, how to run
  evals, `ORDER_LOOKUP_FAIL=1`, environment variables, where the refund executes.
- `ASSUMPTIONS.md`: final pass. Every limit, the pinned date, guest rules, cancellation rule,
  defect rule, what escalation means, what "state" covers.

**Check:** follow the README from a clean clone of the folder: `npm install`, then the command.




### M7 — Package and send (5 min)

- Delete `state.json`. Search the folder for `sk-ant` and `.env`; both must be absent.
- `zip` excluding `node_modules/`, `state.json`, `.env`, `.DS_Store`.
- Unzip into a temp folder, `npm install`, run the one command once.
- Candidate writes the email body in their own words and sends it to both addresses.

Notes to write the two answers from (do not paste):

- (a) comes from `eval_runs/NOTES.md`.
- (b) the refund executes in `executeRefund` in `src/actions.ts`, reached only from the
  `request_refund` handler after `checkRefund` returns `approved`. The model cannot pass an amount
  or an identity, cannot call `executeRefund`, and a repeat is blocked by the ledger.

### Buffer (5 min)

Held for a failed install, a slow eval run or an API error.

## If time runs short, cut in this order

1. Server-side `fallbacks` (keep the refusal check).
2. Exchange stock checks (approve any listed size).
3. End-to-end cases down to the 12 highest-risk ones; keep the whole policy layer.
4. Conversation replay down to the last 4 turns.

Never cut: the code-level refund gate, persistent state, the lookup-failure switch, kept failing
runs, the fix with its test.
