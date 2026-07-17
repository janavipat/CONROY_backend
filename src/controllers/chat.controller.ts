import crypto from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { jsonStore } from "../lib/blobStore.js";
import { ApiError } from "../middleware/errors.js";

interface ChatMessage {
  id: string;
  name: string | null;
  email: string | null;
  message: string;
  status: "new" | "read" | "replied" | "closed";
  createdAt: string;
}

const store = jsonStore<ChatMessage[]>("chat-messages.json", []);

const chatSchema = z.object({
  name: z.string().max(120).optional(),
  email: z.string().max(160).optional(),
  message: z.string().min(1, "Message is required").max(4000),
});

/** POST /api/chat — a visitor's message from the storefront chat widget. */
export async function submitChat(req: Request, res: Response) {
  const input = chatSchema.parse(req.body);
  const list = await store.read();
  list.unshift({
    id: crypto.randomUUID(),
    name: input.name?.trim() || null,
    email: input.email?.trim() || null,
    message: input.message.trim(),
    status: "new",
    createdAt: new Date().toISOString(),
  });
  if (list.length > 5000) list.length = 5000;
  await store.write(list);
  res.json({ ok: true, message: "Thank you for contacting us. Our team will get back to you shortly." });
}

/** GET /api/admin/chat — all chat messages (newest first). */
export async function listChat(_req: Request, res: Response) {
  res.json({ ok: true, data: await store.read() });
}

const statusSchema = z.object({ status: z.enum(["new", "read", "replied", "closed"]) });

/** PATCH /api/admin/chat/:id — update a message's status. */
export async function setChatStatus(req: Request, res: Response) {
  const { status } = statusSchema.parse(req.body);
  const list = await store.read();
  const msg = list.find((m) => m.id === req.params.id);
  if (!msg) throw new ApiError(404, "Message not found.");
  msg.status = status;
  await store.write(list);
  res.json({ ok: true, message: "Status updated." });
}

/** DELETE /api/admin/chat/:id — remove a message. */
export async function deleteChat(req: Request, res: Response) {
  const list = (await store.read()).filter((m) => m.id !== req.params.id);
  await store.write(list);
  res.json({ ok: true, message: "Message deleted." });
}
