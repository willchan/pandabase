// Sign-in gate for the UI (Next 16 "proxy", formerly middleware): no session → /sign-in. API routes
// authenticate themselves (bearer tokens or session, `withAuth`) and answer 401 instead.
import { NextResponse } from "next/server";
import { auth } from "@/auth";

export default auth((req) => {
  if (req.auth?.user?.email) return NextResponse.next();
  const url = new URL("/sign-in", req.nextUrl);
  const back = req.nextUrl.pathname + req.nextUrl.search;
  if (back !== "/") url.searchParams.set("callbackUrl", back);
  return NextResponse.redirect(url);
});

export const config = {
  matcher: ["/((?!api/|_next/|sign-in|favicon\\.ico|icon\\.svg|manifest\\.webmanifest).*)"],
};
