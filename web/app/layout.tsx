import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "社内文書 RAG チャット",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
