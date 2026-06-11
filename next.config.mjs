/** @type {import('next').NextConfig} */
const nextConfig = {
  // Fully static export -> Vercel serves out/ as static files, so NO serverless
  // functions are created (transformers.js' onnxruntime/wasm binaries would
  // otherwise blow past the 250 MB function limit). The app is 100% client-side.
  output: "export",
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
