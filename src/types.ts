// Shared types. Nothing here has behaviour apart from identityKey.

export type Identity = { kind: "customer"; id: string } | { kind: "guest"; email: string };

/** One string per identity, used to tag ledger rows and compare owners. */
export const identityKey = (i: Identity): string =>
  i.kind === "customer" ? `customer:${i.id.toUpperCase()}` : `guest:${i.email.toLowerCase()}`;

export interface Product {
  sku: string;
  name: string;
  price: number;
  on_sale: boolean;
  sale_price: number | null;
  sizes: string[];
  stock: Record<string, number>;
}

export interface Customer {
  customer_id: string;
  name: string;
  email: string;
}

export interface OrderItem {
  item_id: string;
  sku: string;
  size: string;
  price_paid: number;
  bought_on_sale: boolean;
}

export interface Order {
  order_id: string;
  customer_id?: string; // exactly one of customer_id / guest_email is set
  guest_email?: string;
  status: "processing" | "shipped" | "delivered" | "cancelled";
  placed_at: string;
  delivered_at: string | null;
  items: OrderItem[];
}

export interface Config {
  today: string;
  returnWindowDays: number;
  autoRefundLimit: number;
  defectRefundLimit: number;
}

export type ActionType = "refund" | "exchange" | "cancellation" | "escalation";

/** One row of the ledger in state.json. */
export interface Action {
  id: string;
  identity: string;
  type: ActionType;
  order_id: string | null;
  item_id: string | null;
  amount: number;
  status: "executed" | "open"; // escalations are "open": waiting for a human
  reason: string;
  defective?: boolean; // refund only: granted because of a defect claim on a sale item
  new_size?: string; // exchange only
  created_at: string;
}

/** What policy.ts returns. Only an "approved" decision can be executed. */
export interface Decision {
  outcome: "approved" | "denied" | "escalated" | "already_processed";
  rule: string;
  amount?: number;
  new_size?: string; // approved exchange only: the size from the product catalogue
  action?: Action; // the earlier action, when outcome is already_processed
}

export interface StoredMessage {
  identity: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface State {
  actions: Action[];
  messages: StoredMessage[];
}
