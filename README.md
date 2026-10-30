# HWP 편집기

맥에서 `.hwp`/`.hwpx`를 열어 편집하고 `.hwpx`로 저장하는 편집기. 사람은 Electron 창에서, AI는 MCP·CLI로 같은 문서를 동시에 고친다(창에 바로 반영). 설계·계약: `docs/SPEC.md`.

## 설치
Apple Silicon(macOS arm64) 전용입니다. [Releases](https://github.com/wakhang/hwp-editor/releases/latest)에서 DMG를 내려받아 열고 `HwpEditor.app`을 응용 프로그램 폴더로 옮기세요. ZIP을 받아 압축을 풀어도 됩니다.

앱은 ad-hoc 서명되었으며 Apple 공증을 받지 않았습니다. Gatekeeper가 실행을 차단하면 앱을 마우스 오른쪽 버튼으로 클릭해 **열기**를 선택하거나, 터미널에서 다음 명령을 실행한 뒤 여세요.
```bash
xattr -dr com.apple.quarantine "/Applications/HwpEditor.app"
```

## 소스에서 빌드
Node.js 22.12 이상(22.x), 24.x 또는 26 이상이 필요합니다. `.hwp` 변환에 필요한 Eclipse Temurin JDK 21은 설치 스크립트가 내려받습니다.
```bash
npm install && npm --prefix ui install
bash scripts/setup-java.sh   # JDK 21 + hwp2hwpx 변환기 + jlink 런타임(vendor/jre, 앱에 포함) → vendor/ (.hwp 열기에 필요)
npm run build
```

## 실행
- 앱: `npm start` (또는 `npm run app:pack` → `out/` 아래 `.app`)
- CLI: `node dist/hwped.mjs outline|text|find|replace|apply|convert|open <file> …` (`--live`: 열려 있는 앱의 문서를 대상으로)
- MCP(stdio): `node dist/mcp.mjs` — 도구 `hwp_list/open/new/outline/find/apply/undo/save/close`. 앱이 떠 있으면 앱 문서를, 아니면 자체 세션을 편집한다.

## MCP 등록 예시
MCP 클라이언트 설정에 빌드된 파일의 절대 경로를 지정합니다.
```json
{
  "mcpServers": {
    "hwp-editor": {
      "command": "node",
      "args": ["/path/to/dist/mcp.mjs"]
    }
  }
}
```

## 제약
- `.hwp`는 열 때 HWPX로 변환하고 저장은 `.hwpx`(한글 2014 이상에서 열림). `.hwp` 쓰기 없음.
- 화면은 연속 스크롤 HTML(쪽 너비·여백, 셀 테두리·배경·세로 정렬 반영). 쪽 나눔·개체 배치는 한글과 다를 수 있다.
- 글자 겹치기 체크 상자(☑)는 보이고 문단을 다시 써도 보존된다. 그림은 `insertPicture`(UI '그림' 버튼, MCP·CLI `path`)로 넣을 수 있다. 도형·머리말 등은 보존만 한다.
- 저장한 `.hwpx` 파일은 Hancom Office 한글 2014 이상에서 열 수 있다.

## 테스트
`npm test` (core·convert·server·MCP) · `npm --prefix ui test`

## 라이선스
MIT. 제3자 라이선스와 상표 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 참고하세요.

본 제품은 한글과컴퓨터의 한/글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
