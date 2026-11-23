# cca-workflow

**C**laude + **C**odex + **A**ntigravity 3-에이전트 개발 워크플로.

| 역할 | 기본 backend (→ fallback) | 하는 일 |
|------|---------------------------|---------|
| Coder / 팀 리드 | **Claude** (너) | 루프 구동, 구현, 커밋 |
| pm | **Codex** → agy | 요구사항 → `docs/plan.md` 기획 |
| tester | **Antigravity** → codex | plan 기반 테스트 선작성 |
| debugger / reviewer | **Antigravity** → codex | 테스트 실패 원인분석 / 코드리뷰 |
| judge | **Antigravity** → codex | 테스트 이의(dispute) 판정 |

역할별 backend 순서는 [`.cca/roles.json`](.cca/roles.json) 에서 바꾼다([역할과 backend](#역할과-backend)).
codex·agy 호출과 테스트 실행은 모두 오케스트레이터 **`.cca/cca.mjs`** 를 경유한다.

## 사전 조건
- Node.js 18+ (오케스트레이터 `.cca/cca.mjs` 실행용).
- 구현 언어의 툴체인 (아래 [지원 언어](#지원-언어) 참고).
- `codex` CLI 설치 + 로그인, PATH 등록.
- `agy` (Antigravity) CLI 설치 + 로그인, PATH 등록.

## 빠른 시작
Claude Code 에서:

```
/cca-go <요구사항>
```

그러면 Claude 가 다음을 자동 수행한다:
1. `cca/<기능명>` 브랜치 생성
2. `node .cca/cca.mjs run feature-tdd "<요구사항>"` → cca 가 plan(codex), 테스트 선작성·잠금(agy)을 진행하고 Claude 차례에서 멈춤
3. Claude 가 구현 → `node .cca/cca.mjs next` → cca 가 테스트 → (실패 시 원인분석) → 리뷰를 진행
4. 다시 구현이 필요하면 2~3 반복 (디버그·리뷰 한도 `maxDebugRetries`)
5. `ACTION: commit` 이 나오면 커밋 (**push 안 함**) 후 보고

## 워크플로
흐름은 `.cca/workflows/<name>.json` 에 정의하고, 전이는 `.cca/engine.mjs` 가 결정한다.
진행 상태는 `.ai/run.json` 에 step 마다 저장된다.

```bash
node .cca/cca.mjs run feature-tdd "CSV 파서" --reason "새 기능"   # 시작
node .cca/cca.mjs next      # Claude 작업 완료 → 다음 step (실패한 step 재시도도 이것)
node .cca/cca.mjs status    # 기록·다음 행동
node .cca/cca.mjs abort     # 중단
```

cca 출력 끝의 블록이 다음 행동을 지시한다:
```
===== cca run =====
RUN: 20261123-063000-feature-tdd (workflow: feature-tdd)
STATUS: waiting_coder
RESULT: retest → fail — pass 7 / fail 2 [.ai/test.log]
RESULT: analyze(analyze_failure@agy) → major — 따옴표 이스케이프 미처리 [.ai/debug.json]
STEP: fix
ACTION: implement
INSTRUCTION: 디버거 분석(.ai/debug.json)을 검토해 구현을 고친다. ...
===================
```
`ACTION` 은 `implement`(Claude 차례) / `commit`(완료) / `report`(한도 도달, 사람에게 보고) / `retry`(외부 CLI 실패) 중 하나다.

| step kind | 실행 | 결과(전이 키) |
|-----------|------|---------------|
| `agent` | task(`plan`, `write_tests`, `analyze_failure`, `review`) | `ok`, 또는 severity(`critical`/`major`/`minor`/`none`) |
| `test` | 잠금 검증 + 테스트 | `pass` / `fail` / `tampered` |
| `coder` | Claude (cca 는 멈춤) | `next` 호출 시 `ok` |

`on` 으로 결과별 다음 step 을 지정하고(`default`, 종료는 `done`), `maxVisits` 로 반복 한도를 둔다(숫자 또는 config 키).
도구 단위 테스트(엔진·파싱·라우팅): `node --test .cca/test/*.test.mjs`

## 역할과 backend
`.cca/roles.json` 이 task → 역할 → backend 순서를 정한다. 확인: `node .cca/cca.mjs roles`
```json
{
  "roles": { "tester": { "backends": ["agy", "codex"] }, "...": {} },
  "tasks": { "write_tests": "tester", "...": "..." }
}
```
- 앞의 backend 가 **실패하면 다음 backend 로 넘긴다**: 실행 파일 없음, 타임아웃, 비정상 종료(사용량 한도 포함), 빈 결과·형식 불일치.
  fallback 이 일어나면 run 기록의 backend 가 `agy→codex` 처럼 남고, 앞 backend 의 실패 사유가 요약에 붙는다.
- 사용량 한도는 CLI 출력의 일반적인 문구(`usage limit`, `rate limit`, `429`, `quota` 등)로 추정한다. **codex·agy 의 실제 한도 응답 형태는 아직 실측하지 못했다.**
- 모든 backend 는 읽기 전용으로 실행한다(codex `-s read-only`, agy `--mode plan`). 파일 쓰기(plan, 테스트)는 cca 가 결과를 받아 수행한다.
- 프롬프트 전달: codex 는 stdin(`exec -`), agy 는 인자로 직접(24,000자 초과 시에만 파일 지시). JSON task 는 codex `--output-schema` / agy `--json-schema` 로 강제하며,
  codex 용 스키마는 OpenAI 구조화 출력 규칙(모든 속성 required, `additionalProperties: false`, 선택 속성은 `null` 허용)으로 변환해 `.ai/out/` 에 만든다.
- effort 는 backend 가 받는 값으로 맞춘다(예: `max` → codex `xhigh`).

## 수동 사용 (단일 명령)
```bash
node .cca/cca.mjs pm "로그인 폼에 검증 추가"   # docs/plan.md 생성
node .cca/cca.mjs test                         # 테스트 → .ai/test.log
node .cca/cca.mjs debug                         # 자동 모드 (실패→분석 / 통과→리뷰)
node .cca/cca.mjs debug fail                     # 강제: 실패 원인분석
node .cca/cca.mjs debug review                   # 강제: 코드 리뷰
```

## 설정 (`.cca/config.json`)
```json
{
  "language": "auto",
  "planFile": "docs/plan.md",
  "maxDebugRetries": 5
}
```
- `language`: `auto` | `node` | `python` | `rust` | `cpp`. PM 의 인터페이스 계약, 테스트 작성 규칙, 테스트 명령, 결과 집계가 모두 이 값을 따른다.
- `framework`: 언어별 대안 러너. 현재 `python` 의 `"pytest"` 만 있음 (기본은 `unittest`).
- `testCommand`: 지정하면 프리셋의 테스트 명령을 덮어쓴다.
- 적용 결과 확인: `node .cca/cca.mjs lang`

## 지원 언어
| language | 테스트 러너 (추가 설치 없음) | 테스트 위치 | 구현자가 만드는 빌드 설정 |
|----------|------------------------------|-------------|---------------------------|
| `node` | `node --test` | `*.test.mjs` | — |
| `python` | `python -m unittest discover -s tests -t .` | `tests/test_*.py` | 패키지 디렉터리 + `__init__.py` |
| `python` + `framework: "pytest"` | `python -m pytest -q` | `tests/test_*.py` | 〃 |
| `rust` | `cargo test` | `tests/*.rs` (통합 테스트) | `Cargo.toml`, `src/lib.rs` |
| `cpp` | CMake + CTest (자체 미니 하네스, C++17) | `tests/test_*.cpp`, `tests/CMakeLists.txt` | 루트 `CMakeLists.txt` (라이브러리 타깃 + `enable_testing()` + `add_subdirectory(tests)`) |

- `auto` 는 `Cargo.toml` → rust, `CMakeLists.txt` → cpp, `pyproject.toml`/`setup.py`/`requirements.txt` → python, `package.json` → node 순으로 추정한다. 빈 저장소에서는 추정할 수 없어 node 로 떨어지므로 **새 프로젝트는 `language` 를 명시**하자.
- `cpp` 는 PATH 에 `cmake` 가 없으면 Visual Studio 번들 CMake(vswhere)를 자동으로 찾는다. 빌드는 `build/` 에 Debug 구성으로 한다.

## 산출물 (`.ai/`)
| 파일 | 내용 |
|------|------|
| `prompts/*.md` | backend 에 전달한 실제 프롬프트 (기록용) |
| `out/` | codex 의 마지막 메시지(`-o`)와 변환된 엄격 스키마 |
| `test.log` | 마지막 테스트 출력 |
| `run.json` | 현재 run 상태 (workflow, 현재 step, 방문 횟수, dispute, step 별 기록) |
| `last-test.json` | 마지막 테스트 통과 여부 (debug 모드 자동판단용) |
| `changes.diff` | `git diff` |
| `changes.status` | `git status --porcelain` (신규 `??` 파일 포함) |
| `debug.json` | 디버거·리뷰어 결과 JSON |
| `*-schema.json` | task 출력 JSON 스키마 (추적 대상) |

## 안전장치
- `.claude/settings.json`: `git push` 와 `rm -rf` 는 **deny**. 외부 CLI 12분 / 셸 15분 타임아웃.
- 외부 backend 는 읽기 전용으로만 실행되어 **파일을 수정하지 않는다** (agy `--mode plan`, codex `-s read-only`).
