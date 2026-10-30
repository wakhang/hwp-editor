# HWP 편집기 (개인용)

맥에서 `.hwp`/`.hwpx`를 열어 편집하고 `.hwpx`로 저장하는 편집기. 사람은 Electron 창에서, AI는 MCP·CLI로 같은 문서를 동시에 고친다(창에 바로 반영). 설계·계약: `docs/SPEC.md`.

## 설치
```bash
npm install && npm --prefix ui install
bash scripts/setup-java.sh   # JDK 21 + hwp2hwpx 변환기 → vendor/ (.hwp 열기에 필요)
npm run build
```

## 실행
- 앱: `npm start` (또는 `npm run app:pack` → `out/` 아래 `.app`)
- CLI: `node dist/hwped.mjs outline|text|find|replace|apply|convert|open <file> …` (`--live`: 열려 있는 앱의 문서를 대상으로)
- MCP(stdio): `node dist/mcp.mjs` — 도구 `hwp_list/open/new/outline/find/apply/undo/save/close`. 앱이 떠 있으면 앱 문서를, 아니면 자체 세션을 편집한다.

## 제약
- `.hwp`는 열 때 HWPX로 변환하고 저장은 `.hwpx`(한글 2014 이상에서 열림). `.hwp` 쓰기 없음.
- 화면은 연속 스크롤 HTML(쪽 너비·여백만 반영). 쪽 나눔·개체 배치는 한글과 다를 수 있다. 그림·도형·머리말 등은 보존만 하고 편집하지 않는다.
- 이 맥에는 한글이 없어서, 저장한 파일은 자체 재열기·구조 검사로만 확인했다.

## 테스트
`npm test` (core·convert·server·MCP) · `npm --prefix ui test`
