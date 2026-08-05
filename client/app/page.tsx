import { Call } from "@/components/Call";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center gap-8 bg-gray-50 p-6 dark:bg-gray-900">
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Group call</h1>
      <Call />
    </main>
  );
}
