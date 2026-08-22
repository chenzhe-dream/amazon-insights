import type { NextConfig } from "next";

const MAX_FEEDBACK_MULTIPART_BYTES = 3 * 5 * 1_048_576 + 128 * 1_024;

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: MAX_FEEDBACK_MULTIPART_BYTES,
    },
  },
};

export default nextConfig;
