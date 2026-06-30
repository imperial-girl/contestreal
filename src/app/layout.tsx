import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PhotoShield AI - 🛡️ 딥페이크 방지 및 이미지 보호 필터",
  description: "인간의 눈에는 보이지 않지만 AI 모델의 인식을 교란하여 딥페이크 합성과 무단 도용을 원천 방쇄하는 적대적 공격 기반 이미지 보호 프로토타입",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[#09090b] text-[#fafafa]">{children}</body>
    </html>
  );
}
