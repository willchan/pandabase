// Regression: in a cloud session `make prod-copy` failed with a bare "fetch failed". Node's
// built-in fetch (used by @libsql/client over HTTP) ignores HTTPS_PROXY unless
// NODE_USE_ENV_PROXY=1, so the request skipped the agent proxy that adds the read-only token and
// went straight to a host the sandbox can't reach. This runs the real `prod-copy` package script
// against a fake proxy and checks that the request goes through it.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let server: Server | undefined;
afterEach(() => server?.close());

it("prod-copy sends its Turso request through HTTPS_PROXY", { timeout: 60_000 }, async () => {
  const connects: string[] = [];
  server = createServer((_req, res) => res.writeHead(502).end());
  server.on("connect", (req, socket) => {
    connects.push(req.url ?? "");
    // Refuse the tunnel: the script then fails fast without touching anything real.
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    NO_PROXY: "",
    no_proxy: "",
    PROD_RO_TURSO_URL: "libsql://prod-copy-test.example.invalid",
    PROD_RO_TOKEN_FROM_PROXY: "1",
  };
  delete env.PROD_RO_TURSO_TOKEN;
  delete env.NODE_USE_ENV_PROXY; // the script itself must turn it on
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn("pnpm", ["run", "--silent", "prod-copy"], {
      cwd: pkgDir,
      env,
      stdio: "ignore",
    });
    child.on("close", resolve);
  });

  expect(code).not.toBe(0);
  expect(connects).toContain("prod-copy-test.example.invalid:443");
});
