// 역할 → 백엔드 라우팅 단위 테스트 (가짜 backend)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  backendLabel,
  backendsFor,
  isLimitHit,
  mapEffort,
  strictSchema,
  validateRoles,
  withFallback,
} from '../backends.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROLES = JSON.parse(readFileSync(resolve(here, '../roles.json'), 'utf8'));
const TASKS = ['plan', 'write_tests', 'analyze_failure', 'review', 'judge_dispute'];

test('roles.json 이 유효하고 모든 task 에 role 이 있다', () => {
  assert.deepEqual(validateRoles(ROLES, { tasks: TASKS }), []);
  assert.deepEqual(backendsFor(ROLES, 'plan'), { role: 'pm', backends: ['codex', 'agy'] });
  assert.deepEqual(backendsFor(ROLES, 'write_tests').backends, ['agy', 'codex']);
});

test('validateRoles: 알 수 없는 backend, 빈 목록, 매핑 누락을 잡는다', () => {
  const errors = validateRoles(
    { roles: { pm: { backends: ['gpt'] }, tester: { backends: [] } }, tasks: { plan: 'pm', review: 'nobody' } },
    { tasks: ['plan', 'review', 'write_tests'] }
  );
  assert.ok(errors.some((e) => e.includes("알 수 없는 backend 'gpt'")));
  assert.ok(errors.some((e) => e.includes("role 'tester': backends 가 비어")));
  assert.ok(errors.some((e) => e.includes("없는 role 'nobody'")));
  assert.ok(errors.some((e) => e.includes("task 'write_tests' 에 role 이")));
});

test('withFallback: 첫 backend 가 성공하면 다음은 부르지 않는다', () => {
  const calls = [];
  const res = withFallback(['agy', 'codex'], (b) => (calls.push(b), { ok: true, data: { b }, elapsedMs: 10 }));
  assert.deepEqual(calls, ['agy']);
  assert.equal(res.backend, 'agy');
  assert.deepEqual(res.attempts, []);
  assert.equal(backendLabel(res), 'agy');
});

test('withFallback: 실패하면 다음 backend 로 넘기고 실패 사유를 남긴다', () => {
  const seen = [];
  const res = withFallback(
    ['agy', 'codex'],
    (b) => (b === 'agy' ? { ok: false, reason: '결과 없음 — 빈 응답', elapsedMs: 15 } : { ok: true, text: 'plan', elapsedMs: 40 }),
    { onFallback: (from, to) => seen.push(`${from}->${to}`) }
  );
  assert.equal(res.ok, true);
  assert.equal(res.backend, 'codex');
  assert.equal(res.text, 'plan');
  assert.equal(res.elapsedMs, 55);
  assert.deepEqual(res.attempts, [{ backend: 'agy', reason: '결과 없음 — 빈 응답', limitHit: false }]);
  assert.deepEqual(seen, ['agy->codex']);
  assert.equal(backendLabel(res), 'agy→codex');
});

test('withFallback: 모두 실패하면 ok=false 와 전체 시도 기록', () => {
  const res = withFallback(['codex', 'agy'], (b) => ({ ok: false, reason: `${b} down`, limitHit: b === 'codex' }));
  assert.equal(res.ok, false);
  assert.deepEqual(
    res.attempts.map((a) => [a.backend, a.limitHit]),
    [['codex', true], ['agy', false]]
  );
  assert.equal(backendLabel(res), 'codex→agy');
});

test('isLimitHit: 실패한 실행의 한도 문구만 인정한다', () => {
  assert.equal(isLimitHit({ status: 1, stderr: "You've hit your usage limit. Try again later." }), true);
  assert.equal(isLimitHit({ status: 1, stderr: 'Error 429: Too Many Requests' }), true);
  assert.equal(isLimitHit({ status: 1, stdout: '{"error":"RESOURCE_EXHAUSTED"}' }), true);
  assert.equal(isLimitHit({ status: 1, stderr: 'not logged in' }), false);
  // 성공한 실행은 내용에 'rate limit' 이 있어도(예: 생성된 코드) 한도로 보지 않는다
  assert.equal(isLimitHit({ status: 0, stdout: 'implement rate limit middleware' }), false);
});

test('mapEffort: backend 가 받지 않는 값은 가까운 값으로', () => {
  assert.equal(mapEffort('codex', 'high'), 'high');
  assert.equal(mapEffort('codex', 'max'), 'xhigh');
  assert.equal(mapEffort('agy', 'minimal'), 'low');
  assert.equal(mapEffort('agy', 'max'), 'max');
  assert.equal(mapEffort('agy', 'weird'), 'medium');
});

test('strictSchema: 모든 속성 required + additionalProperties:false, 선택 속성은 null 허용', () => {
  const debug = JSON.parse(readFileSync(resolve(here, '../../.ai/debug-schema.json'), 'utf8'));
  const s = strictSchema(debug);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual([...s.required].sort(), Object.keys(debug.properties).sort());
  assert.deepEqual(s.properties.files_to_change.type, ['array', 'null']); // 원래 선택
  assert.equal(s.properties.severity.type, 'string'); // 원래 필수 → 그대로
  assert.deepEqual(s.properties.severity.enum, ['critical', 'major', 'minor', 'none']);
});

test('strictSchema: 중첩 object(배열 items)까지 엄격하게', () => {
  const tests = JSON.parse(readFileSync(resolve(here, '../../.ai/tests-schema.json'), 'utf8'));
  const s = strictSchema(tests);
  const item = s.properties.files.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual([...item.required].sort(), ['content', 'path']);
  // 원본은 바꾸지 않는다
  assert.equal(tests.additionalProperties, undefined);
});

