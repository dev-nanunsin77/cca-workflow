#!/usr/bin/env node
// cca-workflow 오케스트레이션 CLI
// 하위 명령: pm / tests / test / debug / dispute
// codex(PM) · agy(Debugger/테스트작성/판정) 호출과 테스트 실행을 이 한 곳으로 통일한다.
//
// "테스트 선작성 + 테스트 잠금" 구조:
//   tests   : agy 가 plan.md 를 보고 테스트 파일을 생성(JSON으로 받아 cca 가 저장),
//             해시를 .ai/test-lock.json 에 기록, 1회 실행해 red(전부 실패) 확인.
//   test    : 실행 전 잠금 해시와 비교, 다르면 "테스트 변조" 로 실패 처리.
//   dispute : 테스트가 틀렸다는 이의를 agy 가 판정, accept 면 테스트 교체 + 해시 갱신.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..'); // 저장소 루트
const AI_DIR = resolve(ROOT, '.ai');
const PROMPTS_DIR = resolve(AI_DIR, 'prompts');
const LOCK_PATH = resolve(AI_DIR, 'test-lock.json');

const EXTERNAL_TIMEOUT_MS = 12 * 60 * 1000; // 외부 CLI 12분 (셸 15분보다 짧게)
const TAIL_LINES = 300; // 로그/diff 첨부 시 마지막 N줄
const INLINE_FILE_MAX_BYTES = 16 * 1024; // 신규 파일 인라인 포함 상한

const CONFIG = loadConfig();

function loadConfig() {
  const p = resolve(ROOT, '.cca/config.json');
  const defaults = {
    testCommand: 'node --test',
    planFile: 'docs/plan.md',
    maxDebugRetries: 5,
    pmReasoningEffort: 'medium',
    debugEffortFail: 'high',
    debugEffortReview: 'low',
    testsEffort: 'high',
    disputeEffort: 'high',
  };
  if (!existsSync(p)) return defaults;
  try {
    return { ...defaults, ...JSON.parse(readFileSync(p, 'utf8')) };
  } catch (e) {
    console.error(`[cca] .cca/config.json 파싱 실패: ${e.message}`);
    return defaults;
  }
}

