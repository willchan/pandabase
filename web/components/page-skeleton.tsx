import { Skeleton } from "@/components/ui/skeleton";

export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-4">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-4 w-56" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
