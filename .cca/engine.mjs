// cca-workflow 워크플로 엔진 (순수 로직, 외부 CLI·파일 I/O 없음)
// workflow 정의(.cca/workflows/*.json)와 run 상태(.ai/run.json)를 받아
// 다음 step 을 결정하고 실행기를 호출한다. 실행기·저장은 호출 측이 주입한다.
//
// step.kind
//   agent : 외부 CLI task 실행 → 결과 키(ok, severity 등)
//   test  : 테스트 실행 → pass / fail / tampered
//   coder : Claude 차례. 엔진은 여기서 멈추고(waiting_coder) `next` 를 기다린다.
// step.on  : { <결과 키>: <step id | "done">, default: ... }. 없으면 다음 step.
// step.maxVisits : 숫자 또는 config 키 이름. 넘기면 run 이 escalated 로 멈춘다.

export const DONE = 'done';
const KINDS = new Set(['agent', 'test', 'coder']);

// workflow 정의 검증. 문제 목록(빈 배열이면 정상)을 반환한다.
export function validateWorkflow(wf, { tasks = null } = {}) {
  const errors = [];
  if (!wf || !Array.isArray(wf.steps) || wf.steps.length === 0) return ['steps 가 비어 있습니다.'];
  const ids = new Set();
  if (!wf.name) errors.push('name 이 없습니다.');
  for (const s of wf.steps) {
    const v = s.maxVisits;
    if (typeof v === 'number' && !(Number.isFinite(v) && v > 0))
      errors.push(`${s.id}: maxVisits 는 양수여야 합니다 (${v}).`);
  }
  for (const s of wf.steps) {
    if (!s.id) errors.push('id 없는 step 이 있습니다.');
    else if (ids.has(s.id)) errors.push(`중복 step id: ${s.id}`);
    else if (s.id === DONE) errors.push(`'${DONE}' 은 예약어라 step id 로 쓸 수 없습니다.`);
    ids.add(s.id);
    if (!KINDS.has(s.kind)) errors.push(`${s.id}: 알 수 없는 kind '${s.kind}'`);
    if (s.kind === 'agent' && !s.task) errors.push(`${s.id}: agent step 에 task 가 없습니다.`);
    if (s.kind === 'agent' && s.task && tasks && !tasks.includes(s.task))
      errors.push(`${s.id}: 알 수 없는 task '${s.task}'`);
  }
  for (const s of wf.steps) {
    for (const [k, target] of Object.entries(s.on || {})) {
      if (target !== DONE && !ids.has(target)) errors.push(`${s.id}.on.${k}: 없는 step '${target}'`);
    }
  }
  return errors;
}

export function findStep(wf, id) {
  return wf.steps.find((s) => s.id === id) || null;
}

// 결과 키로 다음 step id 결정: on[결과] → on.default → 다음 step → done
export function resolveNext(wf, stepId, resultKey) {
  const idx = wf.steps.findIndex((s) => s.id === stepId);
  if (idx < 0) throw new Error(`없는 step: ${stepId}`);
  const on = wf.steps[idx].on || {};
  if (resultKey != null && Object.prototype.hasOwnProperty.call(on, resultKey)) return on[resultKey];
  if (Object.prototype.hasOwnProperty.call(on, 'default')) return on.default;
  return idx + 1 < wf.steps.length ? wf.steps[idx + 1].id : DONE;
}

export function maxVisitsOf(step, config = {}) {
  const v = step.maxVisits;
  if (v == null) return Infinity;
  const n = typeof v === 'number' ? v : Number(config[v]);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

export function createRun({ workflow, requirement, reason = null, now = new Date() }) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  return {
    id: `${stamp}-${workflow.name}`,
    workflow: workflow.name,
    requirement,
    reason,
    status: 'running',
    current: workflow.steps[0].id,
    startedAt: now.toISOString(),
    endedAt: null,
    waitingSince: null,
    visits: {},
    disputes: [],
    history: [],
    note: null,
  };
}

