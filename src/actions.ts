// The only file that writes to the ledger. A refund is executed in executeRefund and nowhere else.
import { randomUUID } from "node:crypto";
import { readState, writeState } from "./store.js";
import { identityKey } from "./types.js";
import type { Action, Decision, Identity } from "./types.js";

type NewAction = Omit<Action, "id" | "identity" | "created_at">;

/** Appends one row. Refuses a second refund/exchange/cancellation on the same order item. */
function append(stateFile: string, identity: Identity, a: NewAction): Action {
  const state = readState(stateFile);
  const clash = state.actions.find(
    (x) =>
      a.type !== "escalation" &&
      x.type !== "escalation" &&
      x.order_id === a.order_id &&
      (x.item_id === a.item_id || x.item_id === null || a.item_id === null),
  );
  if (clash) throw new Error(`duplicate blocked: ${clash.type} ${clash.id} already exists for this item`);
  const action: Action = { id: randomUUID(), identity: identityKey(identity), created_at: new Date().toISOString(), ...a };
  state.actions.push(action);
  writeState(stateFile, state);
  return action;
}

/** Throws unless policy.ts approved the request. The amount comes from the decision, never a caller. */
function approvedAmount(decision: Decision): number {
  if (decision.outcome !== "approved" || decision.amount === undefined) {
    throw new Error(`refused to execute: decision was "${decision.outcome}" (${decision.rule})`);
  }
  return decision.amount;
}

export function executeRefund(
  stateFile: string, identity: Identity, orderId: string, itemId: string, decision: Decision, defective: boolean,
): Action {
  const amount = approvedAmount(decision);
  // In a real system the payment provider would be called here.
  return append(stateFile, identity, {
    type: "refund", order_id: orderId, item_id: itemId, amount, status: "executed", reason: decision.rule, defective,
  });
}

export function executeExchange(
  stateFile: string, identity: Identity, orderId: string, itemId: string, decision: Decision, newSize: string,
): Action {
  approvedAmount(decision);
  return append(stateFile, identity, {
    type: "exchange", order_id: orderId, item_id: itemId, amount: 0, status: "executed", reason: decision.rule, new_size: newSize,
  });
}

export function executeCancellation(stateFile: string, identity: Identity, orderId: string, decision: Decision): Action {
  const amount = approvedAmount(decision);
  return append(stateFile, identity, {
    type: "cancellation", order_id: orderId, item_id: null, amount, status: "executed", reason: decision.rule,
  });
}

/** Hands the case to a human. No money moves. A repeat for the same order item returns the open one. */
export function recordEscalation(
  stateFile: string, identity: Identity, reason: string, orderId: string | null = null, itemId: string | null = null,
): { action: Action; created: boolean } {
  const open = orderId
    ? readState(stateFile).actions.find((a) => a.type === "escalation" && a.order_id === orderId && a.item_id === itemId)
    : undefined;
  if (open) return { action: open, created: false };
  const action = append(stateFile, identity, {
    type: "escalation", order_id: orderId, item_id: itemId, amount: 0, status: "open", reason,
  });
  return { action, created: true };
}
