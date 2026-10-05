import { auth } from "@/lib/auth/auth";

export const runtime = "nodejs";

// Better Auth serves sign-up, sign-in, sign-out, verify-email and password reset under /api/auth/*
export const GET = (req: Request): Promise<Response> => auth.handler(req);
export const POST = (req: Request): Promise<Response> => auth.handler(req);
