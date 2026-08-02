import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import path from "path";
import { readFileSync } from "fs";

const host = process.env.TAURI_DEV_HOST;
const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf-8"),
) as { version: string };
const appVersion = pkg.version;
const sentryRelease = `tendencys-desktop@${appVersion}`;
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;

export default defineConfig(async () => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      // Upload sourcemaps only when CI (or a local release build) provides a token.
      ...(sentryAuthToken
        ? [
            sentryVitePlugin({
              org: "envia",
              project: "tendencys-desktop-app",
              authToken: sentryAuthToken,
              release: {
                name: sentryRelease,
              },
              sourcemaps: {
                filesToDeleteAfterUpload: ["./dist/**/*.map"],
              },
            }),
          ]
        : []),
    ],
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    clearScreen: false,
    build: {
      sourcemap: "hidden",
    },
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
