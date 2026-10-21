import { betterAuth } from "better-auth";
import { getPool } from "../db/pool";
import { authenticationRateLimit } from "./rate-limit.mjs";

function createAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = process.env.BETTER_AUTH_URL;
  if (!secret || secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
  }
  if (!baseURL) throw new Error("BETTER_AUTH_URL is required.");
  const url = new URL(baseURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error("BETTER_AUTH_URL must be an HTTP(S) URL without credentials.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:" && !loopback) {
    throw new Error("Production authentication requires an HTTPS BETTER_AUTH_URL.");
  }
  return betterAuth({
    database: getPool(),
    secret,
    baseURL,
    trustedOrigins: [url.origin],
    advanced: { useSecureCookies: url.protocol === "https:" },
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: {
      expiresIn: 60 * 60 * 24,
      updateAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    rateLimit: authenticationRateLimit,
    telemetry: { enabled: false },
  });
}

let auth: ReturnType<typeof createAuth> | undefined;

// Defer environment and DB access until a request, including during builds.
export function getAuth() {
  return auth ??= createAuth();
}
