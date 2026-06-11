# 로고 파일 위치

아래 3개 파일을 이 `public/` 폴더에 넣으면 사이트에 자동으로 표시됩니다.
파일이 없으면 헤더는 무지개 마크로, 협력기관 로고는 자동으로 숨김 처리됩니다.

| 파일명 | 내용 | 표시 위치 |
|--------|------|-----------|
| `logo-cnaes.png` | 충청남도농업기술원 로고 | 헤더 좌측 (브랜드) |
| `logo-agis.png`  | AGIS · Agriculture Intelligence Systems Lab | 좌측 사이드바 하단 |
| `logo-khu.png`   | 경희대학교(Kyung Hee University) | 좌측 사이드바 하단 |

- PNG(투명 배경 권장) 또는 SVG 사용 가능. SVG면 확장자를 맞춰 `logo-*.svg`로 바꾸고
  `app/page.tsx`의 `src` 경로도 함께 수정하세요.
- 헤더 로고는 높이 34px, 협력기관 로고는 최대 높이 40px로 표시됩니다.
