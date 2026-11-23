// The rules. Pure functions: order data + ledger + date in, Decision out. No model, no writes.
import { ownerKey } from "./store.js";
import { identityKey } from "./types.js";
import type { Action, ActionType, Config, Decision, Identity, Order, OrderItem, Product } from "./types.js";

export interface PolicyInput {
  identity: Identity;
  order: Order | undefined;
  ledger: Action[];
  today: string; // YYYY-MM-DD
  config: Config;
}

const deny = (rule: string): Decision => ({ outcome: "denied", rule });

/** Whole days between two YYYY-MM-DD dates. */
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** Checks shared by refund and exchange. Returns the item, or the Decision that stops the request. */
function returnableItem(p: PolicyInput, itemId: string, wanted: ActionType): OrderItem | Decision {
  const { order } = p;
  if (!order || ownerKey(order) !== identityKey(p.identity)) return deny("order_not_found");
  const item = order.items.find((i) => i.item_id === itemId);
  if (!item) return deny("item_not_found");

  // An item is actioned once. item_id null is an action on the whole order (a cancellation).
  const prior = p.ledger.find(
    (a) => a.order_id === order.order_id && a.type !== "escalation" && (a.item_id === itemId || a.item_id === null),
  );
  if (prior) {
    return prior.type === wanted
      ? { outcome: "already_processed", rule: `already_${wanted}`, action: prior }
      : deny(`item_already_has_${prior.type}`);
  }
  if (order.status !== "delivered" || !order.delivered_at) return deny("not_delivered");
  const days = daysBetween(order.delivered_at, p.today);
  if (!Number.isFinite(days)) return deny("invalid_date"); // a bad date must not pass the window check
  if (days > p.config.returnWindowDays) return deny("outside_return_window");
  return item;
}

export function checkRefund(p: PolicyInput, itemId: string, defective: boolean): Decision {
  const item = returnableItem(p, itemId, "refund");
  if ("outcome" in item) return item;

  const amount = item.price_paid; // the only source of a refund amount
  if (item.bought_on_sale) {
    if (!defective) return deny("sale_item_exchange_only");
    // Code cannot verify a defect, so defect refunds are capped and limited to one per customer.
    if (amount > p.config.defectRefundLimit) return { outcome: "escalated", rule: "defect_refund_above_limit" };
    const me = identityKey(p.identity);
    if (p.ledger.some((a) => a.identity === me && a.type === "refund" && a.defective)) {
      return { outcome: "escalated", rule: "repeat_defect_claim" };
    }
  }
  if (amount > p.config.autoRefundLimit) return { outcome: "escalated", rule: "above_auto_refund_limit" };
  return { outcome: "approved", rule: "refund_ok", amount };
}

export function checkExchange(p: PolicyInput, itemId: string, newSize: string, products: Product[]): Decision {
  const item = returnableItem(p, itemId, "exchange");
  if ("outcome" in item) return item;

  const product = products.find((x) => x.sku === item.sku);
  const size = product?.sizes.find((s) => s.toLowerCase() === newSize.trim().toLowerCase());
  if (!product || !size) return deny("size_not_offered");
  if (size === item.size) return deny("same_size");
  if ((product.stock[size] ?? 0) < 1) return deny("size_out_of_stock");
  return { outcome: "approved", rule: "exchange_ok", amount: 0, new_size: size }; // the size as the catalogue spells it
}

export function checkCancellation(p: PolicyInput): Decision {
  const { order } = p;
  if (!order || ownerKey(order) !== identityKey(p.identity)) return deny("order_not_found");
  const prior = p.ledger.find((a) => a.order_id === order.order_id && a.type === "cancellation");
  if (prior) return { outcome: "already_processed", rule: "already_cancellation", action: prior };
  if (order.status === "cancelled") return { outcome: "already_processed", rule: "already_cancelled" };
  if (order.status === "shipped") return deny("already_shipped_return_after_delivery");
  if (order.status === "delivered") return deny("already_delivered_use_returns");
  const amount = order.items.reduce((sum, i) => sum + i.price_paid, 0);
  return { outcome: "approved", rule: "cancellation_ok", amount };
}
