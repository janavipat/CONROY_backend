import { env } from "../config/env.js";
import { supabaseAdmin } from "./supabase.js";
import { sendWhatsappTemplate, whatsappSenderConfigured } from "./whatsapp.js";

/**
 * WhatsApp notifications for the order lifecycle.
 *
 * Every state a shopper cares about — order placed, shipped, out for delivery,
 * delivered, cancelled, refund initiated, refund paid — sends one WhatsApp
 * message from the same business number OTP already uses, through an approved
 * "utility" template.
 *
 * Three rules hold for every send, and they are why this module exists rather
 * than a fetch() at each call site:
 *
 *  1. NEVER block or fail the caller. A shopper's checkout, a courier webhook
 *     and an admin status change must all succeed even when Meta is down, the
 *     template was renamed, or the shopper has no WhatsApp. Callers use
 *     `notifyOrderEvent(...)` without awaiting it and it never rejects.
 *  2. NEVER send the same event twice for the same order. Courier scans arrive
 *     more than once and admin screens fire duplicate PATCHes; the shopper
 *     should still get exactly one "Out for delivery". Enforced by a partial
 *     unique index on (order_id, event) over successful sends.
 *  3. ALWAYS leave a record. Every attempt — sent, failed or skipped — lands in
 *     `whatsapp_notifications` so support can answer "was the customer told?".
 */

/** The lifecycle moments a customer is messaged about. */
export type OrderEvent =
  | "order_confirmed"
  | "order_shipped"
  | "order_out_for_delivery"
  | "order_delivered"
  | "order_cancelled"
  | "refund_initiated"
  | "refund_completed";

/** Everything a template body can interpolate, resolved once per send. */
interface NotificationContext {
  /** The shopper's first name, or "there" when the order has no name. */
  name: string;
  /** Short human order reference — the first 8 chars of the id, uppercased. */
  orderRef: string;
  /** Order total actually billed (subtotal minus discount), e.g. "2,499". */
  amount: string;
  /** Currency code, e.g. "INR". */
  currency: string;
  /** Courier tracking number, or "" when there is no shipment yet. */
  waybill: string;
  /** Cancellation reason, or "" when not a cancellation. */
  reason: string;
}

/** Stand-in values used to count a template's variables, and by the test send. */
const SAMPLE_CONTEXT: NotificationContext = {
  name: "there",
  orderRef: "CONROY01",
  amount: "1,999",
  currency: "INR",
  waybill: "1234567890",
  reason: "Changed my mind",
};

/**
 * Which template each event uses, and the ORDER of its body variables.
 *
 * The array a builder returns maps positionally onto the template's {{1}},
 * {{2}}, … — Meta rejects the whole send (error 132000) if the count doesn't
 * match the approved template exactly. `GET /api/admin/whatsapp/templates`
 * reads the live templates back from Meta and flags any mismatch here, so a
 * template edit is caught from the admin panel rather than in production.
 */
const TEMPLATES: Record<
  OrderEvent,
  { name: string; params: (c: NotificationContext) => string[] }
> = {
  // "Hi {{1}}, your CONROY order {{2}} is confirmed. Total {{3}}."
  order_confirmed: {
    name: env.WHATSAPP_TPL_ORDER_CONFIRMED,
    params: (c) => [c.name, c.orderRef, c.amount],
  },
  // "Hi {{1}}, your CONROY order {{2}} has shipped. Tracking: {{3}}."
  order_shipped: {
    name: env.WHATSAPP_TPL_ORDER_SHIPPED,
    params: (c) => [c.name, c.orderRef, c.waybill || "will be shared shortly"],
  },
  // "Hi {{1}}, your CONROY order {{2}} is out for delivery today."
  order_out_for_delivery: {
    name: env.WHATSAPP_TPL_ORDER_OUT_FOR_DELIVERY,
    params: (c) => [c.name, c.orderRef],
  },
  // "Hi {{1}}, your CONROY order {{2}} has been delivered."
  order_delivered: {
    name: env.WHATSAPP_TPL_ORDER_DELIVERED,
    params: (c) => [c.name, c.orderRef],
  },
  // "Hi {{1}}, your CONROY order {{2}} has been cancelled."
  order_cancelled: {
    name: env.WHATSAPP_TPL_ORDER_CANCELLED,
    params: (c) => [c.name, c.orderRef],
  },
  // "Hi {{1}}, the refund for order {{2}} of {{3}} has been initiated."
  refund_initiated: {
    name: env.WHATSAPP_TPL_REFUND_INITIATED,
    params: (c) => [c.name, c.orderRef, c.amount],
  },
  // "Hi {{1}}, your refund of {{3}} for order {{2}} is complete."
  refund_completed: {
    name: env.WHATSAPP_TPL_REFUND_COMPLETED,
    params: (c) => [c.name, c.orderRef, c.amount],
  },
};

