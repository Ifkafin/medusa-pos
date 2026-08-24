import { defineConfig, loadEnv } from "vite";
import tailwindcss from '@tailwindcss/vite';
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";

const rootDir = import.meta.dirname;

/**
 * src/plugins/ entries may be symlinks to out-of-repo plugin checkouts (see
 * src/plugins/index.ts); Vite's dev-server fs guard needs their REAL paths.
 */
function pluginRealPaths(): string[] {
  const roots = [
    path.resolve(rootDir, "src/plugins"),
    // linked (yarn link) workspace deps plugins build against
    path.resolve(rootDir, "node_modules/@narisolutions"),
  ];
  const real: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      try {
        const resolved = fs.realpathSync(path.join(root, entry));
        if (!resolved.startsWith(rootDir)) real.push(resolved);
      } catch {
        /* dangling symlink — ignore */
      }
    }
  }
  return real;
}

const host = process.env.TAURI_DEV_HOST;

function getAppVersion(): string {
  // CI sets APP_VERSION to the release version
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(rootDir, "package.json"), "utf8")
  ) as { version?: string };
  return packageJson.version ?? "dev";
}

function validateProductionTilltapOrigin(rawOrigin: string | undefined): void {
  let url: URL;
  try {
    url = new URL(rawOrigin ?? "");
  } catch {
    throw new Error(
      "Production builds require a valid HTTPS VITE_TILLTAP_ORIGIN"
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Production builds require a valid HTTPS VITE_TILLTAP_ORIGIN"
    );
  }
}

const config = {
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
    },
    // Symlinked plugin sources (src/plugins/*) and linked packages resolve bare
    // imports from their REAL location — force host-app copies for everything
    // that must be a singleton here (React tree, query/router/i18n contexts,
    // Tauri plugin bindings, form state).
    dedupe: [
      "react",
      "react-dom",
      "react-router-dom",
      "@tanstack/react-query",
      "i18next",
      "react-i18next",
      "lucide-react",
      "react-hook-form",
      "@hookform/resolvers",
      "@tauri-apps/plugin-http",
      "@tauri-apps/plugin-store",
    ],
  },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(getAppVersion()),
  },
  build: {
    // Tauri ships its own WebView — no need to downlevel for legacy browsers.
    target: "esnext",
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Vendor code changes far less often than app code; splitting it keeps
        // the big dependency chunks cached across releases.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (/[\\/](react|react-dom|react-router|react-router-dom)[\\/]/.test(id))
            return "vendor-react";
          if (id.includes("@tanstack")) return "vendor-query";
          if (id.includes("@medusajs")) return "vendor-medusa";
          if (/(react-hook-form|@hookform|zod)/.test(id)) return "vendor-forms";
        },
      },
    },
  },
  clearScreen: false,
  server: {
    port: 3000,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    fs: {
      allow: [".", ...pluginRealPaths()],
    },
  },
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, "");
  if (mode === "production") {
    validateProductionTilltapOrigin(
      process.env.VITE_TILLTAP_ORIGIN ??
        env.VITE_TILLTAP_ORIGIN ??
        (process.env.GITHUB_WORKFLOW === "CI"
          ? "https://checkout-staging.ifkafin.com"
          : undefined)
    );
  }

  return config;
});
