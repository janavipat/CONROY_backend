import type { Request, Response } from "express";
import { supabaseAnon } from "../lib/supabase.js";
import { ApiError } from "../middleware/errors.js";
import { authSchema } from "../validators/schemas.js";

/** POST /api/auth/register — creates a Supabase Auth user. */
export async function register(req: Request, res: Response) {
  const { email, password, firstName } = authSchema.parse(req.body);

  const { data, error } = await supabaseAnon.auth.signUp({
    email,
    password,
    options: { data: { first_name: firstName ?? null } },
  });
  if (error) throw new ApiError(400, error.message);

  res.status(201).json({
    ok: true,
    message: "Account created. Please check your email to confirm if confirmation is enabled.",
    data: { user: data.user, session: data.session },
  });
}

/** POST /api/auth/login — exchanges credentials for a Supabase session. */
export async function login(req: Request, res: Response) {
  const { email, password } = authSchema.parse(req.body);

  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error) throw new ApiError(401, error.message);

  res.json({
    ok: true,
    message: "Signed in.",
    data: { user: data.user, session: data.session },
  });
}

/** GET /api/auth/me — returns the user for a Bearer access token. */
export async function me(req: Request, res: Response) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) throw new ApiError(401, "Missing bearer token");

  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error) throw new ApiError(401, error.message);

  res.json({ ok: true, data: data.user });
}
