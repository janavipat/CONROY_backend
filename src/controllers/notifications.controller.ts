import crypto from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase.js";
import { jsonStore } from "../lib/blobStore.js";

/**
 * Admin notifications, derived from records that already exist.
 *
 * Nothing here writes an event when something happens — the existing
 * controllers are untouched. Instead each poll scans the real tables for rows
 * that appeared since the last scan and turns those into notifications. A
 * notification therefore only ever exists because a genuine order, customer,
 * message, return, product or collection exists behind it.
 *
 * Two things have no history to read, so they are diffed against a snapshot
 * taken on the previous scan rather than invented:
 *   - order status, which the orders table only ever holds the current value of
 *   - the product and collection lists, which carry no updated_at column
 *
 * State lives in one JSON file in the app-config bucket, the same store the
 * chat widget uses, so read/unread survives a refresh and a redeploy.
 */

export type NotificationType =
  | "order.new"
  | "order.status"
  | "customer.new"
  | "customer.online"
  | "visitor.new"
  | "contact.new"
  | "chat.new"
  | "return.new"
  | "product.change"
  | "collection.change";

export interface AdminNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  /** Admin route this notification points at, if any. */
  href: string | null;
  createdAt: string;
  read: boolean;
}

interface Snapshot {
  /** Highest created_at already turned into a notification, per source. */
  watermarks: Record<string, string>;
  /** order id -> last seen status, for detecting transitions. */
  orderStatus: Record<string, string>;
  /** Known product handles and collection handles, for detecting adds/removes. */
  productHandles: string[];
  collectionHandles: string[];
  /**
   * Sessions already announced as a signed-in customer. Pruned each scan to
   * those still online, so it stays small and a customer who returns later is
   * announced again — but never twice while they stay.
   */
  customerSessions: string[];
  /** True once the first scan has run, so an existing store is not replayed. */
  initialised: boolean;
}

interface StoreShape {
  notifications: AdminNotification[];
  snapshot: Snapshot;
}

const EMPTY: StoreShape = {
  notifications: [],
  snapshot: {
    watermarks: {},
    orderStatus: {},
    productHandles: [],
    collectionHandles: [],
    customerSessions: [],
    initialised: false,
  },
};

const store = jsonStore<StoreShape>("admin-notifications.json", EMPTY);

/** Keeps the feed from growing without bound. */
const MAX_NOTIFICATIONS = 200;

const EPOCH = "1970-01-01T00:00:00.000Z";

/** Stable id per source row, so re-scanning cannot duplicate a notification. */
function idFor(type: NotificationType, key: string): string {
  return crypto.createHash("sha1").update(`${type}:${key}`).digest("hex").slice(0, 24);
}

function shortMoney(paise: number): string {
  return `₹${Number(paise ?? 0).toLocaleString("en-IN")}`;
}

/** Trims a free-text message to a single readable line. */
function snippet(text: string, max = 90): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

interface ChatMessage {
  id: string;
  name: string | null;
  message: string;
  createdAt: string;
}
const chatStore = jsonStore<ChatMessage[]>("chat-messages.json", []);

/**
 * Scans every source and returns the notifications that are new since the last
 * scan, together with the snapshot to persist.
 */
