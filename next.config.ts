import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg and the Upstash client must never be bundled for the browser.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
