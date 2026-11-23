// 워크플로 엔진 단위 테스트 (외부 CLI 없음, 가짜 실행기 사용)
// 실행: node --test .cca/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DONE,
  completeCoder,
  createRun,
  drive,
  maxVisitsOf,
  recordDispute,
  resolveNext,
  validateWorkflow,
} from '../engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FEATURE_TDD = JSON.parse(readFileSync(resolve(here, '../workflows/feature-tdd.json'), 'utf8'));
const TASKS = ['plan', 'write_tests', 'analyze_failure', 'review'];
const CONFIG = { maxDebugRetries: 5 };

// 결과 시퀀스를 차례로 돌려주는 가짜 실행기. calls 에 실행 순서를 기록한다.
function fakeExecutors(script) {
  const calls = [];
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const pick = (key) => {
    calls.push(key);
    const q = queues[key];
    if (!q || q.length === 0) throw new Error(`스크립트에 없는 호출: ${key}`);
    return { result: q.shift() };
  };
  return {
    calls,
    executors: {
      agent: (step) => pick(step.task),
      test: (step) => pick(step.id),
    },
  };
}

function start(wf = FEATURE_TDD) {
  return createRun({ workflow: wf, requirement: 'CSV 파서', now: new Date('2026-11-23T06:30:00Z') });
}

// coder step 을 만날 때마다 completeCoder 하며 끝까지 진행. 지나간 coder step 을 돌려준다.
function runToEnd(rs, wf, executors, maxCoder = 50) {
  const coderSteps = [];
  drive(rs, wf, { executors, config: CONFIG });
  while (rs.status === 'waiting_coder' && coderSteps.length < maxCoder) {
    coderSteps.push(rs.current);
    completeCoder(rs, wf);
    drive(rs, wf, { executors, config: CONFIG });
  }
  return coderSteps;
}

test('feature-tdd 정의가 유효하다', () => {
  assert.deepEqual(validateWorkflow(FEATURE_TDD, { tasks: TASKS }), []);
});

test('validateWorkflow: 없는 전이 대상·중복 id·예약어·알 수 없는 task 를 잡는다', () => {
  const errors = validateWorkflow(
    {
      steps: [
        { id: 'a', kind: 'agent', task: 'nope', on: { ok: 'zzz' } },
        { id: 'a', kind: 'test' },
        { id: 'done', kind: 'coder' },
        { id: 'b', kind: 'weird' },
      ],
    },
    { tasks: TASKS }
  );
  assert.ok(errors.some((e) => e.includes("알 수 없는 task 'nope'")));
  assert.ok(errors.some((e) => e.includes("없는 step 'zzz'")));
  assert.ok(errors.some((e) => e.includes('중복 step id: a')));
  assert.ok(errors.some((e) => e.includes('예약어')));
  assert.ok(errors.some((e) => e.includes("알 수 없는 kind 'weird'")));
  assert.ok(errors.some((e) => e.includes('name 이 없습니다')));
  const bad = validateWorkflow({ name: 'x', steps: [{ id: 'a', kind: 'test', maxVisits: 0 }] });
  assert.ok(bad.some((e) => e.includes('maxVisits 는 양수')));
});

test('resolveNext: on[결과] → on.default → 다음 step → done', () => {
  assert.equal(resolveNext(FEATURE_TDD, 'plan', 'ok'), 'tests');
  assert.equal(resolveNext(FEATURE_TDD, 'test', 'fail'), 'analyze');
  assert.equal(resolveNext(FEATURE_TDD, 'review', 'major'), 'rework');
  assert.equal(resolveNext(FEATURE_TDD, 'review', 'minor'), DONE);
  assert.equal(resolveNext(FEATURE_TDD, 'analyze', 'whatever'), 'fix');
  const linear = { steps: [{ id: 'x', kind: 'test' }] };
  assert.equal(resolveNext(linear, 'x', 'pass'), DONE);
});

test('maxVisitsOf: 숫자, config 키, 없음', () => {
  assert.equal(maxVisitsOf({ maxVisits: 3 }), 3);
  assert.equal(maxVisitsOf({ maxVisits: 'maxDebugRetries' }, { maxDebugRetries: 5 }), 5);
  assert.equal(maxVisitsOf({}), Infinity);
});

test('한 번에 통과하는 경로: plan → tests → impl → test(pass) → review(none) → done', () => {
  const { calls, executors } = fakeExecutors({
    plan: ['ok'],
    write_tests: ['ok'],
    test: ['pass'],
    review: ['none'],
  });
  const rs = start();
  drive(rs, FEATURE_TDD, { executors, config: CONFIG });
  assert.equal(rs.status, 'waiting_coder');
  assert.equal(rs.current, 'impl');
  assert.deepEqual(calls, ['plan', 'write_tests']);

  const coder = runToEnd(rs, FEATURE_TDD, executors);
  assert.deepEqual(coder, ['impl']);
  assert.equal(rs.status, 'done');
  assert.deepEqual(calls, ['plan', 'write_tests', 'test', 'review']);
  assert.ok(rs.endedAt);
});

