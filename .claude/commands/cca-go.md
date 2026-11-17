---
description: cca-workflow 3-에이전트 루프(PM→구현→테스트→디버그)를 실행한다
---

# /cca-go — cca-workflow 실행 절차

너는 Coder이자 팀 리드다. 아래 순서를 사람에게 묻지 말고 스스로 진행한다.
**codex·agy·테스트는 절대 직접 호출하지 말고, 반드시 `node .cca/cca.mjs` 를 경유한다.**

요구사항: $ARGUMENTS

## 0. 브랜치 생성
- 기능명을 요구사항에서 짧은 kebab-case 로 정해 `git switch -c cca/<기능명>` 으로 작업 브랜치를 만든다.
- 이미 해당 브랜치면 그대로 사용한다.

## 1. 기획 (PM = Codex)
- `node .cca/cca.mjs pm "<요구사항>"` 실행 → `docs/plan.md` 생성.
- plan.md 의 5개 제목(목표 / 작업 목록 / 수용 기준 / 테스트 시나리오 / 위험 요소)을 확인한다.

## 2. 구현 (Coder = 너)
- `docs/plan.md` 의 작업 목록·수용 기준에 따라 직접 구현한다.
- **수용 기준마다 테스트를 작성**한다(기본 러너 `node --test`).

## 3. 테스트 루프 (실패 시에만 디버그)
- `node .cca/cca.mjs test` 실행 (결과는 `.ai/test.log`, `.ai/last-test.json`).
- **테스트가 실패하면** `node .cca/cca.mjs debug fail` 실행 → 원인분석.
  - 출력 마지막 줄 `SEVERITY: <값>` 을 읽고, 수정안을 검토해 반영한 뒤 **다시 3번(test)으로 복귀**.
  - 속도를 위해 통과한 상태에서는 매번 리뷰를 돌리지 않는다(리뷰는 4번에서 한 번만).
- **같은 문제로 5회(`.cca/config.json` 의 `maxDebugRetries`) 이상 실패하면 멈추고 사람에게 요약 보고.**

## 4. 최종 리뷰 (통과 후 1회)
- 모든 테스트가 통과하면 `node .cca/cca.mjs debug review` 를 **마지막에 한 번만** 실행.
- `SEVERITY` 가 `critical` 또는 `major` 면: 수정안을 반영하고 **3번(test)으로 복귀**(수정 후 다시 통과→리뷰).
- `minor` 또는 `none` → 5번으로.

## 5. 커밋 (push 금지)
- 소스와 `docs/plan.md` 만 선택적으로 `git add` 한다(런타임 산출물 `.ai/test.log`, `.ai/changes.*`, `.ai/prompts/` 는 커밋하지 않는다).
- `git commit` 으로 마무리. **`git push` 는 하지 않는다.**

## 6. 완료 보고에 반드시 포함
- 작업 브랜치명(`cca/<기능명>`).
- 디버그 반복 횟수.
- 디버거 지적별 **반영/미반영 여부와 미반영 이유**.
- 최종 테스트 결과와 마지막 `SEVERITY`.
- push 하지 않았음을 명시.
