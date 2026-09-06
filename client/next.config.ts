import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: __dirname + "/..",
  devIndicators: false,
  poweredByHeader: false,
};

export default nextConfig;
