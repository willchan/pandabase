// SQL bridge for the system test's remote mode (tests/system/remote.py `BridgeDb`): one JSON
// request per stdin line, `{sql, args}` → `{rows: [{column: value}]}` or `{error}` per stdout line.
// Run with cwd = db/ so `@libsql/client` resolves; BRIDGE_DATABASE_URL / BRIDGE_AUTH_TOKEN.
import { createClient } from "@libsql/client";
import { createInterface } from "node:readline";

const client = createClient({
  url: process.env.BRIDGE_DATABASE_URL,
  authToken: process.env.BRIDGE_AUTH_TOKEN || undefined,
});
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  let out;
  try {
    const { sql, args } = JSON.parse(line);
    const res = await client.execute({ sql, args });
    out = { rows: res.rows.map((r) => Object.fromEntries(res.columns.map((c, i) => [c, r[i]]))) };
  } catch (err) {
    out = { error: String(err?.message ?? err) };
  }
  process.stdout.write(
    JSON.stringify(out, (_, v) => (typeof v === "bigint" ? Number(v) : v)) + "\n",
  );
}
client.close();
