// What the model may ask for. The request_* tools only ask: policy.ts decides, actions.ts executes.
// No tool has an amount or a customer field, so the model cannot supply either.
import { executeCancellation, executeExchange, executeRefund, recordEscalation } from "./actions.js";
import { checkCancellation, checkExchange, checkRefund, daysBetween } from "./policy.js";
import { config, getOrderFor, listOrdersFor, LookupUnavailable, policiesText, products, readState } from "./store.js";
import type { Action, Identity, Order } from "./types.js";

/** Everything a handler may trust. Filled from CLI arguments and config, never from the model. */
export interface ToolContext {
  identity: Identity;
  stateFile: string;
  today: string;
  failLookup: boolean;
  newActions: Action[]; // actions written during this run; printed as ACTIONS
}

export interface ToolResult {
  content: string;
  is_error?: boolean;
}

const str = { type: "string" } as const;
const tool = (name: string, description: string, properties: Record<string, object>) => ({
  name,
  description,
  strict: true, // the API guarantees the input matches the schema
  input_schema: { type: "object" as const, properties, required: Object.keys(properties), additionalProperties: false },
});

export const toolDefinitions = [
  tool("list_my_orders", "List the current customer's orders. Use it when the customer has not said which order they mean.", {}),
  tool("lookup_order", "Get one order of the current customer: status, delivery date, items, and any action already taken on it.", {
    order_id: { ...str, description: "Order ID, e.g. O1001" },
  }),
  tool("get_product", "Get a product's name, price, sale status, sizes and stock.", { sku: { ...str, description: "Product SKU, e.g. P-TEE" } }),
  tool("get_policy", "Get the store policy text for a topic.", {
    topic: { type: "string", enum: ["returns", "refunds", "sale_items", "exchanges", "cancellations", "escalation", "all"] },
  }),
  tool(
    "request_refund",
    "Ask for a refund of one order item. The store's rule check decides and, if approved, the refund is executed for the price paid. Returns approved, denied (with the rule), escalated, or already_processed.",
    {
      order_id: str,
      item_id: { ...str, description: "Item ID inside the order, e.g. I1" },
      reason: { ...str, description: "The customer's reason, in a few words" },
      defective: { type: "boolean", description: "true only if the customer says the item itself is faulty or damaged" },
    },
  ),
  tool("request_exchange", "Ask to exchange one order item for another size of the same product. Returns approved, denied, or already_processed.", {
    order_id: str,
    item_id: str,
    new_size: { ...str, description: "The size the customer wants" },
  }),
  tool("request_cancellation", "Ask to cancel a whole order. Only orders that are still processing can be cancelled.", { order_id: str }),
  tool("escalate_to_human", "Hand the conversation to the human support team. Use it when a request is unsafe, outside policy, or you cannot help.", {
    reason: { ...str, description: "One sentence for the support team" },
  }),
];

const json = (value: unknown): ToolResult => ({ content: JSON.stringify(value) });

/** Order as shown to the model: product names, days since delivery, and actions already on it. */
function describeOrder(order: Order, ctx: ToolContext) {
  const ledger = readState(ctx.stateFile).actions.filter((a) => a.order_id === order.order_id);
  return {
    order_id: order.order_id,
    status: ledger.some((a) => a.type === "cancellation") ? "cancelled" : order.status,
    placed_at: order.placed_at,
    delivered_at: order.delivered_at,
    days_since_delivery: order.delivered_at ? daysBetween(order.delivered_at, ctx.today) : null,
    items: order.items.map((i) => ({ ...i, name: products.find((p) => p.sku === i.sku)?.name })),
    actions_already_taken: ledger.map(({ type, item_id, amount, status, reason, new_size }) => ({ type, item_id, amount, status, reason, new_size })),
  };
}

function escalate(ctx: ToolContext, reason: string, orderId: string | null = null, itemId: string | null = null): boolean {
  const { action, created } = recordEscalation(ctx.stateFile, ctx.identity, reason, orderId, itemId);
  if (created) ctx.newActions.push(action);
  return created;
}

