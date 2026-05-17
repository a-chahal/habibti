import type { Metadata } from "next";
import "./globals.css";
import "@/lib/boot";

import GlobalBackgroundMap from "@/components/GlobalBackgroundMap";

export const metadata: Metadata = {
  title: "habibti",
  description: "AI-powered import intelligence",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased bg-[#0a0a0a]">
        <GlobalBackgroundMap />
        <div className="relative z-10 w-full min-h-screen pointer-events-none">
          {children}
        </div>
      </body>
    </html>
  );
}