test('strictSchema: 선택 enum 속성은 null 을 enum 에도 추가', () => {
  const s = strictSchema({ type: 'object', properties: { kind: { type: 'string', enum: ['a', 'b'] } } });
  assert.deepEqual(s.properties.kind.enum, ['a', 'b', null]);
  assert.deepEqual(s.properties.kind.type, ['string', 'null']);
});

test('withFallback: adapter 가 예외를 던져도 다음 backend 로 넘긴다', () => {
  const res = withFallback(['codex', 'agy'], (b) => {
    if (b === 'codex') throw new Error('Unexpected token in schema');
    return { ok: true, data: { severity: 'none' } };
  });
  assert.equal(res.ok, true);
  assert.equal(res.backend, 'agy');
  assert.match(res.attempts[0].reason, /예외: Unexpected token/);
});

test('validateRoles: roles·tasks 타입과 프로토타입 키를 막는다', () => {
  assert.deepEqual(validateRoles({ roles: [], tasks: {} }), ['roles 가 객체가 아닙니다.']);
  assert.deepEqual(validateRoles({ roles: {}, tasks: null }), ['tasks 가 객체가 아닙니다.']);
  const errors = validateRoles({ roles: {}, tasks: { plan: 'toString' } }, { tasks: ['plan'] });
  assert.ok(errors.some((e) => e.includes("없는 role 'toString'")));
});

test('isLimitHit: stdout/stderr 가 null 이어도 안전', () => {
  assert.equal(isLimitHit({ status: 1, stdout: null, stderr: null }), false);
});

// ---------- 사용량 한도 조회 해석 (실제 관찰된 응답을 줄인 것) ----------
import { normalizeAgyUsage, normalizeCodexUsage, usageBlocked } from '../backends.mjs';

const AGY_USAGE = {
  conversation_id: '',
  status: 'SUCCESS',
  num_turns: 0,
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.986, reset_time: '2026-11-30T06:02:15Z' },
            { id: 'gemini-5h', window: '5h', remaining_fraction: 0.04, reset_time: '2026-11-23T11:02:15Z' },
          ],
        },
        { name: 'Claude and GPT models', buckets: [{ id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: 'x' }] },
      ],
    },
  },
};
const CODEX_RESULT = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1795431695 },
    secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1795998945 },
    rateLimitReachedType: null,
    spendControlReached: false,
  },
};

test('normalizeAgyUsage: Gemini 그룹을 기준으로 창별 잔량을 읽는다', () => {
  const u = normalizeAgyUsage(AGY_USAGE);
  assert.equal(u.scope, 'Gemini Models');
  assert.deepEqual(u.windows.map((w) => [w.window, w.remaining]), [['weekly', 0.986], ['5h', 0.04]]);
});

test('normalizeAgyUsage: 슬래시 명령이 아닌 응답(모델 턴)이면 null', () => {
  assert.equal(normalizeAgyUsage({ status: 'SUCCESS', num_turns: 1, response: 'It looks like…' }), null);
});

test('normalizeCodexUsage: usedPercent → 남은 비율, 창 이름, 초기화 시각', () => {
  const u = normalizeCodexUsage(CODEX_RESULT);
  assert.deepEqual(u.windows.map((w) => [w.window, w.remaining]), [['5h', 0.98], ['weekly', 0.99]]);
  assert.equal(u.windows[0].resetAt, new Date(1795431695 * 1000).toISOString());
  assert.equal(u.reached, null);
});

test('normalizeCodexUsage: rateLimitReachedType·ordinaryUsageAllowed=false 를 도달로 본다', () => {
  const reached = structuredClone(CODEX_RESULT);
  reached.rateLimits.rateLimitReachedType = 'rate_limit_reached';
  assert.equal(normalizeCodexUsage(reached).reached, 'rate_limit_reached');
  const denied = { ...structuredClone(CODEX_RESULT), ordinaryUsageAllowed: false };
  assert.equal(normalizeCodexUsage(denied).reached, 'ordinary_usage_not_allowed');
  assert.equal(normalizeCodexUsage({}), null);
});

test('usageBlocked: 남은 비율 5% 이하 창이 있거나 도달이면 사유, 아니면 null', () => {
  assert.match(usageBlocked(normalizeAgyUsage(AGY_USAGE), 0.05), /5h 남은 4%/);
  assert.equal(usageBlocked(normalizeCodexUsage(CODEX_RESULT), 0.05), null);
  assert.equal(usageBlocked({ windows: [{ window: '5h', remaining: 0.05 }], reached: null }, 0.05), '5h 남은 5%');
  assert.match(usageBlocked({ windows: [], reached: 'rate_limit_reached' }), /한도 도달/);
  assert.equal(usageBlocked(null), null); // 조회 실패 → 확인 건너뜀
});

test('needsUsageRecheck: 프로세스 비정상 종료만 재확인 대상', async () => {
  const { needsUsageRecheck } = await import('../backends.mjs');
  assert.equal(needsUsageRecheck({ ok: false, reason: 'exit 1' }), true);
  assert.equal(needsUsageRecheck({ ok: false, reason: '사용량 한도 exit 1', limitHit: true }), false);
  assert.equal(needsUsageRecheck({ ok: false, reason: '결과 없음 — 빈 응답' }), false);
  assert.equal(needsUsageRecheck({ ok: false, reason: '타임아웃' }), false);
  assert.equal(needsUsageRecheck({ ok: true }), false);
});

test('normalizeCodexUsage: 창 길이가 없거나 낯선 값이면 이름을 그대로/분 단위로', () => {
  const u = normalizeCodexUsage({ rateLimits: { primary: { usedPercent: 10 }, secondary: { usedPercent: 0, windowDurationMins: 60 } } });
  assert.deepEqual(u.windows.map((w) => w.window), ['primary', '60m']);
});
