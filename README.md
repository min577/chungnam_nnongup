# 충남농업기술원 · 초분광 ROI 추출기

Specim IQ 초분광 영상(ENVI)에서 **Polygon / Bounding Box / SAM 자동 분할**로 ROI를 따고,
각 ROI의 **204밴드 평균 반사율 스펙트럼**을 CSV로 추출하는 웹 도구입니다.
Roboflow 스타일의 어노테이션 UX를 초분광 데이터에 맞게 구현했습니다.

> **모든 처리는 브라우저 안에서만** 이루어집니다. 데이터큐브(.dat, 한 장당 ~200MB)는
> 서버로 전송되지 않으므로 보안/용량 걱정 없이 사용할 수 있습니다. (정적 사이트 → Vercel 배포)

## 주요 기능

- **데이터 로드**: `.hdr` + `.dat`(또는 `.raw`/`.img`)를 브라우저에서 직접 파싱
  (ENVI BIL/BIP/BSQ, data type 1/2/3/4/5/12 지원)
- **RGB 합성**: 헤더의 `default bands`로 의사컬러 표시, R/G/B 밴드 슬라이더로 조정 (2–98% 대비 스트레치)
- **어노테이션 도구**
  - `폴리곤` — 클릭으로 점 추가, 첫 점/더블클릭/Enter로 완성
  - `박스` — 드래그로 사각형
  - `SAM 자동` — 객체 위를 클릭하면 [SlimSAM](https://huggingface.co/Xenova/slimsam-77-uniform)이
    영역을 자동 분할 → 폴리곤으로 변환 (transformers.js, 브라우저 실행)
  - `선택/편집` — ROI 선택, 꼭짓점 드래그 수정, 삭제
- **다중 ROI + 클래스 라벨**: 잎/병징/배경 등 라벨 지정, 색상 구분
- **스펙트럼 미리보기**: ROI별 평균 반사율 곡선 실시간 표시
- **내보내기**
  - 스펙트럼 CSV (wide: ROI×밴드)
  - 스펙트럼 CSV (long: ROI·밴드 한 행씩, pandas/R 친화)
  - ROI 좌표 JSON (COCO 유사, 보관/재현용)

## 단축키

`1` 선택 · `2` 폴리곤 · `3` 박스 · `4` SAM · `Delete` 선택 ROI 삭제 · `Esc` 그리던 도형 취소

## 로컬 실행

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # 정적 사이트 out/ 생성
```

## Vercel 배포

이 저장소를 그대로 Vercel에 연결하면 됩니다 (무설정).

1. [vercel.com](https://vercel.com) → New Project → 이 GitHub 저장소 import
2. Framework Preset: **Next.js** (자동 인식), 빌드/출력 설정 그대로 두면 됨
3. Deploy

`next.config.mjs`의 `output: "export"`로 완전 정적 빌드되며, SAM 모델 가중치는
런타임에 HuggingFace CDN에서 받아오므로 백엔드가 필요 없습니다.

## 데이터 준비 (충남농업기술원 사용자용)

Specim IQ 캡처 폴더 안에서 보정이 끝난 반사율 큐브를 사용하세요:

```
<capture>/results/REFLECTANCE_<name>.dat   ← 데이터
<capture>/results/REFLECTANCE_<name>.hdr   ← 헤더
```

두 파일을 사이트의 업로드 영역에 함께 선택(또는 드래그)하면 됩니다.

## 폴더 구조

```
app/            Next.js App Router (UI 진입점)
components/      AnnotationCanvas, SpectrumChart
lib/
  envi.ts       ENVI 헤더/큐브 파서, RGB 합성, 평균 스펙트럼 추출
  geometry.ts   마스크→폴리곤(컨투어 추적+RDP 단순화), bbox
  sam.ts        transformers.js SlimSAM 래퍼 (브라우저 실행)
  csv.ts        CSV / JSON 내보내기
scripts/        ENVI 파싱 검증 스크립트(개발용)
```