function finish(run, status, note, now) {
  run.status = status;
  run.note = note ?? null;
  if (status === 'done' || status === 'escalated' || status === 'aborted') run.endedAt = now().toISOString();
}

// coder step 을 완료 처리하고 다음 step 으로 넘긴다.
export function completeCoder(run, wf, { now = () => new Date() } = {}) {
  const step = findStep(wf, run.current);
  if (run.status !== 'waiting_coder' || !step || step.kind !== 'coder')
    throw new Error(`coder 차례가 아닙니다 (status=${run.status}, step=${run.current}).`);
  const at = now();
  const elapsedMs = run.waitingSince ? at - new Date(run.waitingSince) : null;
  run.history.push({ step: step.id, kind: 'coder', result: 'ok', elapsedMs, at: at.toISOString() });
  run.waitingSince = null;
  run.current = resolveNext(wf, step.id, 'ok');
  run.status = 'running';
}

// coder step 이나 종료 상태에 닿을 때까지 자동 step 을 실행한다.
// executors: { agent(step, run) , test(step, run) } → { result, summary?, artifact?, backend?, elapsedMs? }
//   result === 'error' 이면 run 은 failed 로 멈추고, 같은 step 부터 재시도할 수 있다.
// save(run): step 마다 호출(중단 대비).
export function drive(run, wf, { executors, config = {}, save = () => {}, now = () => new Date() }) {
  if (run.status === 'failed') {
    run.status = 'running';
    run.note = null;
  }
  for (;;) {
    if (run.status !== 'running') return run;
    if (run.current === DONE) {
      finish(run, 'done', null, now);
      save(run);
      return run;
    }
    const step = findStep(wf, run.current);
    if (!step) {
      finish(run, 'failed', `workflow 에 없는 step: ${run.current}`, now);
      save(run);
      return run;
    }
    const visits = run.visits[step.id] || 0;
    const limit = maxVisitsOf(step, config);
    if (visits >= limit) {
      finish(run, 'escalated', `'${step.id}' 가 한도(${limit}회)에 도달했습니다.`, now);
      save(run);
      return run;
    }
    if (step.kind === 'coder') {
      run.status = 'waiting_coder';
      run.waitingSince = now().toISOString();
      run.visits[step.id] = visits + 1;
      save(run);
      return run;
    }
    const exec = executors[step.kind];
    if (!exec) throw new Error(`실행기 없음: ${step.kind}`);
    const out = exec(step, run) || {};
    const result = out.result ?? 'error';
    run.history.push({
      step: step.id,
      kind: step.kind,
      ...(step.task ? { task: step.task } : {}),
      ...(out.backend ? { backend: out.backend } : {}),
      result,
      ...(out.summary ? { summary: out.summary } : {}),
      ...(out.artifact ? { artifact: out.artifact } : {}),
      elapsedMs: out.elapsedMs ?? null,
      at: now().toISOString(),
    });
    if (result === 'error') {
      finish(run, 'failed', `'${step.id}' 실행 실패${out.summary ? `: ${out.summary}` : ''}`, now);
      save(run);
      return run;
    }
    run.visits[step.id] = visits + 1;
    run.current = resolveNext(wf, step.id, result);
    save(run);
  }
}

// dispute 결과 기록. 기각이 한도에 닿으면 escalated.
export function recordDispute(run, { verdict, reason }, { maxRejects = 2, now = () => new Date() } = {}) {
  run.disputes.push({ verdict, reason: reason ?? null, step: run.current, at: now().toISOString() });
  const rejects = run.disputes.filter((d) => d.verdict === 'reject').length;
  if (verdict === 'reject' && rejects >= maxRejects)
    finish(run, 'escalated', `dispute 가 ${rejects}회 기각되었습니다.`, now);
  return rejects;
}
