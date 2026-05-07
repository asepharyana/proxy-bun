import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Edge Proxy Relay",
  description: "Securely relay requests through Vercel Edge",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
