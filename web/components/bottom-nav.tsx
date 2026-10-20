"use client";

import { BarChart3Icon, CalendarCheckIcon, InboxIcon, PackageIcon, SettingsIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/", label: "This Week", icon: CalendarCheckIcon },
  { href: "/cleanup", label: "Cleanup", icon: InboxIcon },
  { href: "/pantry", label: "Pantry", icon: PackageIcon },
  { href: "/insights", label: "Insights", icon: BarChart3Icon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
] as const;

/** Thumb-reach tab bar. `cleanupCount` marks Cleanup when reviews are waiting. */
export function BottomNav({ cleanupCount }: { cleanupCount: number | null }) {
  const path = usePathname();
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-20 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-card/80"
    >
      <ul className="mx-auto grid max-w-2xl grid-cols-5">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          const count = href === "/cleanup" ? cleanupCount : null;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted-foreground transition-colors outline-none focus-visible:bg-accent",
                  active && "text-primary",
                )}
              >
                <span className="relative">
                  <Icon className="size-5" aria-hidden="true" />
                  {count ? (
                    <span className="absolute -top-1.5 -right-2.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 text-primary-foreground">
                      {count}
                    </span>
                  ) : null}
                </span>
                <span>
                  {label}
                  {count ? <span className="sr-only"> ({count} waiting)</span> : null}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
