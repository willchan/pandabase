// Session lookup for API routes. The default resolver asks Auth.js (`web/auth.ts`, completed in
// M5); tests install their own with `setSessionResolver`.
export type SessionResolver = (req: Request) => Promise<{ email: string } | null>;

const authJsResolver: SessionResolver = async () => {
  const { auth } = await import("@/auth");
  const session = await auth();
  const email = session?.user?.email;
  return email ? { email } : null;
};

let resolver: SessionResolver = authJsResolver;

export const resolveSession = (req: Request) => resolver(req);

/** Replace the resolver (tests). `null` restores Auth.js. */
export function setSessionResolver(next: SessionResolver | null): void {
  resolver = next ?? authJsResolver;
}
