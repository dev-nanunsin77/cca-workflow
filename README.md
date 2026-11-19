# cca-workflow

**C**laude + **C**odex + **A**ntigravity 3-에이전트 개발 워크플로.

| 역할 | 에이전트 | 하는 일 |
|------|----------|---------|
| Coder / 팀 리드 | **Claude** (너) | 루프 구동, 구현, 테스트 작성, 커밋 |
| PM | **Codex** (`codex exec`) | 요구사항 → `docs/plan.md` 기획 |
| Debugger / Reviewer | **Antigravity** (`agy`) | 테스트 실패 원인분석 또는 코드리뷰 |

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
2. `node .cca/cca.mjs pm "<요구사항>"` → `docs/plan.md`
3. plan 기준 구현 + 수용 기준별 테스트 작성
4. `node .cca/cca.mjs test` → `node .cca/cca.mjs debug`
5. `SEVERITY` 가 critical/major 면 수정 후 재시도 (최대 `maxDebugRetries` 회)
6. 통과 시 커밋 (**push 안 함**) 후 보고

## 수동 사용
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
| `prompts/*.md` | codex/agy 에 전달한 실제 프롬프트 (CLI 에는 "이 파일을 읽고 그대로 따르라" 만 전달) |
| `test.log` | 마지막 테스트 출력 |
| `last-test.json` | 마지막 테스트 통과 여부 (debug 모드 자동판단용) |
| `changes.diff` | `git diff` |
| `changes.status` | `git status --porcelain` (신규 `??` 파일 포함) |
| `debug.json` | agy 결과 원본 JSON |
| `debug-schema.json` | agy 출력 JSON 스키마 (추적 대상) |

## 안전장치
- `.claude/settings.json`: `git push` 와 `rm -rf` 는 **deny**. 외부 CLI 12분 / 셸 15분 타임아웃.
- 디버거(`agy`)는 `--mode plan` 으로만 실행되어 **파일을 수정하지 않는다** (검증 항목 참고).
