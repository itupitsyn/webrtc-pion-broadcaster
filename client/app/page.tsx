import { RolePicker } from "@/components/RolePicker";
import { DarkThemeToggle } from "flowbite-react";

export default function Home() {
  return (
    <main className="flex min-h-svh flex-col items-center gap-8 dark:bg-gray-800">
      <div className="mt-6 flex items-center gap-2">
        <h1 className="text-2xl">Simple broadcasting using webRTC</h1>
        <DarkThemeToggle />
      </div>
      <RolePicker />
      <div id="logs" className="flex max-h-[300px] w-full max-w-screen-sm flex-col-reverse overflow-auto" />
    </main>
  );
}
