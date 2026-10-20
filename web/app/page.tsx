import { APP_NAME, APP_TAGLINE } from "@/lib/app";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">{APP_NAME}</h1>
      <p className="text-zinc-600 dark:text-zinc-400">{APP_TAGLINE}</p>
    </main>
  );
}
