import { betterAuth } from "better-auth";
import { pool } from "../db";
import { sendEmail } from "../email";

// Never await email sends inside these callbacks. A slow response for real accounts and a fast one for
// unknown accounts lets an attacker discover which emails are registered.
function sendInBackground(to: string, subject: string, text: string): void {
  sendEmail({ to, subject, text }).catch((err) => console.error("Email send failed", subject, err));
}

const timestamps = { createdAt: "created_at", updatedAt: "updated_at" } as const;

export const auth = betterAuth({
  appName: "Art Online",
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET, // 32+ random characters: openssl rand -base64 32
  database: pool,

  // Map Better Auth's model onto our own tables and column names.
  user: {
    modelName: "users",
    fields: { name: "full_name", emailVerified: "email_verified", ...timestamps },
    additionalFields: {
      // input:false means a sign-up request can never set this. Otherwise anyone could register as an admin.
      role: { type: "string", required: false, defaultValue: "buyer", input: false },
      phone: { type: "string", required: false },
    },
  },
  session: {
    modelName: "sessions",
    fields: { userId: "user_id", expiresAt: "expires_at", ipAddress: "ip_address", userAgent: "user_agent", ...timestamps },
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // extend the session at most once a day
  },
  account: {
    modelName: "accounts",
    fields: {
      userId: "user_id",
      accountId: "account_id",
      providerId: "provider_id",
      accessToken: "access_token",
      refreshToken: "refresh_token",
      idToken: "id_token",
      accessTokenExpiresAt: "access_token_expires_at",
      refreshTokenExpiresAt: "refresh_token_expires_at",
      ...timestamps,
    },
  },
  verification: {
    modelName: "verifications",
    fields: { expiresAt: "expires_at", ...timestamps },
  },

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true, // payouts go to these people, so no unverified accounts
    autoSignIn: false,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    sendResetPassword: async ({ user, url }) => {
      sendInBackground(user.email, "Reset your Art Online password", `Reset your password here:\n\n${url}\n\nIf you did not ask for this, ignore this email.`);
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      sendInBackground(user.email, "Verify your Art Online email", `Confirm your email address here:\n\n${url}`);
    },
  },

  rateLimit: {
    enabled: true, // off by default outside production, so switch it on explicitly
    storage: "database",
    modelName: "rate_limits",
    fields: { lastRequest: "last_request" },
    window: 60,
    max: 60,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 5 },
      "/request-password-reset": { window: 60, max: 3 },
    },
  },

  advanced: {
    database: { generateId: "uuid" },
    // The rate limiter keys on client IP. Set this to the header your host really sets (Vercel and Cloudflare differ)
    // and make sure clients cannot spoof it, or the limit is decoration.
    ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
  },
});
