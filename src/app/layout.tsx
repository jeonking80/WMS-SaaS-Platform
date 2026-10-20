import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WMS Lite | 고객사별 창고 운영관리",
  description: "고객사별 품목·창고·입출고 전표·재고와 확정 이력을 관리하는 WMS Lite",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
