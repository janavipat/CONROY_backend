import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { getProduct, listProducts } from "../controllers/products.controller.js";
import { getCollection, listCollections } from "../controllers/collections.controller.js";
import { submitContact, subscribeNewsletter } from "../controllers/engagement.controller.js";
import { createOrder, getOrder } from "../controllers/orders.controller.js";
import { login, me, register } from "../controllers/auth.controller.js";

export const router = Router();

// Catalog
router.get("/products", asyncHandler(listProducts));
router.get("/products/:handle", asyncHandler(getProduct));
router.get("/collections", asyncHandler(listCollections));
router.get("/collections/:handle", asyncHandler(getCollection));

// Engagement
router.post("/contact", asyncHandler(submitContact));
router.post("/newsletter", asyncHandler(subscribeNewsletter));

// Orders
router.post("/orders", asyncHandler(createOrder));
router.get("/orders/:id", asyncHandler(getOrder));

// Auth (Supabase Auth)
router.post("/auth/register", asyncHandler(register));
router.post("/auth/login", asyncHandler(login));
router.get("/auth/me", asyncHandler(me));
