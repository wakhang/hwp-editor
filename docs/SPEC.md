# hwp-editor — 설계/계약

개인용 맥 HWP/HWPX 편집기. 사람(Electron 창)과 AI(MCP·CLI)가 같은 열린 문서를 함께 편집한다.

## 결정
- 편집·저장 형식은 HWPX 하나. `.hwp`는 열 때 Java `hwp2hwpx`(neolord0, Apache-2.0)로 HWPX로 바꾼 뒤 편집하고, 저장 기본값은 같은 이름의 `.hwpx`. `.hwp` 쓰기는 하지 않는다.
- 원본 XML 보존(in-place 편집): 모델이 모르는 요소(머리말, 각주, 필드, 도형 등)는 손대지 않고 그대로 저장한다. 고친 문단은 `hp:linesegarray`를 지운다(한글이 다시 계산).
- 화면은 연속 스크롤 HTML(쪽 너비·여백만 반영, 쪽 나눔 계산 없음). 한글과 같은 조판은 범위 밖.
- 셸은 Electron(Rust/Xcode 없음 → Tauri 대신). UI는 웹이라 나중에 셸 교체 가능.
- 런타임: Node 24 / TypeScript(ESM). 빌드 esbuild + Vite, 테스트 vitest.

## 구조
```
src/core/      HWPX 코어 — types.ts(계약), hwpx 패키지 입출력, 모델 생성, op 적용, undo/redo
src/convert/   hwp→hwpx (java 하위 프로세스)
src/server/    SessionManager + HTTP/WebSocket API (127.0.0.1)
src/mcp/       MCP stdio 서버 (실행 중인 앱이 있으면 그 API로, 없으면 자체 SessionManager)
src/cli/       hwped CLI
ui/            ProseMirror 편집기 (Vite)
electron/      셸 (서버 내장, 메뉴, 파일 대화상자)
java/          Hwp2HwpxCli.java + build.sh
vendor/        (gitignore) jdk, jar
fixtures/      hwpx/, hwp/ 공개 샘플, private/ (gitignore, 사용자 실제 문서)
```

## 코어 진입점 (`src/core/index.ts`)
```ts
export * from './types.js';
export function openDocument(path: string): Promise<DocSession>;      // .hwpx 직접, .hwp는 convertHwpToHwpx 후
export function openHwpxBytes(bytes: Uint8Array, meta: { sourcePath: string | null; sourceFormat: 'hwpx'|'hwp'|'new'; path: string | null }): DocSession;
export function newDocument(): DocSession;                            // src/core/template/blank.hwpx 기반, path=null
```
`src/convert/index.ts`: `export function convertHwpToHwpx(hwpPath: string): Promise<Uint8Array>` — java 경로 우선순위 `HWPED_JAVA` env → `<repo>/vendor/jdk/.../bin/java` → `java`; jar는 `HWPED_JAR` env → `<repo>/vendor/hwp2hwpx-cli.jar`. 실패 시 stderr를 담은 Error.

## id 규칙
세션 안에서만 유효. 문서를 열 때 순서대로 `s0..`(구역), `p1..`(문단, 표 셀 안 포함), `t1..`(표), `c1..`(셀), `o1..`(기타 개체)를 매긴다. op로 새로 생긴 것은 이어서 증가. undo/redo 뒤에도 남아 있는 요소의 id는 바뀌지 않는다.

## 서식 채우기 지원
- 글자 겹치기(`hp:compose`, 체크된 □ 등)는 `TextRun.compose`가 있는 별도 run. 오프셋·outline에서는 표시 문자 하나(체크 상자 → `☑`). `RunInput.compose`로 다시 쓰면 compose로 저장, 없으면 표시 문자를 일반 글자로 저장. 문단을 다시 써도 compose 위치(앞뒤 글자 순서)는 유지된다.
- 셀 테두리·배경: `TableCell.border/background/vAlign/paddingMm`(header `hh:borderFill`, `hp:subList vertAlign`, `hp:cellMargin`에서 계산). UI는 CSS 테두리·배경으로 그린다.
- 그림 넣기: `insertPicture` op — 글자처럼 취급(treatAsChar) 그림. 빈 문단이면 그 문단에, 글이 있는 문단이면 바로 뒤에 새 문단(같은 paraPr·style)을 만들어 그림만 넣는다(양쪽 정렬로 앞 줄 글자가 벌어지는 것 방지). 파일은 `BinData/`에 추가하고 `content.hpf` manifest에 `isEmbeded="1"`로 등록. MCP·CLI는 `path`, UI는 base64 `data`. outline은 문단 줄 끝에 `[o5 그림 80×45mm]`처럼 개체를 적는다.
- 표에 행을 더해 쪽을 넘기면 한글은 행을 쪽 경계에서 나눈다(표 `pageBreak="CELL"`). 버그가 아니라 조판 결과 — 서식 칸이 쪽에 꽉 찬 경우 행 추가 대신 칸 안에 글을 넣는 편이 원본 쪽 수를 지킨다.
- 검증: 이 맥에 한글이 없으므로 mbc PC(Windows, 한컴오피스 2020, HwpObject COM)에서 .hwpx를 열어 PDF·PNG로 내보내 확인한다.

