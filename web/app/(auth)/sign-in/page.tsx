import { ShoppingBasketIcon } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { auth, DEV_PROVIDER_ID, signIn } from "@/auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { APP_NAME } from "@/lib/app";
import { devBypassEnabled } from "@/lib/auth/allowlist";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  AccessDenied: "That Google account isn't on this household's list.",
  NotAMember: "You're allowed in, but there's no household member with that email yet.",
  CredentialsSignin: "That email isn't on the allowed list.",
};

export default function SignInPage(props: PageProps<"/sign-in">) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader className="justify-items-center text-center">
          <ShoppingBasketIcon className="mb-2 size-9 text-primary" aria-hidden="true" />
          <CardTitle className="text-2xl">{APP_NAME}</CardTitle>
          <CardDescription>Groceries, handled. Sign in to see what needs you.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Suspense fallback={<Button disabled>Sign in with Google</Button>}>
            <SignInOptions searchParams={props.searchParams} />
          </Suspense>
        </CardContent>
      </Card>
    </main>
  );
}

async function SignInOptions({ searchParams }: Pick<PageProps<"/sign-in">, "searchParams">) {
  await connection();
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const error = one(params.error);
  const back = one(params.callbackUrl);
  // Only same-site paths.
  const redirectTo = back?.startsWith("/") && !back.startsWith("//") ? back : "/";
  const session = await auth();
  if (session?.user?.email && error !== "NotAMember") redirect(redirectTo);
  const devEmails = devBypassEnabled()
    ? (process.env.ALLOWED_EMAILS ?? "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
    : [];

  return (
    <>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{ERRORS[error] ?? "Sign-in didn't work. Try again."}</AlertDescription>
        </Alert>
      ) : null}
      <form
        action={async () => {
          "use server";
          await signIn("google", { redirectTo });
        }}
      >
        <Button type="submit" size="lg" className="w-full">
          Sign in with Google
        </Button>
      </form>
      {devEmails.length > 0 ? (
        <div className="mt-2 flex flex-col gap-2 border-t pt-4">
          <p className="text-xs text-muted-foreground">Development sign-in (DEV_AUTH_BYPASS)</p>
          {devEmails.map((email) => (
            <form
              key={email}
              action={async () => {
                "use server";
                await signIn(DEV_PROVIDER_ID, { email, redirectTo });
              }}
            >
              <Button type="submit" variant="outline" className="w-full">
                Continue as {email}
              </Button>
            </form>
          ))}
        </div>
      ) : null}
    </>
  );
}
