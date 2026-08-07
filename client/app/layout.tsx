import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Group call",
  description: "WebRTC group calling over a pion SFU",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        {/* The page chrome lives here so `/` and `/r/<room>` cannot drift apart. */}
        <main className="flex min-h-screen flex-col items-center gap-8 bg-gray-50 p-6 dark:bg-gray-900">
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Group call</h1>
          {children}
        </main>
      </body>
    </html>
  );
}
