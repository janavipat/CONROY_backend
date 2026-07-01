import { Router } from "express";
import multer from "multer";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAdmin } from "../middleware/adminAuth.js";
import { getProduct, listProducts } from "../controllers/products.controller.js";
import { getCollection, listCollections } from "../controllers/collections.controller.js";
import { submitContact, subscribeNewsletter } from "../controllers/engagement.controller.js";
import { createOrder, getOrder, listOrdersByPhone } from "../controllers/orders.controller.js";
import {
  login,
  me,
  register,
  startPhoneOtp,
  verifyPhoneOtp,
} from "../controllers/auth.controller.js";
import {
  createProduct,
  deleteProduct,
  listAllOrders,
  listCustomers,
  updateProduct,
  uploadImage,
} from "../controllers/admin.controller.js";
import {
  createReview,
  listReviews,
  uploadReviewImage,
} from "../controllers/reviews.controller.js";

export const router = Router();

// In-memory upload (buffer is streamed to Supabase Storage, not saved to disk).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// Catalog
router.get("/products", asyncHandler(listProducts));
router.get("/products/:handle", asyncHandler(getProduct));

// Reviews (ratings + feedback + photos)
router.get("/products/:handle/reviews", asyncHandler(listReviews));
router.post("/products/:handle/reviews", asyncHandler(createReview));
router.post("/reviews/upload", upload.single("file"), asyncHandler(uploadReviewImage));
router.get("/collections", asyncHandler(listCollections));
router.get("/collections/:handle", asyncHandler(getCollection));

// Engagement
router.post("/contact", asyncHandler(submitContact));
router.post("/newsletter", asyncHandler(subscribeNewsletter));

// Orders
router.post("/orders", asyncHandler(createOrder));
router.get("/orders", asyncHandler(listOrdersByPhone));
router.get("/orders/:id", asyncHandler(getOrder));

// Auth (Supabase Auth)
router.post("/auth/register", asyncHandler(register));
router.post("/auth/login", asyncHandler(login));
router.get("/auth/me", asyncHandler(me));

// Phone OTP login
router.post("/auth/phone/start", asyncHandler(startPhoneOtp));
router.post("/auth/phone/verify", asyncHandler(verifyPhoneOtp));

// Admin — everything under /admin requires the admin key (x-admin-key header).
router.use("/admin", requireAdmin);
// Lightweight endpoint the frontend uses to validate the entered key.
router.get("/admin/verify", (_req, res) => res.json({ ok: true }));
router.post("/admin/upload", upload.single("file"), asyncHandler(uploadImage));
router.post("/admin/products", asyncHandler(createProduct));
router.put("/admin/products/:handle", asyncHandler(updateProduct));
router.delete("/admin/products/:handle", asyncHandler(deleteProduct));
router.get("/admin/orders", asyncHandler(listAllOrders));
router.get("/admin/customers", asyncHandler(listCustomers));
