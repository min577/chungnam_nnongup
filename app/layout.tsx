import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "충남농업기술원 · 초분광 ROI 추출기",
  description:
    "Specim IQ 초분광 영상에서 Polygon / BBox / SAM 자동 분할로 ROI를 따고 평균 반사율 스펙트럼을 CSV로 추출하는 웹 도구",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
