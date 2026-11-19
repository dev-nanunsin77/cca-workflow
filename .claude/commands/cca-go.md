---
description: cca-workflow 3-에이전트 루프(PM→테스트선작성→구현→테스트/디버그→리뷰)를 실행한다
---

# /cca-go — cca-workflow 실행 절차

너는 Coder이자 팀 리드다. 아래 순서를 사람에게 묻지 말고 스스로 진행한다.
**codex·agy·테스트는 절대 직접 호출하지 말고, 반드시 `node .cca/cca.mjs` 를 경유한다.**
전체 소요 시간 측정을 위해 **시작 시각을 기록**해 둔다(보고에 총 소요 시간 포함).

요구사항: $ARGUMENTS

## 0. 브랜치 생성
- 기능명을 요구사항에서 짧은 kebab-case 로 정해 `git switch -c cca/<기능명>` 으로 작업 브랜치를 만든다.
- 이미 해당 브랜치면 그대로 사용한다.
- `node .cca/cca.mjs lang` 으로 구현 언어를 확인한다.
  - 언어 추정 경고가 뜨거나 요구사항의 언어와 다르면: 요구사항에 언어가 명시돼 있을 때만 `.cca/config.json` 의 `language` 를 그 값으로 바꾼다(유일하게 허용되는 도구 설정 변경). 명시돼 있지 않으면 멈추고 사람에게 묻는다.

## 1. 기획 (PM = Codex)
- `node .cca/cca.mjs pm "<요구사항>"` 실행 → `docs/plan.md` 생성.
- plan.md 의 6개 제목(목표 / 작업 목록 / 수용 기준 / 테스트 시나리오 / 위험 요소 / **인터페이스 계약**)을 확인한다.

## 2. 테스트 선작성 + 잠금 (TDD)
- `node .cca/cca.mjs tests` 실행 → agy 가 plan 기반 테스트 파일을 생성하고 `.ai/test-lock.json` 에 해시가 잠긴다.
- 출력에서 **red 확인**(구현 전이므로 전부 실패)을 본다. 통과 경고가 뜨면 테스트가 부실한 것이니 plan 을 점검.
- **이후 테스트 파일을 직접 손대지 마라.** 변경은 오직 `dispute` 를 통해서만 가능하다.

## 3. 구현 (Coder = 너)
- `docs/plan.md` 의 작업 목록·수용 기준·인터페이스 계약에 따라 **구현 코드만** 작성한다(테스트 파일 금지).
- 빌드 설정은 구현자 몫이다: python 은 패키지 `__init__.py`, rust 는 `Cargo.toml`/`src/lib.rs`, cpp 는 루트 `CMakeLists.txt`(계약의 라이브러리 타깃 + `enable_testing()` + `add_subdirectory(tests)`).

## 4. 테스트 루프 (실패 시에만 디버그)
- `node .cca/cca.mjs test` 실행. (잠금 해시와 다르면 "테스트 변조"로 실패하니 테스트를 건드리지 않는다.)
- **테스트가 실패하면** `node .cca/cca.mjs debug fail` → `SEVERITY` 를 읽고 **구현을** 고친 뒤 4번으로 복귀.
- 테스트가 틀렸다고 **의심되면** 구현을 억지로 맞추지 말고 `node .cca/cca.mjs dispute "<이의: plan 조항 인용 필수>"`.
  - `VERDICT: accept` → 테스트가 교체·재잠금됨. 다시 4번(test).
  - `VERDICT: reject` → 테스트가 옳다. 구현을 고친다.
  - **같은 테스트에 대해 dispute 가 2회 기각되면 멈추고 사람에게 보고.**
- **같은 문제로 5회(`maxDebugRetries`) 이상 실패하면 멈추고 사람에게 요약 보고.**

## 5. 최종 리뷰 (통과 후 1회)
- 모든 테스트 통과 시 `node .cca/cca.mjs debug review` 를 **마지막에 한 번만** 실행.
- `SEVERITY` 가 `critical`/`major` 면 구현을 고치고 4번으로 복귀. `minor`/`none` → 6번.

## 6. 커밋 (push 금지)
- 소스와 `docs/plan.md`, 잠긴 테스트 파일을 선택적으로 `git add` 한다(런타임 산출물 `.ai/` 는 커밋하지 않는다).
- `git commit` 으로 마무리. **`git push` 는 하지 않는다.**

## 규칙: cca 도구 자체의 문제
- 실행 중 cca 도구(`.cca/`, `.claude/`, `.ai/*-schema.json`)에서 버그·결함을 발견해도 **그 자리에서 수정하지 마라**.
- 작업 범위(요구사항 구현)와 도구 유지보수를 분리하기 위함이다.
- 대신 최종 보고의 **"도구 이슈"** 항목에 무엇을/어디서 발견했는지 기록만 한다.

## 7. 완료 보고에 반드시 포함
- 작업 브랜치명(`cca/<기능명>`).
- **총 소요 시간**(0번 시작부터 커밋까지).
- 디버그 반복 횟수.
- **dispute 횟수와 각 결과(accept/reject)**.
- 디버거 지적별 **반영/미반영 여부와 미반영 이유**.
- 최종 테스트 결과와 마지막 `SEVERITY`.
- **도구 이슈**: 실행 중 발견한 cca 도구(`.cca/`, `.claude/`, `.ai/*-schema.json`)의 문제(없으면 "없음").
- push 하지 않았음을 명시.
