// Data loading and the JSON state file. No rules live here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { identityKey } from "./types.js";
import type { Action, Config, Customer, Identity, Order, Product, State } from "./types.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = <T>(name: string): T =>
  JSON.parse(fs.readFileSync(path.join(ROOT, "data", name), "utf8")) as T;

export const products = readJson<Product[]>("products.json");
export const customers = readJson<Customer[]>("customers.json");
export const orders = readJson<Order[]>("orders.json");
export const config = readJson<Config>("config.json");
export const policiesText = fs.readFileSync(path.join(ROOT, "data", "policies.md"), "utf8");
export const defaultStateFile = path.join(ROOT, "state.json");

/** Thrown by the order lookup when it is switched off (ORDER_LOOKUP_FAIL=1). */
export class LookupUnavailable extends Error {
  constructor() {
    super("order lookup unavailable");
  }
}

export const ownerKey = (o: Order): string =>
  o.customer_id ? `customer:${o.customer_id}` : `guest:${(o.guest_email ?? "").toLowerCase()}`;

/** The order, only if it belongs to this identity. Someone else's order looks the same as none. */
export function getOrderFor(identity: Identity, orderId: string, failLookup: boolean): Order | undefined {
  if (failLookup) throw new LookupUnavailable();
  const id = orderId.trim().toUpperCase();
  return orders.find((o) => o.order_id === id && ownerKey(o) === identityKey(identity));
}

export function listOrdersFor(identity: Identity, failLookup: boolean): Order[] {
  if (failLookup) throw new LookupUnavailable();
  return orders.filter((o) => ownerKey(o) === identityKey(identity));
}

export function readState(file: string): State {
  if (!fs.existsSync(file)) return { actions: [], messages: [] };
  return JSON.parse(fs.readFileSync(file, "utf8")) as State;
}

/** Write to a temp file, then rename, so a crash never leaves half a ledger. */
export function writeState(file: string, state: State): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * The actions already recorded for one identity, one line each, for the model's context.
 * It comes from our own ledger, not from the order lookup, so it still works when the lookup is down.
 */
export function ledgerLinesFor(actions: Action[], identity: Identity): string[] {
  return actions
    .filter((a) => a.identity === identityKey(identity))
    .map((a) => {
      const target = a.order_id ? `order ${a.order_id}${a.item_id ? ` item ${a.item_id}` : ""}` : "no specific order";
      // A reason starting with "agent:" was written by the model, so it is not repeated into the prompt.
      const reason = a.reason.startsWith("agent:") ? "requested in conversation" : a.reason;
      const detail = a.type === "escalation" ? `reason: ${reason}` :a.type === "exchange" ? `new size ${a.new_size}` : `amount ${a.amount.toFixed(2)}`;
      return `${a.type}, ${target}, ${detail}, status ${a.status}, recorded ${a.created_at.slice(0, 10)}`;
    });
}
