---
description: cca-workflow 워크플로(기본 feature-tdd: PM→테스트선작성→구현→테스트/디버그→리뷰)를 실행한다
---

# /cca-go — cca-workflow 실행 절차

너는 Coder이자 팀 리드다. 아래 순서를 사람에게 묻지 말고 스스로 진행한다.
**codex·agy·테스트는 절대 직접 호출하지 말고, 반드시 `node .cca/cca.mjs` 를 경유한다.**
다음에 무엇을 할지는 cca 가 출력하는 `ACTION:` 줄이 정한다. 순서를 스스로 바꾸지 마라.

요구사항: $ARGUMENTS

## 0. 준비
- 기능명을 요구사항에서 짧은 kebab-case 로 정해 `git switch -c cca/<기능명>` 으로 작업 브랜치를 만든다. 이미 해당 브랜치면 그대로 사용한다.
- `node .cca/cca.mjs lang` 으로 구현 언어를 확인한다.
  - 언어 추정 경고가 뜨거나 요구사항의 언어와 다르면: 요구사항에 언어가 명시돼 있을 때만 `.cca/config.json` 의 `language` 를 그 값으로 바꾼다(유일하게 허용되는 도구 설정 변경). 명시돼 있지 않으면 멈추고 사람에게 묻는다.
- `node .cca/cca.mjs status` 로 진행 중인 run 이 있는지 본다. 같은 요구사항이면 `next` 로 이어서 하고, 다른 요구사항이면 멈추고 사람에게 묻는다.

## 1. 시작
```
node .cca/cca.mjs run feature-tdd "<요구사항>" --reason "<이 workflow 를 고른 근거>"
```
- 지금 제공되는 workflow 는 `feature-tdd` 뿐이다.
- cca 가 plan(codex) → 테스트 선작성·잠금·red 확인(agy) 을 자동 진행하고, 네 차례에서 멈춘다.

## 2. 루프: 출력 블록의 `ACTION:` 에 따라 행동
| ACTION | 할 일 |
|--------|-------|
| `implement` | `INSTRUCTION:` 과 `RESULT:` 줄(디버거·리뷰 결과는 `.ai/debug.json`)을 읽고 **구현 코드만** 작성·수정한다. 끝나면 `node .cca/cca.mjs next`. |
| `commit` | 3번으로. |
| `report` | 멈추고 사람에게 요약 보고(`REASON:` 포함). |
| `retry` | `REASON:` 의 외부 원인(CLI 미설치·로그인·타임아웃)을 확인한다. 네가 해결할 수 있으면 `next` 로 재시도, 아니면 사람에게 보고. |

규칙:
- **테스트 파일을 직접 손대지 마라.** 잠금 해시와 다르면 test step 이 `tampered` 로 실패하고 같은 구현 단계로 돌아온다.
- 빌드 설정은 구현자 몫이다: python 은 패키지 `__init__.py`, rust 는 `Cargo.toml`/`src/lib.rs`, cpp 는 루트 `CMakeLists.txt`(계약의 라이브러리 타깃 + `enable_testing()` + `add_subdirectory(tests)`).
- 테스트가 틀렸다고 **의심되면** 구현을 억지로 맞추지 말고, `implement` 차례에서 `node .cca/cca.mjs dispute "<이의: plan 조항 인용 필수>"`.
  - `VERDICT: accept` → 테스트가 교체·재잠금됨. 구현을 마치고 `next`.
  - `VERDICT: reject` → 테스트가 옳다. 구현을 고친다.
  - 기각이 run 당 `maxDisputeRejects`(기본 2)회에 닿으면 cca 가 `ACTION: report` 를 낸다.
- 디버그·리뷰 반복 한도(`maxDebugRetries`)도 cca 가 세고, 넘으면 `ACTION: report` 를 낸다.

## 3. 커밋 (push 금지)
- 소스와 `docs/plan.md`, 잠긴 테스트 파일을 선택적으로 `git add` 한다(런타임 산출물 `.ai/` 는 커밋하지 않는다).
- `git commit` 으로 마무리. **`git push` 는 하지 않는다.**

## 규칙: cca 도구 자체의 문제
- 실행 중 cca 도구(`.cca/`, `.claude/`, `.ai/*-schema.json`)에서 버그·결함을 발견해도 **그 자리에서 수정하지 마라**.
- 작업 범위(요구사항 구현)와 도구 유지보수를 분리하기 위함이다.
- 대신 최종 보고의 **"도구 이슈"** 항목에 무엇을/어디서 발견했는지 기록만 한다.

## 4. 완료 보고에 반드시 포함
`node .cca/cca.mjs status` 의 기록을 근거로 작성한다.
- 작업 브랜치명(`cca/<기능명>`)과 workflow·선택 근거.
- **총 소요 시간**(`ELAPSED:`).
- 디버그 반복 횟수(analyze 실행 수).
- **dispute 횟수와 각 결과(accept/reject)**.
- 디버거·리뷰 지적별 **반영/미반영 여부와 미반영 이유**.
- 최종 테스트 결과와 마지막 리뷰 severity.
- **도구 이슈**: 실행 중 발견한 cca 도구(`.cca/`, `.claude/`, `.ai/*-schema.json`)의 문제(없으면 "없음").
- push 하지 않았음을 명시.
