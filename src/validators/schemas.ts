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
  items: z.array(orderItemSchema).min(1, "An order needs at least one item"),
});

export const authSchema = z.object({
  email: z.string().email("A valid email is required"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  firstName: z.string().max(120).optional(),
});

export type ContactInput = z.infer<typeof contactSchema>;
export type NewsletterInput = z.infer<typeof newsletterSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type AuthInput = z.infer<typeof authSchema>;
