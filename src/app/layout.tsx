import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WMS Lite | 고객사별 창고 운영관리",
  description: "고객사별 품목·창고·입출고 전표·재고와 확정 이력을 관리하는 WMS Lite",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Loaded at runtime so builds never depend on the font host. */}
        <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