async function scan(prev: Snapshot): Promise<{ fresh: AdminNotification[]; next: Snapshot }> {
  const fresh: AdminNotification[] = [];
  const next: Snapshot = {
    watermarks: { ...prev.watermarks },
    orderStatus: { ...prev.orderStatus },
    productHandles: [...prev.productHandles],
    collectionHandles: [...prev.collectionHandles],
    customerSessions: [...prev.customerSessions],
    initialised: true,
  };

  // On the very first scan the store is empty and every existing row would
  // otherwise arrive at once. Record the current state instead and start
  // notifying from the next change onward.
  const seeding = !prev.initialised;

  const since = (k: string) => prev.watermarks[k] ?? EPOCH;
  const bump = (k: string, at: string) => {
    if (at > (next.watermarks[k] ?? EPOCH)) next.watermarks[k] = at;
  };

  /* ── Orders: new, and status transitions ── */
  const { data: orders } = await supabaseAdmin
    .from("orders")
    .select("id, full_name, subtotal, discount, status, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  for (const o of orders ?? []) {
    const r = o as Record<string, unknown>;
    const id = String(r.id);
    const at = String(r.created_at);
    const net = Number(r.subtotal ?? 0) - Number(r.discount ?? 0);
    const ref = `#${id.slice(0, 8).toUpperCase()}`;

    if (!seeding && at > since("orders")) {
      fresh.push({
        id: idFor("order.new", id),
        type: "order.new",
        title: "New order",
        message: `${ref} · ${shortMoney(net)}${r.full_name ? ` from ${snippet(String(r.full_name), 32)}` : ""}`,
        href: `/admin/orders/${id}`,
        createdAt: at,
        read: false,
      });
    }
    bump("orders", at);

    const status = String(r.status);
    const was = prev.orderStatus[id];
    if (!seeding && was && was !== status) {
      fresh.push({
        // Keyed by the transition, so the same change is not re-announced but a
        // later one still is.
        id: idFor("order.status", `${id}:${was}->${status}`),
        type: "order.status",
        title: "Order status changed",
        message: `${ref} · ${was.replace(/_/g, " ")} → ${status.replace(/_/g, " ")}`,
        href: `/admin/orders/${id}`,
        createdAt: new Date().toISOString(),
        read: false,
      });
    }
    next.orderStatus[id] = status;
  }
  // Drop statuses for orders that no longer exist, so the snapshot cannot grow
  // forever and a deleted-then-reused id cannot fire a false transition.
  const liveIds = new Set((orders ?? []).map((o) => String((o as Record<string, unknown>).id)));
  for (const id of Object.keys(next.orderStatus)) {
    if (!liveIds.has(id)) delete next.orderStatus[id];
  }

  /* ── Customers ── */
  const { data: users } = await supabaseAdmin
    .from("users")
    .select("phone, full_name, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  for (const u of users ?? []) {
    const r = u as Record<string, unknown>;
    const at = String(r.created_at);
    if (!seeding && at > since("users")) {
      fresh.push({
        id: idFor("customer.new", String(r.phone)),
        type: "customer.new",
        title: "New customer",
        message: r.full_name ? snippet(String(r.full_name), 40) : "An account was created",
        href: "/admin/customers",
        createdAt: at,
        read: false,
      });
    }
    bump("users", at);
  }

  /* ── New visitor sessions ──
     live_visitors holds only who is online right now: a row is inserted on the
     first heartbeat of a session and deleted when the tab closes or the
     presence times out. first_seen is a column default, and the heartbeat's
     upsert does not carry it, so it stays fixed at the moment of arrival —
     which makes it the arrival signal.

     One notification per session, never per heartbeat: the watermark skips
     sessions already seen, and the id is derived from the session id, so a
     visitor whose row is deleted and recreated cannot announce twice. A
     session that begins and ends between two polls is missed rather than
     reported late — presence is not retained once someone leaves. */
  const { data: visitors } = await supabaseAdmin
    .from("live_visitors")
    .select("session_id, display_name, phone, region, country, first_seen")
    .order("first_seen", { ascending: false })
    .limit(100);

  const knownCustomerSessions = new Set(prev.customerSessions);
  const onlineCustomerSessions: string[] = [];

  for (const v of visitors ?? []) {
    const r = v as Record<string, unknown>;
    const at = String(r.first_seen);
    const sessionId = String(r.session_id);
    const place = [r.region, r.country].filter(Boolean).map(String).join(", ");
    // A session counts as a customer once it carries an identity — the
    // heartbeat only sends those when the shopper is signed in.
    const identified = Boolean(r.phone || r.display_name);

    if (identified) {
      onlineCustomerSessions.push(sessionId);
      // Fires on the session, not the heartbeat, and not on first_seen: a
      // visitor who browses anonymously and signs in later becomes a customer
      // mid-session, and that moment is what matters here.
      if (!seeding && !knownCustomerSessions.has(sessionId)) {
        const who = r.display_name ? snippet(String(r.display_name), 40) : "A customer";
        fresh.push({
          id: idFor("customer.online", sessionId),
          type: "customer.online",
          title: "Customer online",
          message: `${who} is currently browsing your store${place ? ` · ${place}` : ""}`,
          href: "/admin/customers",
          createdAt: new Date().toISOString(),
          read: false,
        });
      }
    } else if (!seeding && at > since("visitors")) {
      // Anonymous arrivals only — an identified shopper is announced above
      // rather than twice.
      fresh.push({
        id: idFor("visitor.new", sessionId),
        type: "visitor.new",
        title: "New visitor on your store",
        message: place ? `Browsing from ${place}` : "A new session started",
        href: "/admin/analytics",
        createdAt: at,
        read: false,
      });
    }
    bump("visitors", at);
  }
  // Only sessions still online are carried forward, so the list cannot grow
  // without bound and a returning customer is announced again.
  next.customerSessions = onlineCustomerSessions;

  /* ── Contact messages ── */
  const { data: contacts } = await supabaseAdmin
    .from("contacts")
    .select("id, name, subject, message, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  for (const c of contacts ?? []) {
    const r = c as Record<string, unknown>;
    const at = String(r.created_at);
    if (!seeding && at > since("contacts")) {
      fresh.push({
        id: idFor("contact.new", String(r.id)),
        type: "contact.new",
        title: "New contact message",
        message: snippet(String(r.subject || r.message || ""), 80) || "A message was submitted",
        href: "/admin/contacts",
        createdAt: at,
        read: false,
      });
    }
    bump("contacts", at);
  }

  /* ── Chat (JSON store, not a table) ── */
  const chats = await chatStore.read();
  for (const m of chats) {
    const at = String(m.createdAt);
    if (!seeding && at > since("chat")) {
      fresh.push({
        id: idFor("chat.new", m.id),
        type: "chat.new",
        title: "New chat message",
        message: snippet(m.message, 80),
        href: "/admin/chat",
        createdAt: at,
        read: false,
      });
    }
    bump("chat", at);
  }

  /* ── Return requests ── */
  const { data: returns } = await supabaseAdmin
    .from("returns")
    .select("id, order_id, reason, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  for (const t of returns ?? []) {
    const r = t as Record<string, unknown>;
    const at = String(r.created_at);
    if (!seeding && at > since("returns")) {
      fresh.push({
        id: idFor("return.new", String(r.id)),
        type: "return.new",
        title: "Return requested",
        message: `#${String(r.order_id).slice(0, 8).toUpperCase()} · ${snippet(String(r.reason ?? ""), 60)}`,
        href: "/admin/returns",
        createdAt: at,
        read: false,
      });
    }
    bump("returns", at);
  }

  /* ── Products and collections: added or removed ──
     Neither table carries updated_at, so an edit in place is not detectable
     without changing the write paths. Membership changes are. */
  const { data: products } = await supabaseAdmin.from("products").select("handle, title");
  const handles = (products ?? []).map((p) => String((p as Record<string, unknown>).handle));
  const titleOf = new Map(
    (products ?? []).map((p) => {
      const r = p as Record<string, unknown>;
      return [String(r.handle), String(r.title)] as const;
    }),
  );
  if (!seeding) {
    const before = new Set(prev.productHandles);
    for (const h of handles) {
      if (!before.has(h)) {
        fresh.push({
          id: idFor("product.change", `added:${h}`),
          type: "product.change",
          title: "Product added",
          message: snippet(titleOf.get(h) ?? h, 60),
          href: `/admin/products/${h}/edit`,
          createdAt: new Date().toISOString(),
          read: false,
        });
      }
    }
    const nowSet = new Set(handles);
    for (const h of prev.productHandles) {
      if (!nowSet.has(h)) {
        fresh.push({
          id: idFor("product.change", `removed:${h}`),
          type: "product.change",
          title: "Product removed",
          message: snippet(h, 60),
          href: "/admin/products",
          createdAt: new Date().toISOString(),
          read: false,
        });
      }
    }
  }
  next.productHandles = handles;

  const { data: collections } = await supabaseAdmin.from("collections").select("handle, title");
  const cHandles = (collections ?? []).map((c) => String((c as Record<string, unknown>).handle));
  const cTitleOf = new Map(
    (collections ?? []).map((c) => {
      const r = c as Record<string, unknown>;
      return [String(r.handle), String(r.title)] as const;
    }),
  );
  if (!seeding) {
    const before = new Set(prev.collectionHandles);
    for (const h of cHandles) {
      if (!before.has(h)) {
        fresh.push({
          id: idFor("collection.change", `added:${h}`),
          type: "collection.change",
          title: "Collection added",
          message: snippet(cTitleOf.get(h) ?? h, 60),
          href: "/admin/collections",
          createdAt: new Date().toISOString(),
          read: false,
        });
      }
    }
    const nowSet = new Set(cHandles);
    for (const h of prev.collectionHandles) {
      if (!nowSet.has(h)) {
        fresh.push({
          id: idFor("collection.change", `removed:${h}`),
          type: "collection.change",
          title: "Collection removed",
          message: snippet(h, 60),
          href: "/admin/collections",
          createdAt: new Date().toISOString(),
          read: false,
        });
      }
    }
  }
  next.collectionHandles = cHandles;

  return { fresh, next };
}

