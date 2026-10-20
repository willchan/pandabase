import { reviewItem } from "@pandabase/db";
import { count, eq } from "drizzle-orm";
import { Suspense } from "react";
import { BottomNav } from "@/components/bottom-nav";
import { currentMember } from "@/lib/auth/current";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-30 focus:rounded-md focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <main id="main" className="flex-1 px-4 pt-5 pb-28">
        {children}
      </main>
      <Suspense fallback={<BottomNav cleanupCount={null} />}>
        <NavWithCount />
      </Suspense>
    </div>
  );
}

async function NavWithCount() {
  const { db } = await currentMember();
  const [row] = await db
    .select({ n: count() })
    .from(reviewItem)
    .where(eq(reviewItem.status, "pending"));
  return <BottomNav cleanupCount={row?.n ?? 0} />;
}