/** Every event name, for validation and for the admin templates report. */
export const ORDER_EVENTS = Object.keys(TEMPLATES) as OrderEvent[];

/** The template name + expected variable count for one event. */
export function templateSpec(event: OrderEvent): { name: string; variableCount: number } {
  const t = TEMPLATES[event];
  return { name: t.name, variableCount: t.params(SAMPLE_CONTEXT).length };
}

/** The language the notification templates were approved in. */
export function notifyLang(): string {
  return env.WHATSAPP_NOTIFY_LANG || env.WHATSAPP_TEMPLATE_LANG;
}

/** Lifecycle messaging is on only when a sender exists and it isn't disabled. */
export const notificationsEnabled =
  whatsappSenderConfigured && env.WHATSAPP_NOTIFY_ENABLED !== "false";

/** Normalises a phone number to E.164, applying the default country code. */
function toE164(raw: string): string {
  const trimmed = raw.replace(/[^\d+]/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  return `${env.OTP_DEFAULT_COUNTRY_CODE}${trimmed.replace(/^0+/, "")}`;
}

/** "Janavi Patel" to "Janavi". Blank/missing names fall back to "there". */
function firstName(full: unknown): string {
  const s = typeof full === "string" ? full.trim() : "";
  if (!s) return "there";
  return s.split(/\s+/)[0];
}

/** 1999 to "1,999". Indian grouping, no decimals (prices here are whole rupees). */
function formatAmount(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString("en-IN");
}

/** The order row shape this module reads. Only these columns are needed. */
interface OrderRow {
  id: string;
  phone?: string | null;
  ship_phone?: string | null;
  full_name?: string | null;
  ship_name?: string | null;
  subtotal?: number | null;
  discount?: number | null;
  currency?: string | null;
  cancel_reason?: string | null;
}

/** Extra values a call site knows that the order row doesn't carry. */
export interface NotifyOverrides {
  /** Courier tracking number, for the "shipped" message. */
  waybill?: string | null;
  /** Refund amount, when it differs from the order total (partial refunds). */
  amount?: number | null;
}

/**
 * Loads the columns a notification needs. Uses select("*") so a database that
 * hasn't run every optional migration (discount, structured address) still
 * returns a usable row instead of erroring on a missing column.
 */
async function loadOrder(orderId: string): Promise<OrderRow | null> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (error) {
    console.warn(`WhatsApp notify: couldn't load order ${orderId}:`, error.message);
    return null;
  }
  return (data as OrderRow) ?? null;
}

function buildContext(order: OrderRow, overrides: NotifyOverrides): NotificationContext {
  const net = (order.subtotal ?? 0) - (order.discount ?? 0);
  const amount = overrides.amount ?? net;
  return {
    name: firstName(order.full_name ?? order.ship_name),
    orderRef: String(order.id).slice(0, 8).toUpperCase(),
    amount: formatAmount(amount),
    currency: order.currency ?? "INR",
    waybill: overrides.waybill ?? "",
    reason: order.cancel_reason ?? "",
  };
}

/**
 * Records the attempt. Best-effort in the strongest sense: a missing table
 * (whatsapp-notifications.sql not run yet) must not stop the customer being
 * messaged, so a write failure is logged and swallowed.
 *
 * @returns false when the row was rejected as a duplicate — the caller uses
 *          this as the idempotency check, since the unique index is the only
 *          race-free arbiter of "has this already been sent?".
 */