function ensureDirs() {
  for (const d of [AI_DIR, PROMPTS_DIR, resolve(ROOT, 'docs')]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

// Windows 에서 codex/agy 같은 .cmd 셰임을 찾으려면 shell 경유가 필요하다.
function quoteArg(a) {
  return `"${String(a).replace(/"/g, '\\"')}"`;
}

// 외부 명령 실행 (타임아웃 + 소요시간 출력).
function run(cmd, args, { capture = false, label } = {}) {
  const line = [cmd, ...args.map(quoteArg)].join(' ');
  const start = process.hrtime.bigint();
  const res = spawnSync(line, {
    cwd: ROOT,
    timeout: EXTERNAL_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: true,
  });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const notFound = res.error && res.error.code === 'ENOENT';
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  if (notFound) console.error(`[cca] '${cmd}' 실행 파일을 찾을 수 없습니다. PATH/로그인을 확인하세요.`);
  if (timedOut) console.error(`[cca] '${cmd}' 가 ${EXTERNAL_TIMEOUT_MS / 60000}분 타임아웃.`);
  console.log(`[cca] ⏱ ${label || cmd} ${(elapsedMs / 1000).toFixed(1)}s`);
  return {
    status: res.status == null ? (res.error ? 1 : 0) : res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut,
    notFound,
    elapsedMs,
  };
}

function writePrompt(name, body) {
  ensureDirs();
  writeFileSync(resolve(PROMPTS_DIR, `${name}.md`), body, 'utf8');
  return '.ai/prompts/' + name + '.md';
}
function followInstruction(relPath) {
  return `Read the file ${relPath} and follow its instructions exactly.`;
}
function tailLines(text, n = TAIL_LINES) {
  const lines = (text || '').split('\n');
  if (lines.length <= n) return text || '';
  return `… (앞 ${lines.length - n}줄 생략) …\n` + lines.slice(-n).join('\n');
}
function readSafe(abs) {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}
function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// 저장소 루트 안에 있는 상대 경로만 허용(경로 이탈 차단)
function safeRel(p) {
  const rel = String(p).replace(/\\/g, '/');
  const abs = resolve(ROOT, rel);
  const r = relative(ROOT, abs);
  if (r.startsWith('..') || resolve(ROOT, r) !== abs) return null;
  return rel;
}

// agy 가 생성한 파일들을 저장하고 {rel: hash} 반환
function saveFiles(files) {
  const map = {};
  for (const f of files || []) {
    const rel = safeRel(f.path);
    if (!rel) {
      console.error(`[cca] 경로 이탈 거부: ${f.path}`);
      continue;
    }
    const abs = resolve(ROOT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, 'utf8');
    map[rel] = sha256(f.content);
    console.log(`[cca] 테스트 파일 저장: ${rel}`);
  }
  return map;
}

function loadLock() {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  } catch {
    return null;
  }
}
function writeLock(filesMap) {
  ensureDirs();
  writeFileSync(LOCK_PATH, JSON.stringify({ files: filesMap }, null, 2), 'utf8');
}

// ---------- 테스트 실행(원시) ----------
function runTestsRaw() {
  ensureDirs();
  const testCmd = CONFIG.testCommand || 'node --test';
  console.log(`[cca] 테스트 실행: ${testCmd}`);
  const start = process.hrtime.bigint();
  const res = spawnSync(testCmd, {
    cwd: ROOT,
    timeout: EXTERNAL_TIMEOUT_MS,
    encoding: 'utf8',
    shell: true,
  });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const out = (res.stdout ?? '') + (res.stderr ?? '');
  process.stdout.write(out);
  writeFileSync(resolve(AI_DIR, 'test.log'), out, 'utf8');
  const exitCode = res.status == null ? 1 : res.status;
  const passed = exitCode === 0;
  writeFileSync(
    resolve(AI_DIR, 'last-test.json'),
    JSON.stringify({ exitCode, passed }, null, 2),
    'utf8'
  );
  console.log(`[cca] ⏱ test ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`[cca] 테스트 ${passed ? '통과' : '실패'} (exit ${exitCode}) → .ai/test.log`);
  return { exitCode, passed, out };
}

// node --test 요약에서 pass/fail 수 추출(다른 러너면 null)
function parseCounts(out) {
  const mp = out.match(/(?:ℹ\s*)?pass (\d+)/);
  const mf = out.match(/(?:ℹ\s*)?fail (\d+)/);
  return {
    pass: mp ? Number(mp[1]) : null,
    fail: mf ? Number(mf[1]) : null,
  };
}

// ---------- pm ----------
function cmdPm(requirement) {
  if (!requirement) {
    console.error('[cca] 사용법: node .cca/cca.mjs pm "<요구사항>"');
    return 2;
  }
  const promptBody = [
    '너는 PM이다. 아래 요구사항을 분석해 Markdown 문서를 작성한다.',
    '',
    '**중요: 파일을 쓰지 말고 문서를 응답(표준 출력)으로만 내보내라.** 저장은 호출 측의 -o 옵션이 처리한다.',
    '',
    '문서는 **정확히 다음 6개 제목**을 순서대로 포함해야 한다:',
    '- `## 목표`',
    '- `## 작업 목록`  (각 항목은 `- [ ]` 체크박스)',
    '- `## 수용 기준`',
    '- `## 테스트 시나리오`',
    '- `## 위험 요소`',
    '- `## 인터페이스 계약`  (파일명, export 함수 시그니처, 입출력 타입, 에러 형식/메시지 규약을 구체적으로)',
    '',
    '`## 인터페이스 계약` 은 이후 단계에서 테스트를 먼저 작성하는 근거가 되므로,',
    '모호함 없이 파일 경로·함수명·인자·반환형·에러 조건을 못박아라.',
    '',
    '요구사항:',
    requirement,
    '',
  ].join('\n');
  const rel = writePrompt('pm', promptBody);
  const planFile = CONFIG.planFile || 'docs/plan.md';
  const effort = CONFIG.pmReasoningEffort || 'medium';
  console.log(`[cca] PM(codex) 실행 (effort=${effort}) → ${planFile}`);
  const r = run(
    'codex',
    ['exec', '-c', `model_reasoning_effort=${effort}`, followInstruction(rel), '-s', 'read-only', '-o', planFile],
    { label: 'codex(pm)' }
  );
  if (r.status === 0 && existsSync(resolve(ROOT, planFile))) {
    console.log(`[cca] plan 생성 완료: ${planFile}`);
  } else {
    console.error('[cca] PM 단계 실패.');
  }
  return r.status;
}

// ---------- tests (테스트 선작성 + 잠금) ----------
function cmdTests() {
  ensureDirs();
  const planFile = CONFIG.planFile || 'docs/plan.md';
  const planAbs = resolve(ROOT, planFile);
  if (!existsSync(planAbs)) {
    console.error(`[cca] ${planFile} 가 없습니다. 먼저 pm 을 실행하세요.`);
    return 2;
  }
  const effort = CONFIG.testsEffort || 'high';
  const promptBody = [
    '너는 테스트 작성자다. 아래 계획(plan.md)의 `## 인터페이스 계약` 과 `## 수용 기준`,',
    '`## 테스트 시나리오` 를 근거로 **실행 가능한 테스트 파일**을 작성하라.',
    '',
    '규칙:',
    '- 구현 코드는 아직 존재하지 않는다. 테스트는 인터페이스 계약에 명시된 모듈/함수를 import 해 검증한다.',
    '- 러너는 `node --test` + `node:assert` 를 사용한다(별도 설치 금지).',
    '- 각 수용 기준/시나리오를 빠짐없이 커버하라.',
    '- 테스트만 작성하라. 구현 파일은 만들지 마라.',
    '- **다른 파일을 열지 마라.** 아래 첨부된 plan 내용만으로 작성하라.',
    '',
    '출력은 요구된 JSON 스키마 `{ files: [{ path, content }] }` 로만 응답하라.',
    'path 는 저장소 루트 기준 상대 경로다(예: `csv.test.mjs`).',
    '',
    '===== plan.md =====',
    readSafe(planAbs),
  ].join('\n');
  const rel = writePrompt('tests', promptBody);

  console.log(`[cca] 테스트 작성(agy, effort=${effort})...`);
  const r = run(
    'agy',
    ['-p', followInstruction(rel), '--mode', 'plan', '--effort', effort,
      '--output-format', 'json', '--json-schema', '.ai/tests-schema.json', '--print-timeout', '5m'],
    { capture: true, label: 'agy(tests)' }
  );
  if (r.notFound || r.timedOut || r.status !== 0) {
    console.error('[cca] agy(tests) 실행 실패.');
    if (r.stderr) console.error(r.stderr.trim());
    return 1;
  }
  const parsed = extractJson(r.stdout, 'files');
  if (!parsed || !Array.isArray(parsed.files) || parsed.files.length === 0) {
    console.error('[cca] agy 출력에서 files 를 파싱하지 못했습니다. 원본:');
    console.error(r.stdout);
    return 1;
  }

  const map = saveFiles(parsed.files);
  if (Object.keys(map).length === 0) {
    console.error('[cca] 저장된 테스트 파일이 없습니다.');
    return 1;
  }
  writeLock(map);
  console.log(`[cca] 테스트 잠금 기록: .ai/test-lock.json (${Object.keys(map).length}개 파일)`);

  // red 확인: 구현이 없으니 전부 실패해야 한다
  console.log('[cca] red 확인을 위해 테스트 1회 실행...');
  const t = runTestsRaw();
  const { pass, fail } = parseCounts(t.out);
  if (pass != null) {
    if (pass > 0)
      console.warn(`[cca] ⚠ 경고: 통과하는 테스트가 ${pass}개 있습니다. 테스트는 모두 실패(red)여야 합니다.`);
    if (fail === 0)
      console.warn('[cca] ⚠ 경고: 실패(red)하는 테스트가 없습니다. 테스트가 구현을 제대로 강제하는지 확인하세요.');
    if (pass === 0 && fail != null && fail > 0)
      console.log('[cca] ✅ red 확인: 모든 테스트가 실패 상태입니다.');
  } else if (t.passed) {
    console.warn('[cca] ⚠ 경고: 테스트가 통과했습니다(red 여야 함).');
  } else {
    console.log('[cca] red 확인: 테스트가 실패 상태입니다(카운트 파싱 불가).');
  }
  return 0;
}

// ---------- test (잠금 검증 후 실행) ----------
function cmdTest() {
  const lock = loadLock();
  if (lock && lock.files) {
    const tampered = [];
    for (const [rel, h] of Object.entries(lock.files)) {
      const cur = sha256(readSafe(resolve(ROOT, rel)));
      if (cur !== h) tampered.push(rel);
    }
    if (tampered.length) {
      console.error('[cca] ❌ 테스트 변조 감지. 잠금과 다른 테스트 파일:');
      for (const f of tampered) console.error(`  - ${f}`);
      console.error('[cca] 테스트는 직접 수정할 수 없습니다. 변경이 필요하면 `dispute` 로 이의를 제기하세요.');
      return 3;
    }
  } else {
    console.warn('[cca] ⚠ 테스트 잠금(.ai/test-lock.json)이 없습니다. 먼저 `tests` 로 생성하세요.');
  }
  const t = runTestsRaw();
  return t.exitCode;
}

// ---------- dispute (테스트 이의 판정) ----------
function cmdDispute(claim) {
  if (!claim) {
    console.error('[cca] 사용법: node .cca/cca.mjs dispute "<이의 내용 (plan 조항 인용 필수)>"');
    return 2;
  }
  const lock = loadLock();
  if (!lock || !lock.files) {
    console.error('[cca] 잠긴 테스트가 없습니다. 먼저 `tests` 를 실행하세요.');
    return 2;
  }
  const planFile = CONFIG.planFile || 'docs/plan.md';
  const effort = CONFIG.disputeEffort || 'high';

  const lockedFiles = Object.keys(lock.files)
    .map((rel) => `--- ${rel} ---\n${readSafe(resolve(ROOT, rel))}`)
    .join('\n\n');

  const promptBody = [
    '너는 테스트 판정관이다. 구현자(Claude)가 특정 테스트가 "계약(plan)에 어긋나 틀렸다"고 이의를 제기했다.',
    '너의 임무는 plan.md 를 기준으로 이의가 타당한지 판정하는 것이다.',
    '',
    '판정 규칙:',
    '- 이의가 plan 의 조항(인터페이스 계약/수용 기준/테스트 시나리오)에 근거해 테스트가 틀렸음을 입증하면 `accept`.',
    '- 단지 구현이 어렵거나 테스트가 엄격하다는 이유라면 `reject`.',
    '- `accept` 인 경우, plan 에 부합하도록 수정한 **테스트 파일 전체 내용**을 files 로 함께 제시하라.',
    '- **다른 파일을 열지 마라.** 아래 첨부된 plan 과 현재 테스트만 근거로 판정하라.',
    '',
    '출력은 요구된 JSON 스키마 `{ verdict: "accept"|"reject", reason, files?: [{path,content}] }` 로만.',
    '',
    '===== 구현자의 이의 =====',
    claim,
    '',
    '===== plan.md =====',
    readSafe(resolve(ROOT, planFile)),
    '',
    '===== 현재 잠긴 테스트 =====',
    lockedFiles,
  ].join('\n');
  const rel = writePrompt('dispute', promptBody);

  console.log(`[cca] 이의 판정(agy, effort=${effort})...`);
  const r = run(
    'agy',
    ['-p', followInstruction(rel), '--mode', 'plan', '--effort', effort,
      '--output-format', 'json', '--json-schema', '.ai/dispute-schema.json', '--print-timeout', '5m'],
    { capture: true, label: 'agy(dispute)' }
  );
  if (r.notFound || r.timedOut || r.status !== 0) {
    console.error('[cca] agy(dispute) 실행 실패.');
    if (r.stderr) console.error(r.stderr.trim());
    return 1;
  }
  const parsed = extractJson(r.stdout, 'verdict');
  if (!parsed || !parsed.verdict) {
    console.error('[cca] agy 출력에서 verdict 를 파싱하지 못했습니다. 원본:');
    console.error(r.stdout);
    return 1;
  }
  writeFileSync(resolve(AI_DIR, 'dispute.json'), JSON.stringify(parsed, null, 2), 'utf8');

  console.log('\n===== 이의 판정 =====');
  console.log(`[사유] ${parsed.reason ?? '(없음)'}`);
  console.log('=====================\n');

  if (parsed.verdict === 'accept' && Array.isArray(parsed.files) && parsed.files.length) {
    const changed = saveFiles(parsed.files);
    const merged = { ...lock.files, ...changed };
    writeLock(merged);
    console.log(`[cca] ✅ accept: 테스트 ${Object.keys(changed).length}개 교체 + 잠금 갱신.`);
  } else if (parsed.verdict === 'accept') {
    console.warn('[cca] accept 지만 수정 파일(files)이 없어 테스트를 교체하지 않았습니다.');
  } else {
    console.log('[cca] reject: 테스트는 그대로 유지됩니다.');
  }
  console.log(`VERDICT: ${parsed.verdict}`);
  return 0;
}

// ---------- debug ----------
function cmdDebug(modeArg) {
  ensureDirs();
  let mode = modeArg;
  if (mode !== 'fail' && mode !== 'review') {
    let passed = false;
    try {
      passed = JSON.parse(readFileSync(resolve(AI_DIR, 'last-test.json'), 'utf8')).passed === true;
    } catch {
      passed = false;
    }
    mode = passed ? 'review' : 'fail';
  }
  const effort =
    (mode === 'fail' ? CONFIG.debugEffortFail : CONFIG.debugEffortReview) ||
    (mode === 'fail' ? 'high' : 'low');
  console.log(`[cca] debug 모드: ${mode} (effort=${effort})`);

  const diff = run('git', ['diff'], { capture: true, label: 'git diff' });
  writeFileSync(resolve(AI_DIR, 'changes.diff'), diff.stdout, 'utf8');
  const status = run('git', ['status', '--porcelain'], { capture: true, label: 'git status' });
  writeFileSync(resolve(AI_DIR, 'changes.status'), status.stdout, 'utf8');
  const untracked = status.stdout
    .split('\n')
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .filter((f) => !f.startsWith('.ai/') && !f.endsWith('/'));

  const inlineFiles = [];
  const bigFiles = [];
  for (const f of untracked) {
    const abs = resolve(ROOT, f);
    try {
      const sz = statSync(abs).size;
      if (sz <= INLINE_FILE_MAX_BYTES) inlineFiles.push(`--- ${f} ---\n${readFileSync(abs, 'utf8')}`);
      else bigFiles.push(`${f} (${sz} bytes, 너무 커서 생략)`);
    } catch {
      bigFiles.push(`${f} (읽기 실패)`);
    }
  }

  const attachments = [];
  if (mode === 'fail')
    attachments.push('===== 테스트 로그 (마지막 300줄) =====', tailLines(readSafe(resolve(AI_DIR, 'test.log'))), '');
  attachments.push('===== git diff (마지막 300줄) =====', tailLines(diff.stdout) || '(빈 diff)', '');
  attachments.push('===== git status --porcelain =====', status.stdout.trim() || '(없음)', '');
  if (inlineFiles.length) attachments.push('===== 신규 파일 내용 =====', inlineFiles.join('\n\n'), '');
  if (bigFiles.length) attachments.push('===== 포함되지 않은 신규 파일 =====', bigFiles.join('\n'), '');

  let header;
  if (mode === 'fail') {
    header = [
      '너는 디버거다. 테스트가 실패했다.',
      '아래에 **필요한 모든 정보(테스트 로그, git diff, git status, 신규 파일 내용)를 직접 첨부**했다.',
      '**추가로 다른 파일을 열지 마라.** 첨부된 내용만으로 실패 원인과 구체적 수정안을 제시하라.',
      '**파일은 수정하지 마라.** 특히 테스트 파일은 잠겨 있으니 구현을 고치는 방향으로 제안하라.',
      '결과는 요구된 JSON 스키마(root_cause / fix_suggestion / files_to_change / severity)로만 응답하라.',
      '',
    ];
  } else {
    header = [
      '너는 코드 리뷰어다. 테스트는 이미 통과했다(로그는 불필요하여 첨부하지 않음).',
      '아래에 **git diff, git status, 신규 파일 내용을 직접 첨부**했다.',
      '**추가로 다른 파일을 열지 마라.** 첨부된 변경 코드만 리뷰하라. **파일은 수정하지 마라.**',
      '버그·설계 결함·누락된 처리를 찾아 severity 로 평가하라.',
      '결과는 요구된 JSON 스키마(root_cause / fix_suggestion / files_to_change / severity)로만 응답하라.',
      '(review 모드에서 root_cause 는 핵심 리뷰 요약, fix_suggestion 은 개선 제안으로 사용)',
      '',
    ];
  }
  const rel = writePrompt('debug', [...header, ...attachments].join('\n'));

  console.log('[cca] 디버거(agy) 실행...');
  const r = run(
    'agy',
    ['-p', followInstruction(rel), '--mode', 'plan', '--effort', effort,
      '--output-format', 'json', '--json-schema', '.ai/debug-schema.json', '--print-timeout', '5m'],
    { capture: true, label: `agy(${mode})` }
  );
  if (r.notFound || r.timedOut || r.status !== 0) {
    console.error('[cca] agy 실행 실패.');
    if (r.stderr) console.error(r.stderr.trim());
    return 1;
  }
  const parsed = extractJson(r.stdout, 'severity');
  if (!parsed) {
    console.error('[cca] agy 출력에서 JSON 을 파싱하지 못했습니다. 원본:');
    console.error(r.stdout);
    return 1;
  }
  writeFileSync(resolve(AI_DIR, 'debug.json'), JSON.stringify(parsed, null, 2), 'utf8');

  const severity = parsed.severity ?? 'none';
  console.log('\n===== 디버거 결과 =====');
  console.log(`[원인/요약] ${parsed.root_cause ?? '(없음)'}`);
  console.log(`[수정/제안] ${parsed.fix_suggestion ?? '(없음)'}`);
  if (Array.isArray(parsed.files_to_change) && parsed.files_to_change.length)
    console.log(`[대상 파일] ${parsed.files_to_change.join(', ')}`);
  console.log('=======================\n');
  console.log(`SEVERITY: ${severity}`);
  return 0;
}

// agy json 출력에서 특정 key 를 가진 객체를 견고하게 추출
function extractJson(text, key) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  const direct = tryParse(trimmed);
  if (direct && typeof direct === 'object') {
    const found = findWithKey(direct, key);
    return found || direct;
  }
  const s = trimmed.indexOf('{');
  const e = trimmed.lastIndexOf('}');
  if (s >= 0 && e > s) {
    const obj = tryParse(trimmed.slice(s, e + 1));
    if (obj) return findWithKey(obj, key) || obj;
  }
  return null;
}
function findWithKey(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj;
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = findWithKey(v, key);
      if (r) return r;
    }
  }
  return null;
}
function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---------- main ----------
function usage() {
  console.log(`cca-workflow CLI
사용법:
  node .cca/cca.mjs pm "<요구사항>"        PM(codex)로 docs/plan.md 생성
  node .cca/cca.mjs tests                   plan 기반 테스트 선작성 + 잠금 + red 확인
  node .cca/cca.mjs test                    잠금 검증 후 테스트 실행
  node .cca/cca.mjs debug [fail|review]     디버거(agy) 실행 (모드 생략 시 자동판단)
  node .cca/cca.mjs dispute "<이의 내용>"   테스트 이의를 agy 가 판정(accept 시 교체)`);
}

const [sub, ...rest] = process.argv.slice(2);
let code = 0;
switch (sub) {
  case 'pm':
    code = cmdPm(rest.join(' ').trim());
    break;
  case 'tests':
    code = cmdTests();
    break;
  case 'test':
    code = cmdTest();
    break;
  case 'debug':
    code = cmdDebug(rest[0]);
    break;
  case 'dispute':
    code = cmdDispute(rest.join(' ').trim());
    break;
  default:
    usage();
    code = sub ? 2 : 0;
}
process.exit(code);
