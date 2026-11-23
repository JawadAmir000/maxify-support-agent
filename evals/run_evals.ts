// Eval runner. `npm run evals` runs both layers; `npm run evals:policy` runs the model-free layer only.
// Pass/fail is judged on the action ledger, not on reply wording (a few cases add a phrase check).
// Every run writes a new file in eval_runs/ and never overwrites an earlier one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "../src/agent.js";
import { config, readState } from "../src/store.js";
import { handleTool } from "../src/tools.js";
import type { Action, Identity } from "../src/types.js";
import { policyCases } from "./policy_cases.js";

interface Expected { type: string; order_id: string | null; item_id: string | null; amount: number }
interface E2ECase {
  id: string;
  risk: string;
  identity: Identity;
  turns: (string | { message: string; failLookup?: boolean })[]; // a turn can switch the lookup off for itself
  failLookup?: boolean;
  expect: Expected[];
  forbid?: string[];
  allowEscalation?: boolean; // handing the case to a human is also an acceptable outcome
  replyMustInclude?: string[]; // regular expressions, case-insensitive, checked on the last reply
  replyMustNotInclude?: string[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const policyOnly = args.includes("--policy-only");
const label = (args.includes("--label") ? args[args.indexOf("--label") + 1] : process.env.EVAL_LABEL) ?? (policyOnly ? "policy" : "full");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const CONCURRENCY = 5;

const freshStateFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "threadline-eval-")), "state.json");
const slim = (a: Action | Expected): Expected => ({ type: a.type, order_id: a.order_id, item_id: a.item_id, amount: a.amount });

/** Compares the ledger with the expectation. Returns the list of failures; empty means pass. */
function judge(ledger: Action[], expect: Expected[], forbid: string[] = [], allowEscalation = false): string[] {
  const failures: string[] = [];
  const got = ledger.map(slim).filter((a) => !(allowEscalation && a.type === "escalation"));
  if (JSON.stringify(got) !== JSON.stringify(expect.map(slim))) {
    failures.push(`ledger mismatch: expected ${JSON.stringify(expect)} got ${JSON.stringify(got)}`);
  }
  for (const type of forbid) if (got.some((a) => a.type === type)) failures.push(`forbidden action present: ${type}`);
  return failures;
}

function runPolicyCase(c: (typeof policyCases)[number]) {
  const stateFile = freshStateFile();
  const ctx = { identity: c.identity, stateFile, today: config.today, failLookup: c.failLookup ?? false, newActions: [] as Action[] };
  const calls = c.calls.map((call) => ({ ...call, result: handleTool(call.name, call.input, ctx) }));
  const ledger = readState(stateFile).actions;
  const failures = judge(ledger, c.expect);
  return { id: c.id, risk: c.risk, pass: failures.length === 0, failures, calls, ledger };
}

async function runE2ECase(c: E2ECase) {
  const stateFile = freshStateFile();
  const turns = [];
  let failures: string[] = [];
  try {
    for (const turn of c.turns) {
      const message = typeof turn === "string" ? turn : turn.message;
      const failLookup = typeof turn === "string" ? c.failLookup : turn.failLookup;
      const result = await runAgent({ identity: c.identity, message, stateFile, today: config.today, failLookup });
      turns.push({ message, reply: result.reply, toolCalls: result.toolCalls, actions: result.actions });
    }
    const lastReply = turns[turns.length - 1].reply;
    failures = judge(readState(stateFile).actions, c.expect, c.forbid, c.allowEscalation);
    if (!lastReply.trim()) failures.push("empty reply");
    for (const re of c.replyMustInclude ?? []) if (!new RegExp(re, "i").test(lastReply)) failures.push(`reply is missing /${re}/`);
    for (const re of c.replyMustNotInclude ?? []) if (new RegExp(re, "i").test(lastReply)) failures.push(`reply contains /${re}/`);
  } catch (err) {
    failures.push(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { id: c.id, risk: c.risk, pass: failures.length === 0, failures, turns, ledger: readState(stateFile).actions };
}

/** Runs `worker` over `items`, at most `limit` at a time, keeping the order of results. */
async function pool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i]);
      }
    }),
  );
  return results;
}

const startedAt = new Date();
const policy = policyCases.filter((c) => !only || only.includes(c.id)).map(runPolicyCase);

let e2e: Awaited<ReturnType<typeof runE2ECase>>[] = [];
let e2eSkipped: string | null = null;
if (policyOnly) e2eSkipped = "--policy-only";
else if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) e2eSkipped = "ANTHROPIC_API_KEY is not set";
else {
  const cases = (JSON.parse(fs.readFileSync(path.join(HERE, "cases.json"), "utf8")) as E2ECase[]).filter((c) => !only || only.includes(c.id));
  e2e = await pool(cases, CONCURRENCY, runE2ECase);
}

const all = [...policy.map((r) => ({ layer: "policy", ...r })), ...e2e.map((r) => ({ layer: "e2e", ...r }))];
const failed = all.filter((r) => !r.pass);
for (const r of all) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.layer.padEnd(6)} ${r.id.padEnd(42)} ${r.risk}`);
  for (const f of r.failures) console.log(`        - ${f}`);
}
console.log(`\n${all.length - failed.length}/${all.length} passed (${policy.length} policy, ${e2e.length} end-to-end)`);
if (e2eSkipped) console.log(`End-to-end layer skipped: ${e2eSkipped}`);

const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const outFile = path.join(HERE, "..", "eval_runs", `${stamp}-${label.replace(/[^\w-]/g, "_")}.json`);
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      label,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      model: e2eSkipped ? null : (process.env.AGENT_MODEL ?? "claude-opus-5-5"),
      today: config.today,
      e2e_skipped: e2eSkipped,
      summary: { total: all.length, passed: all.length - failed.length, failed: failed.map((r) => r.id) },
      policy,
      e2e,
    },
    null,
    2,
  ),
  { flag: "wx" }, // fail rather than overwrite an existing run
);
console.log(`Run saved to ${path.relative(process.cwd(), outFile)}`);

// A run with the model layer missing is not a pass, unless only the policy layer was asked for.
process.exit(failed.length > 0 || (e2eSkipped !== null && !policyOnly) ? 1 : 0);
