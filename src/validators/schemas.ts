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
  code: z.string().max(40).optional(),
  items: z.array(orderItemSchema).min(1, "An order needs at least one item"),
});

// Offers / discounts.
export const OFFER_TYPES = ["all_products", "product", "order_above", "code"] as const;

export const offerSchema = z
  .object({
    title: z.string().min(1, "Give the offer a name").max(160),
    type: z.enum(OFFER_TYPES),
    discountType: z.enum(["percent", "flat"]).default("percent"),
    discountValue: z.coerce.number().int().nonnegative("Discount must be 0 or more"),
    productHandle: z.string().max(160).optional().nullable(),
    minOrderAmount: z.coerce.number().int().nonnegative().optional().nullable(),
    code: z.string().max(40).optional().nullable(),
    active: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.discountType === "percent" && v.discountValue > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["discountValue"], message: "Percent can't exceed 100" });
    }
    if (v.type === "product" && !v.productHandle) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["productHandle"], message: "Pick a product" });
    }
    if (v.type === "order_above" && !v.minOrderAmount) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["minOrderAmount"], message: "Set a minimum order amount" });
    }
    if (v.type === "code" && !v.code?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["code"], message: "Enter a coupon code" });
    }
  });
export type OfferInput = z.infer<typeof offerSchema>;

export const applyOfferSchema = z.object({
  items: z.array(orderItemSchema).min(1, "Cart is empty"),
  code: z.string().max(40).optional(),
});

// Order return / replacement. The client sends which order + items (handle,
// size, quantity) to return; the server snapshots authoritative titles/prices.
export const returnItemSchema = z.object({
  productHandle: z.string().min(1),
  size: z.string().min(1),
  quantity: z.number().int().positive().max(99),
});

export const createReturnSchema = z.object({
  orderId: z.string().uuid("A valid order id is required"),
  reason: z.string().min(1, "Please choose a reason").max(500),
  resolution: z.enum(["refund", "replacement"]).default("refund"),
  items: z.array(returnItemSchema).min(1, "Select at least one item to return"),
});

export const RETURN_STATUSES = [
  "requested",
  "approved",
  "rejected",
  "refunded",
  "replaced",
  "completed",
] as const;

export const updateReturnStatusSchema = z.object({
  status: z.enum(RETURN_STATUSES),
});

// Razorpay: create a payment order (client sends only handle/size/qty; the
// server computes the authoritative amount).
export const razorpayOrderSchema = z.object({
  items: z.array(orderItemSchema).min(1, "An order needs at least one item"),
  code: z.string().max(40).optional(),
});

// Razorpay: verify a completed payment and place the order. Includes the same
// order fields as checkout plus the three values Razorpay Checkout returns.
export const razorpayVerifySchema = z.object({
  email: z.string().email("A valid email is required"),
  fullName: z.string().min(1).max(160).optional(),
  phone: z.string().max(40).optional(),
  shippingAddress: z.string().max(1000).optional(),
  items: z.array(orderItemSchema).min(1, "An order needs at least one item"),
  code: z.string().max(40).optional(),
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
});

// Product review (rating + feedback + photos). Images are URLs already uploaded.
export const reviewSchema = z.object({
  author: z.string().min(1, "Please enter your name").max(80),
  rating: z.coerce.number().int().min(1, "Please pick a rating").max(5),
  title: z.string().max(120).optional().default(""),
  body: z.string().max(3000).optional().default(""),
  images: z.array(z.string().url()).max(6).default([]),
});
export type ReviewInput = z.infer<typeof reviewSchema>;

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
  stock: z.coerce.number().int().nonnegative().default(0),
  sku: z.string().max(80).optional().default(""),
  status: z.enum(["active", "draft", "archived"]).default("active"),
  sizes: z.array(z.string().max(12)).default([]),
  details: z.array(z.string().max(300)).default([]),
  badge: z.string().max(40).nullable().optional(),
  images: z
    .array(z.object({ src: z.string().url(), alt: z.string().max(200).optional().default("") }))
    .default([]),
});
export type AdminProductInput = z.infer<typeof adminProductSchema>;

// Admin: create / update a collection.
export const adminCollectionSchema = z.object({
  title: z.string().min(1, "Title is required").max(160),
  handle: z.string().max(160).optional(),
  subtitle: z.string().max(300).optional().default(""),
  description: z.string().max(4000).optional().default(""),
  image: z.string().url().optional().or(z.literal("")).default(""),
});
export type AdminCollectionInput = z.infer<typeof adminCollectionSchema>;

// Admin: set the products belonging to a collection (ordered handles).
export const collectionProductsSchema = z.object({
  productHandles: z.array(z.string().min(1)).default([]),
});

// Admin: update inventory fields for a product.
export const inventoryUpdateSchema = z.object({
  stock: z.coerce.number().int().nonnegative().optional(),
  sku: z.string().max(80).optional().nullable(),
  status: z.enum(["active", "draft", "archived"]).optional(),
});

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
  // "signin" (must already have an account) or "signup" (must be a new number).
  mode: z.enum(["signin", "signup"]).default("signin"),
});

export const phoneVerifySchema = z.object({
  phone: z.string().trim().min(8),
  code: z.string().trim().regex(/^[0-9]{4,8}$/, "Enter the code sent to your phone"),
  mode: z.enum(["signin", "signup"]).default("signin"),
  // Full name is required to create an account (signup).
  fullName: z.string().trim().min(1).max(120).optional(),
  // Optional email collected at signup — used for the welcome email.
  email: z.string().email().optional().or(z.literal("")),
});

export type ContactInput = z.infer<typeof contactSchema>;
export type NewsletterInput = z.infer<typeof newsletterSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/** Delivery lifecycle states an order moves through. */
export const FULFILLMENT_STATUSES = [
  "Pending",
  "Confirmed",
  "Processing",
  "Packed",
  "Shipped",
  "Out For Delivery",
  "Delivered",
  "Cancelled",
] as const;

/** Only these early states may still be cancelled by the customer. */
export const CANCELLABLE_STATUSES = ["Pending", "Confirmed", "Processing"] as const;

export const REFUND_STATUSES = [
  "None",
  "Initiated",
  "Processing",
  "Completed",
  "Failed",
] as const;

/**
 * Customer-initiated cancellation. `phone` identifies the requester — the same
 * ownership model the order-history endpoint already uses.
 */
export const cancelOrderSchema = z.object({
  reason: z.string().min(1, "A cancellation reason is required").max(160),
  customReason: z.string().max(500).optional().or(z.literal("")),
  phone: z.string().min(6, "A phone number is required").max(20),
});

export type AuthInput = z.infer<typeof authSchema>;
