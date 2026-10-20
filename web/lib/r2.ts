// Cloudflare R2 presigned URLs (S3-compatible SigV4 query signing via aws4fetch). Media never
// passes through Vercel: the agent PUTs bytes straight to R2, the worker GETs them (DESIGN §5).
import { AwsV4Signer } from "aws4fetch";

export interface Presigner {
  /** Presigned URL for `method` on `key`, valid for `expiresIn` seconds. */
  presign(method: "GET" | "PUT", key: string, expiresIn: number): Promise<string>;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function createR2Presigner(cfg: R2Config): Presigner {
  const endpoint = `https://${cfg.accountId}.r2.cloudflarestorage.com`;
  return {
    async presign(method, key, expiresIn) {
      const url = new URL(
        `${endpoint}/${cfg.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`,
      );
      url.searchParams.set("X-Amz-Expires", String(expiresIn));
      const signer = new AwsV4Signer({
        url: url.toString(),
        method,
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
        service: "s3",
        region: "auto",
        signQuery: true,
      });
      const signed = await signer.sign();
      return signed.url.toString();
    },
  };
}

/** Presigner from `R2_*` env vars; throws on use (not on startup) when they're missing. */
export function r2FromEnv(env: NodeJS.ProcessEnv = process.env): Presigner {
  const cfg = {
    accountId: env.R2_ACCOUNT_ID ?? "",
    accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
    bucket: env.R2_BUCKET ?? "",
  };
  const missing = Object.entries(cfg)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    return {
      presign: async () => {
        throw new Error(`R2 is not configured (missing ${missing.join(", ")})`);
      },
    };
  }
  return createR2Presigner(cfg);
}

/** `media/{yyyy}/{mm}/{id}.{ext}` (DESIGN §5 step 2). */
export const mediaKey = (now: string, id: string, ext: string): string =>
  `media/${now.slice(0, 4)}/${now.slice(5, 7)}/${id}.${ext}`;

/** `keyframes/{job_id}/{n}.jpg` (DESIGN §5 step 4). */
export const keyframeKey = (jobId: string, n: number): string => `keyframes/${jobId}/${n}.jpg`;
