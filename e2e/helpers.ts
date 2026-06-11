// Shared E2E setup: Chromium with the built extension loaded, plus a local
// JSON fixture server so tests never depend on the network.
import { chromium, type BrowserContext } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

// Extensions need the full Chromium build ("chromium" channel) to work in
// headless mode; the default headless shell silently ignores --load-extension.
export async function launchWithExtension(): Promise<BrowserContext> {
  return chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), "jv-e2e-")),
    {
      channel: "chromium",
      headless: true,
      viewport: { width: 1280, height: 800 },
      colorScheme: "dark",
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
      permissions: ["clipboard-read", "clipboard-write"],
    }
  );
}

export interface FixtureServer {
  port: number;
  close: () => void;
}

// Serves the given payload for every path; pass a function to vary by URL.
export async function serveJson(
  payload: string | ((url: string) => string)
): Promise<FixtureServer> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(typeof payload === "function" ? payload(req.url ?? "/") : payload);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, close: () => server.close() };
}