/** GET /api/admin/notifications — the feed plus its unread count. */
export async function listNotifications(_req: Request, res: Response) {
  const state = await store.read();
  const { fresh, next } = await scan(state.snapshot);

  // Merge, keeping anything already stored (and its read flag) authoritative.
  const seen = new Set(state.notifications.map((n) => n.id));
  const merged = [...fresh.filter((n) => !seen.has(n.id)), ...state.notifications]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, MAX_NOTIFICATIONS);

  const added = merged.length !== state.notifications.length || fresh.some((n) => !seen.has(n.id));
  if (added || JSON.stringify(next) !== JSON.stringify(state.snapshot)) {
    await store.write({ notifications: merged, snapshot: next });
  }

  res.json({
    ok: true,
    data: {
      notifications: merged,
      unread: merged.filter((n) => !n.read).length,
    },
  });
}

const readSchema = z.object({
  /** Omit to mark every notification read. */
  id: z.string().min(1).optional(),
});

/** POST /api/admin/notifications/read — mark one, or all, as read. */
export async function markNotificationsRead(req: Request, res: Response) {
  const { id } = readSchema.parse(req.body ?? {});
  const state = await store.read();
  const notifications = state.notifications.map((n) =>
    !id || n.id === id ? { ...n, read: true } : n,
  );
  await store.write({ ...state, notifications });
  res.json({
    ok: true,
    data: { notifications, unread: notifications.filter((n) => !n.read).length },
  });
}
