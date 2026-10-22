import type { Metadata } from "next";
import { Noto_Sans_KR } from "next/font/google";
import "./globals.css";

// Self-hosted at build time: no render-blocking request to the Google font host on every page view.
const noto = Noto_Sans_KR({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-noto",
});

export const metadata: Metadata = {
  title: "WMS Lite | 고객사별 창고 운영관리",
  description: "고객사별 품목·창고·입출고 전표·재고와 확정 이력을 관리하는 WMS Lite",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" className={noto.variable}>
      <body>{children}</body>
    </html>
  );
}
