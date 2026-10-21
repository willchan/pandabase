// GET /api/health/worker: the latest `worker_heartbeat`, read by the Mac Mini deploy health check
// (scripts/deploy/mac-update.sh, DESIGN §8).
import { systemTelemetry } from "@pandabase/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup, type Harness } from "@/test/harness";
import { HANDLERS } from "@/test/routes";

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(() => h.close());

const get = (auth?: "agent" | "worker" | "none") =>
  h.call<{ heartbeat: Record<string, unknown> | null }>(
    HANDLERS.workerHealth.GET,
    "/api/health/worker",
    auth ? { auth } : {},
  );

const beat = (
  id: string,
  createdAt: string,
  payload: Record<string, unknown>,
  source = "worker",
) => ({
  id,
  source,
  metricType: "worker_heartbeat",
  payload,
  createdAt,
});

describe("GET /api/health/worker", () => {
  it("returns null before the worker has ever sent a heartbeat", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ heartbeat: null });
  });

  it("returns the newest worker heartbeat", async () => {
    await h.db.insert(systemTelemetry).values([
      beat("01HB0000000000000000000001", "2026-10-21T10:00:00.000Z", {
        version: "0.0.0",
        sha: "aaaa",
        vlm_model: "qwen3.5:9b",
        text_model: "qwen3.5:4b",
        ollama_ok: true,
      }),
      beat("01HB0000000000000000000002", "2026-10-21T10:10:00.000Z", {
        version: "0.0.0",
        sha: "bbbb",
        vlm_model: "qwen3.5:9b",
        text_model: "qwen3.5:4b",
        ollama_ok: null,
      }),
      // Not the worker's: a spoofed agent event never counts as a heartbeat.
      beat("01HB0000000000000000000003", "2026-10-21T11:00:00.000Z", { sha: "cccc" }, "agent"),
      {
        ...beat("01HB0000000000000000000004", "2026-10-21T12:00:00.000Z", {}),
        metricType: "vlm_inference",
      },
    ]);
    const res = await get();
    expect(res.body.heartbeat).toEqual({
      at: "2026-10-21T10:10:00.000Z",
      version: "0.0.0",
      sha: "bbbb",
      vlm_model: "qwen3.5:9b",
      text_model: "qwen3.5:4b",
      ollama_ok: null,
    });
  });

  it("tolerates heartbeats without the newer fields (pre-M9 workers)", async () => {
    await h.db.insert(systemTelemetry).values(
      beat("01HB0000000000000000000005", "2026-10-21T10:00:00.000Z", {
        version: "0.0.0",
        ollama_ok: "yes",
      }),
    );
    expect((await get()).body.heartbeat).toEqual({
      at: "2026-10-21T10:00:00.000Z",
      version: "0.0.0",
      sha: null,
      vlm_model: null,
      text_model: null,
      ollama_ok: null,
    });
  });

  it("is agent-scoped", async () => {
    expect((await get("worker")).status).toBe(403);
    expect((await get("none")).status).toBe(401);
  });
});
