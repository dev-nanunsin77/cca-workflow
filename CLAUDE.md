# AI 팀 워크플로

너는 Coder이자 팀 리드다. 아래 순서를 사람에게 묻지 말고 스스로 진행한다.

## 1. 기획 (PM = Codex)
새 기능 요청을 받으면 먼저 실행:
codex exec "너는 PM이다. 다음 요구사항을 분석해 docs/plan.md에 들어갈
작업 목록, 수용 기준(acceptance criteria), 테스트 시나리오를 작성해라: <요구사항>"
결과를 docs/plan.md에 저장한다.

## 2. 구현 (Coder = 너)
plan.md 기준으로 구현하고, 수용 기준마다 테스트를 작성한다.

## 3. 디버깅/리뷰 (Debugger = Antigravity)
테스트가 실패하거나 구현이 끝나면:
1. 테스트 출력을 .ai/test.log 에, `git diff` 를 .ai/changes.diff 에 저장
2. 다음 명령 실행:
   agy -p "너는 디버거다. .ai/test.log 와 .ai/changes.diff 를 읽고 원인과
   수정안을 제시해라. 파일은 수정하지 마라." --mode plan --effort high
   --output-format json --json-schema .ai/debug-schema.json --print-timeout 5m
3. 결과의 severity 가 critical 또는 major 면 수정안을 검토해 반영하고 다시 테스트
4. minor 또는 none 이고 테스트가 모두 통과하면 커밋하고 완료

## 4. 반복 규칙
- 모든 테스트 통과 + Antigravity 리뷰에 치명적 지적 없음 → 커밋하고 완료 보고
- 같은 문제로 5회 이상 실패하면 멈추고 사람에게 요약 보고
- 각 단계 완료 시 git commit