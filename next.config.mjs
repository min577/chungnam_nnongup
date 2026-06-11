/** @type {import('next').NextConfig} */
const nextConfig = {
  // No `output: "export"` — Vercel deploys Next.js natively (the app itself is
  // fully client-side). For static hosting elsewhere, add `output: "export"`.
  images: { unoptimized: true },
  // transformers.js: don't bundle node-only backends in the browser build
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      sharp$: false,
      "onnxruntime-node$": false,
    };
    return config;
  },
};

export default nextConfig;
