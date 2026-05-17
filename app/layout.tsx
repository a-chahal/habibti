import type { Metadata } from "next";
import "./globals.css";
import "@/lib/boot";

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
      <body className="antialiased">{children}</body>
    </html>
  );
}
