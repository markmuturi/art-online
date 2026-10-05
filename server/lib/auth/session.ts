import { auth } from "./auth";

export type Role = "buyer" | "artist" | "admin";

export interface AppUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
}

export class HttpError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// Pass the request's headers: `req.headers` in a route handler, `await headers()` in a server component.
// The session is looked up in the database on every call, so a sign-out or ban takes effect immediately.
export async function getSessionUser(headers: Headers): Promise<AppUser | null> {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const u = session.user as typeof session.user & { role?: string };
  return { id: u.id, email: u.email, fullName: u.name, role: (u.role ?? "buyer") as Role };
}

export async function requireUser(headers: Headers): Promise<AppUser> {
  const user = await getSessionUser(headers);
  if (!user) throw new HttpError(401, "Sign in required");
  return user;
}

export async function requireRole(headers: Headers, ...allowed: Role[]): Promise<AppUser> {
  const user = await requireUser(headers);
  if (!allowed.includes(user.role)) throw new HttpError(403, "Not allowed");
  return user;
}

// Turns a thrown HttpError into a Response, so route handlers stay short:
//   try { const user = await requireUser(req.headers); ... } catch (e) { return errorResponse(e); }
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return new Response(err.message, { status: err.status });
  throw err;
}