test('실패 루프: test(fail) → analyze → fix → retest(pass) → review', () => {
  const { calls, executors } = fakeExecutors({
    plan: ['ok'],
    write_tests: ['ok'],
    test: ['fail'],
    analyze_failure: ['major', 'minor'],
    retest: ['fail', 'pass'],
    review: ['none'],
  });
  const rs = start();
  const coder = runToEnd(rs, FEATURE_TDD, executors);
  assert.deepEqual(coder, ['impl', 'fix', 'fix']);
  assert.equal(rs.status, 'done');
  assert.deepEqual(calls, ['plan', 'write_tests', 'test', 'analyze_failure', 'retest', 'analyze_failure', 'retest', 'review']);
  assert.equal(rs.visits.analyze, 2);
});

test('리뷰가 major 면 rework → recheck → 다시 review', () => {
  const { calls, executors } = fakeExecutors({
    plan: ['ok'],
    write_tests: ['ok'],
    test: ['pass'],
    review: ['major', 'minor'],
    recheck: ['pass'],
  });
  const rs = start();
  const coder = runToEnd(rs, FEATURE_TDD, executors);
  assert.deepEqual(coder, ['impl', 'rework']);
  assert.equal(rs.status, 'done');
  assert.deepEqual(calls, ['plan', 'write_tests', 'test', 'review', 'recheck', 'review']);
});

test('analyze 가 maxDebugRetries(5) 를 넘으면 escalated', () => {
  const { calls, executors } = fakeExecutors({
    plan: ['ok'],
    write_tests: ['ok'],
    test: ['fail'],
    analyze_failure: Array(5).fill('major'),
    retest: Array(5).fill('fail'),
  });
  const rs = start();
  runToEnd(rs, FEATURE_TDD, executors);
  assert.equal(rs.status, 'escalated');
  assert.match(rs.note, /analyze/);
  assert.equal(calls.filter((c) => c === 'analyze_failure').length, 5);
});

test('테스트 변조(tampered)면 같은 coder step 으로 돌아간다', () => {
  const { executors } = fakeExecutors({ plan: ['ok'], write_tests: ['ok'], test: ['tampered', 'pass'], review: ['none'] });
  const wf = FEATURE_TDD;
  const rs = start();
  drive(rs, wf, { executors, config: CONFIG });
  completeCoder(rs, wf);
  drive(rs, wf, { executors, config: CONFIG });
  assert.equal(rs.status, 'waiting_coder');
  assert.equal(rs.current, 'impl');
});

test('실행 실패(error)면 failed 로 멈추고, 다시 drive 하면 같은 step 부터 재시도한다', () => {
  const { calls, executors } = fakeExecutors({ plan: ['error', 'ok'], write_tests: ['ok'] });
  const rs = start();
  drive(rs, FEATURE_TDD, { executors, config: CONFIG });
  assert.equal(rs.status, 'failed');
  assert.equal(rs.current, 'plan');
  assert.equal(rs.visits.plan, undefined); // 실패는 방문 횟수에 넣지 않는다
  drive(rs, FEATURE_TDD, { executors, config: CONFIG });
  assert.equal(rs.status, 'waiting_coder');
  assert.equal(rs.note, null); // 재시도 성공 후 이전 실패 사유가 남지 않는다
  assert.deepEqual(calls, ['plan', 'plan', 'write_tests']);
});

test('save 는 step 마다 호출되고, 저장본으로 이어서 진행할 수 있다', () => {
  const { executors } = fakeExecutors({ plan: ['ok'], write_tests: ['ok'], test: ['pass'], review: ['none'] });
  let saved = null;
  const save = (r) => (saved = JSON.parse(JSON.stringify(r)));
  const rs = start();
  drive(rs, FEATURE_TDD, { executors, config: CONFIG, save });
  assert.equal(saved.status, 'waiting_coder');
  const restored = saved; // 프로세스 재시작을 흉내
  completeCoder(restored, FEATURE_TDD);
  drive(restored, FEATURE_TDD, { executors, config: CONFIG, save });
  assert.equal(saved.status, 'done');
});

test('completeCoder: coder 차례가 아니면 거부한다', () => {
  const rs = start();
  assert.throws(() => completeCoder(rs, FEATURE_TDD), /coder 차례가 아닙니다/);
});

test('history 는 coder step 의 소요 시간을 기록한다', () => {
  const { executors } = fakeExecutors({ plan: ['ok'], write_tests: ['ok'], test: ['pass'], review: ['none'] });
  let t = new Date('2026-11-23T06:30:00Z').getTime();
  const now = () => new Date((t += 1000));
  const rs = start();
  drive(rs, FEATURE_TDD, { executors, config: CONFIG, now });
  t += 60_000; // Claude 가 1분 동안 구현
  completeCoder(rs, FEATURE_TDD, { now });
  const impl = rs.history.find((h) => h.step === 'impl');
  assert.equal(impl.kind, 'coder');
  assert.ok(impl.elapsedMs >= 60_000);
});

test('recordDispute: 기각이 한도에 닿으면 escalated', () => {
  const rs = start();
  rs.status = 'waiting_coder';
  rs.current = 'fix';
  assert.equal(recordDispute(rs, { verdict: 'accept', reason: 'ok' }), 0);
  assert.equal(recordDispute(rs, { verdict: 'reject', reason: 'no' }), 1);
  assert.equal(rs.status, 'waiting_coder');
  assert.equal(recordDispute(rs, { verdict: 'reject', reason: 'no' }), 2);
  assert.equal(rs.status, 'escalated');
  assert.equal(rs.disputes.length, 3);
});