## HTTP API (서버, 기본 포트 47321, 127.0.0.1만)
모든 요청 헤더 `Authorization: Bearer <token>`(예외: `<img>`가 쓰는 `GET /api/docs/:id/bin/:binId`와 WS는 `?token=` 쿼리). 시작 시 `~/.hwp-editor/server.json`(0600)에 `{port, pid, token}` 기록, 종료 시 삭제. UI 페이지는 토큰을 `/?token=` 쿼리로 받는다.
| 메서드 경로 | 본문 → 응답 |
|---|---|
| GET `/api/docs` | → `{docs: {docId, path, sourcePath, dirty, revision}[]}` |
| POST `/api/open` | `{path}` → `DocModel` (이미 열린 sourcePath면 그 문서) |
| POST `/api/new` | → `DocModel` |
| GET `/api/docs/:id` | → `DocModel` |
| GET `/api/docs/:id/outline?from=&limit=` | → `{text}` |
| GET `/api/docs/:id/find?q=&regex=&matchCase=` | → `{hits: FindHit[]}` |
| POST `/api/docs/:id/ops` | `{ops: Op[], source: 'ui'|'ai'|'cli', clientId?}` → `OpResult & {model: DocModel}`; OpError → 400 `{error, opIndex}` |
| POST `/api/docs/:id/undo` · `/redo` | `{source}` → `{ok, model}` |
| POST `/api/docs/:id/save` | `{path?}` → `{path}` |
| POST `/api/docs/:id/close` | → `{ok}` |
| GET `/api/docs/:id/bin/:binId` | → 바이너리 |
| WS `/ws?token=` | 서버→클라 `{type:'changed', docId, revision, source, clientId?}`, `{type:'opened'|'closed'|'saved', docId}` |

## MCP 도구 (`hwp_*`)
`hwp_list`, `hwp_open {path}`, `hwp_new`, `hwp_outline {docId, from?, limit?}`, `hwp_find {docId, query, regex?}`, `hwp_apply {docId, ops}`, `hwp_undo {docId}`, `hwp_save {docId, path?}`, `hwp_close {docId}`. `hwp_apply` 설명에 Op 스키마 전체를 적는다. 응답은 짧게(revision, created, replaced, 바뀐 문단 outline).
각 도구 호출마다 서버 정보 파일을 다시 읽고 인증된 상태 확인을 수행한다. 사용 가능한 앱 서버가 있으면 그 서버를 사용하고, 없으면 필요할 때 생성한 자체 SessionManager를 사용한다. 서버 전환 시 각 세션의 문서 ID는 공유되지 않는다.

## UI 동기화
- 문단 = ProseMirror 블록(attrs: id, align, paraPrId, styleId). 텍스트 mark `cs`(attrs: CharStyle 전체). anchors는 문단 뒤 블록(표는 편집 가능한 표, 나머지는 회색 자리표시).
- 편집 후 400ms 디바운스 → 바뀐 문단만 `setParagraph`/`insertParagraph`/`deleteParagraph`/`setAlign`/`setCellText` op로 전송(source `ui`). 서식 버튼은 mark attrs를 바꾸고 동기화 때 `RunInput.style`로 보낸다.
- 다른 출처(`ai`/`cli`) changed 이벤트 → 모델 다시 받아 화면 재구성, 커서 문단 id 기준 복원, 토스트 "AI가 문서를 고쳤습니다".
