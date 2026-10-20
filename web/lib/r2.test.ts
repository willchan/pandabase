import { describe, expect, it } from "vitest";
import { createR2Presigner, keyframeKey, mediaKey, r2FromEnv } from "./r2";

describe("R2 presigner", () => {
  it("signs a query-string URL for the bucket key (no network)", async () => {
    const p = createR2Presigner({
      accountId: "acct",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      bucket: "media-bucket",
    });
    const url = new URL(await p.presign("PUT", "media/2026/10/abc.jpg", 900));
    expect(url.origin).toBe("https://acct.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/media-bucket/media/2026/10/abc.jpg");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(
      /^AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/,
    );
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is unusable without configuration, but doesn't throw until used", async () => {
    const p = r2FromEnv({} as NodeJS.ProcessEnv);
    await expect(p.presign("GET", "k", 60)).rejects.toThrow(/R2 is not configured/);
  });

  it("builds media and keyframe keys", () => {
    expect(mediaKey("2026-10-20T16:00:00.000Z", "01ABC", "jpg")).toBe("media/2026/10/01ABC.jpg");
    expect(keyframeKey("01JOB", 0)).toBe("keyframes/01JOB/0.jpg");
  });
});
