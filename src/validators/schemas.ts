import { z } from "zod";

export const contactSchema = z.object({
  name: z.string().min(1, "Name is required").max(120),
  email: z.string().email("A valid email is required"),
  phone: z.string().max(40).optional().or(z.literal("")),
  subject: z.string().min(1, "Subject is required").max(160),
  message: z.string().min(10, "Message must be at least 10 characters").max(5000),
});

export const newsletterSchema = z.object({
  email: z.string().email("A valid email is required"),
});

export const orderItemSchema = z.object({
  productHandle: z.string().min(1),
  size: z.string().min(1),
  quantity: z.number().int().positive().max(99),
});

export const createOrderSchema = z.object({
  email: z.string().email("A valid email is required"),
  fullName: z.string().min(1).max(160).optional(),
  phone: z.string().max(40).optional(),
  shippingAddress: z.string().max(1000).optional(),
  paymentMethod: z.enum(["online", "cod"]).default("online"),
  items: z.array(orderItemSchema).min(1, "An order needs at least one item"),
});

// Admin: create / update a product. Images are URLs (already uploaded to storage).
export const adminProductSchema = z.object({
  title: z.string().min(1, "Name is required").max(160),
  handle: z.string().max(160).optional(),
  tagline: z.string().max(300).optional().default(""),
  description: z.string().max(4000).optional().default(""),
  color: z.string().max(40).default(""),
  fit: z.string().min(1, "Type is required").max(60),
  price: z.coerce.number().int().nonnegative("Price must be 0 or more"),
  currency: z.string().max(8).default("INR"),
  sizes: z.array(z.string().max(12)).default([]),
  details: z.array(z.string().max(300)).default([]),
  badge: z.string().max(40).nullable().optional(),
  images: z
    .array(z.object({ src: z.string().url(), alt: z.string().max(200).optional().default("") }))
    .default([]),
});
export type AdminProductInput = z.infer<typeof adminProductSchema>;

export const authSchema = z.object({
  email: z.string().email("A valid email is required"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  firstName: z.string().max(120).optional(),
});

// Phone OTP — accepts a 10-digit local number or a full E.164 (+CC…) number.
export const phoneStartSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9\s-]{8,16}$/, "Enter a valid phone number"),
});

export const phoneVerifySchema = z.object({
  phone: z.string().trim().min(8),
  code: z.string().trim().regex(/^[0-9]{4,8}$/, "Enter the code sent to your phone"),
});

export type ContactInput = z.infer<typeof contactSchema>;
export type NewsletterInput = z.infer<typeof newsletterSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type AuthInput = z.infer<typeof authSchema>;