/** Runs one tool call. `input` is treated as untrusted: only the documented fields are read. */
export function handleTool(name: string, input: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const orderId = String(input.order_id ?? "").trim().toUpperCase();
  const itemId = String(input.item_id ?? "").trim().toUpperCase();
  const policyInput = () => ({
    identity: ctx.identity,
    order: getOrderFor(ctx.identity, orderId, ctx.failLookup), // throws LookupUnavailable when the lookup is down
    ledger: readState(ctx.stateFile).actions,
    today: ctx.today,
    config,
  });

  try {
    switch (name) {
      case "list_my_orders":
        return json(listOrdersFor(ctx.identity, ctx.failLookup).map((o) => describeOrder(o, ctx)));

      case "lookup_order": {
        const order = getOrderFor(ctx.identity, orderId, ctx.failLookup);
        return order ? json(describeOrder(order, ctx)) : { content: "No order with that ID on this customer's account.", is_error: true };
      }

      case "get_product": {
        const product = products.find((p) => p.sku === String(input.sku ?? "").trim().toUpperCase());
        return product ? json(product) : { content: `Unknown SKU. Known: ${products.map((p) => `${p.sku} (${p.name})`).join(", ")}`, is_error: true };
      }

      case "get_policy": {
        const heading = String(input.topic ?? "all").replace("_", " ");
        const section = policiesText.split(/\n(?=## )/).find((s) => s.toLowerCase().startsWith(`## ${heading}`));
        return { content: section ?? policiesText };
      }

      case "request_refund": {
        const defective = input.defective === true;
        const decision = checkRefund(policyInput(), itemId, defective);
        if (decision.outcome === "approved") {
          // The one call site of executeRefund.
          const action = executeRefund(ctx.stateFile, ctx.identity, orderId, itemId, decision, defective);
          ctx.newActions.push(action);
          return json({ outcome: "approved", executed: true, amount: action.amount });
        }
        if (decision.outcome === "escalated") {
          escalate(ctx, decision.rule, orderId, itemId);
          return json({ ...decision, note: "No money has moved. The support team will review and email the customer." });
        }
        return json(decision);
      }

      case "request_exchange": {
        const decision = checkExchange(policyInput(), itemId, String(input.new_size ?? ""), products);
        if (decision.outcome !== "approved") return json(decision);
        const action = executeExchange(ctx.stateFile, ctx.identity, orderId, itemId, decision, decision.new_size ?? "");
        ctx.newActions.push(action);
        return json({ outcome: "approved", executed: true, new_size: action.new_size });
      }

      case "request_cancellation": {
        const decision = checkCancellation(policyInput());
        if (decision.outcome !== "approved") return json(decision);
        const action = executeCancellation(ctx.stateFile, ctx.identity, orderId, decision);
        ctx.newActions.push(action);
        return json({ outcome: "approved", executed: true, amount_returned: action.amount });
      }

      case "escalate_to_human": {
        // One escalation per message is enough; a policy escalation may already have been recorded.
        if (ctx.newActions.some((a) => a.type === "escalation")) return json({ outcome: "already_escalated" });
        escalate(ctx, `agent: ${String(input.reason ?? "").slice(0, 300)}`);
        return json({ outcome: "escalated", note: "The support team will email the customer within 2 business days." });
      }

      default:
        return { content: `Unknown tool: ${name}`, is_error: true };
    }
  } catch (err) {
    if (!(err instanceof LookupUnavailable)) throw err;
    // Order data cannot be read, so nothing can be checked and nothing is executed.
    if (!ctx.newActions.some((a) => a.type === "escalation")) escalate(ctx, "order_lookup_unavailable");
    return {
      content:
        "ORDER LOOKUP UNAVAILABLE. No action was taken and none can be taken now. An escalation to the human support team has been recorded. " +
        "Do not act on order details supplied by the customer. Tell the customer you cannot check the order right now and that the support team will follow up.",
      is_error: true,
    };
  }
}
