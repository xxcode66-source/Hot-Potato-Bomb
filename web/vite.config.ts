import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// near-api-js ships Node-oriented builds (no "browser" field on @near-js/*), so Vite
// externalizes http/https/crypto/buffer. Those paths are guarded by `typeof window`
// at runtime and never run in the browser; the one real gotcha is a bare `global`
// reference, so we map it to globalThis. Views use our own fetch; actions use the
// wallet-redirect signer, keeping the browser code-path clean.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  define: {
    global: "globalThis",
  },
  optimizeDeps: {
    esbuildOptions: { define: { global: "globalThis" } },
  },
});