async function record(row: {
  order_id: string;
  event: OrderEvent;
  template: string;
  to_phone: string;
  status: "sent" | "failed" | "skipped";
  message_id?: string | null;
  error?: string | null;
  params?: string[] | null;
}): Promise<boolean> {
  const { error } = await supabaseAdmin.from("whatsapp_notifications").insert(row);
  if (!error) return true;

  // 23505 = unique violation, i.e. this event already went out for this order.
  if (error.code === "23505") return false;
  console.warn(`WhatsApp notify: log write failed (${row.event}):`, error.message);
  return true;
}

/**
 * Sends the WhatsApp message for one lifecycle event, exactly once per order.
 *
 * Never throws and never rejects — call it with `void` from a request handler.
 * A skipped send (messaging off, no phone on the order, already sent) is a
 * normal outcome, not an error.
 *
 * @param event     which lifecycle moment happened
 * @param order     the order id, or an already-loaded order row (saves a query)
 * @param overrides values the order row cannot supply, e.g. a waybill
 */
export async function notifyOrderEvent(
  event: OrderEvent,
  order: string | OrderRow,
  overrides: NotifyOverrides = {},
): Promise<void> {
  try {
    if (!notificationsEnabled) return;

    const row = typeof order === "string" ? await loadOrder(order) : order;
    if (!row?.id) return;

    const template = TEMPLATES[event];
    if (!template?.name) {
      console.warn(`WhatsApp notify: no template configured for "${event}".`);
      return;
    }

    const rawPhone = row.phone || row.ship_phone || "";
    if (!rawPhone) {
      await record({
        order_id: row.id,
        event,
        template: template.name,
        to_phone: "",
        status: "skipped",
        error: "Order has no phone number.",
      });
      return;
    }

    const to = toE164(rawPhone);
    const params = template.params(buildContext(row, overrides));

    // Claim the send BEFORE calling Meta: the unique index is what makes two
    // concurrent courier scans produce one message instead of two. A failed
    // send is rewritten to status 'failed' below, which the partial index
    // ignores, so a genuine retry is still possible.
    const claimed = await record({
      order_id: row.id,
      event,
      template: template.name,
      to_phone: to,
      status: "sent",
      params,
    });
    if (!claimed) return; // already notified

    try {
      const messageId = await sendWhatsappTemplate(to, template.name, notifyLang(), params);
      await supabaseAdmin
        .from("whatsapp_notifications")
        .update({ message_id: messageId })
        .eq("order_id", row.id)
        .eq("event", event)
        .eq("status", "sent");
      console.log(`WhatsApp ${event} -> ${to} (order ${row.id}) id=${messageId}`);
    } catch (sendErr) {
      const message = sendErr instanceof Error ? sendErr.message : String(sendErr);
      // Downgrade the claim so the index frees up and a retry can happen,
      // while keeping the failure visible in the log.
      await supabaseAdmin
        .from("whatsapp_notifications")
        .update({ status: "failed", error: message })
        .eq("order_id", row.id)
        .eq("event", event)
        .eq("status", "sent");
      console.error(`WhatsApp ${event} failed for order ${row.id}: ${message}`);
    }
  } catch (err) {
    // Last line of defence: a notification must never surface as a 500 on the
    // request that triggered it.
    console.error("WhatsApp notify: unexpected failure —", err);
  }
}

/**
 * Maps a fulfillment_status the courier moved an order to onto the event the
 * customer should hear about. Returns null for internal-only states (Packed,
 * Manifested, Attempt Failed …) that a shopper does not need a message for.
 */
export function eventForFulfillmentStatus(status: string): OrderEvent | null {
  switch (status) {
    case "Shipped":
      return "order_shipped";
    case "Out For Delivery":
      return "order_out_for_delivery";
    case "Delivered":
      return "order_delivered";
    case "Cancelled":
      return "order_cancelled";
    default:
      return null;
  }
}

/** Sends one event with sample values, for the admin "test message" button. */
export async function sendSampleNotification(event: OrderEvent, toRaw: string): Promise<string> {
  const template = TEMPLATES[event];
  return sendWhatsappTemplate(
    toE164(toRaw),
    template.name,
    notifyLang(),
    template.params(SAMPLE_CONTEXT),
  );
}
