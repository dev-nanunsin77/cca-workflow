# cca-workflow

**C**laude + **C**odex + **A**ntigravity 3-에이전트 개발 워크플로.

| 역할 | 에이전트 | 하는 일 |
|------|----------|---------|
| Coder / 팀 리드 | **Claude** (너) | 루프 구동, 구현, 테스트 작성, 커밋 |
| PM | **Codex** (`codex exec`) | 요구사항 → `docs/plan.md` 기획 |
| Debugger / Reviewer | **Antigravity** (`agy`) | 테스트 실패 원인분석 또는 코드리뷰 |

codex·agy 호출과 테스트 실행은 모두 오케스트레이터 **`.cca/cca.mjs`** 를 경유한다.

## 사전 조건
- Node.js 18+ (내장 `node --test` 사용).
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
  "testCommand": "node --test",
  "planFile": "docs/plan.md",
  "maxDebugRetries": 5
}
```
- `testCommand` 만 바꾸면 pytest 등으로 교체 가능 (기본값은 추가 설치 불필요).

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
