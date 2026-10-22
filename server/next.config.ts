import type { NextConfig } from "next";

// Cheap, safe defaults. A Content-Security-Policy is deliberately not here yet: a wrong one breaks
// the site in ways that are hard to see, so it should be added once the pages stop changing.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Native modules stay out of the bundle and are loaded from node_modules at runtime.
  serverExternalPackages: ["sharp", "pg"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
