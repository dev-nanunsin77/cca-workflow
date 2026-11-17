#!/usr/bin/env node
// cca-workflow 오케스트레이션 CLI
// 하위 명령: pm / test / debug
// codex(PM) · agy(Debugger) 호출과 테스트 실행을 이 한 곳으로 통일한다.
// 긴 프롬프트는 .ai/prompts/<단계>.md 로 저장하고 CLI 에는
//   "Read the file <경로> and follow its instructions exactly." 만 전달한다.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..'); // 저장소 루트
const AI_DIR = resolve(ROOT, '.ai');
const PROMPTS_DIR = resolve(AI_DIR, 'prompts');

const EXTERNAL_TIMEOUT_MS = 12 * 60 * 1000; // 외부 CLI 12분 (셸 15분보다 짧게)

const CONFIG = loadConfig();

function loadConfig() {
  const p = resolve(ROOT, '.cca/config.json');
  const defaults = { testCommand: 'node --test', planFile: 'docs/plan.md', maxDebugRetries: 5 };
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

// 외부 명령 실행 (타임아웃 적용). 반환: {status, timedOut, notFound}
function run(cmd, args, { capture = false } = {}) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    timeout: EXTERNAL_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
  });
  const notFound = res.error && res.error.code === 'ENOENT';
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  if (notFound) {
    console.error(`[cca] '${cmd}' 실행 파일을 찾을 수 없습니다. PATH/로그인을 확인하세요.`);
  }
  if (timedOut) {
    console.error(`[cca] '${cmd}' 가 ${EXTERNAL_TIMEOUT_MS / 60000}분 타임아웃으로 종료되었습니다.`);
  }
  return {
    status: res.status == null ? (res.error ? 1 : 0) : res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut,
    notFound,
  };
}

function writePrompt(name, body) {
  ensureDirs();
  const p = resolve(PROMPTS_DIR, `${name}.md`);
  writeFileSync(p, body, 'utf8');
  return '.ai/prompts/' + name + '.md';
}

function followInstruction(relPath) {
  return `Read the file ${relPath} and follow its instructions exactly.`;
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
    '문서는 **정확히 다음 5개 제목**을 순서대로 포함해야 한다:',
    '- `## 목표`',
    '- `## 작업 목록`  (각 항목은 `- [ ]` 체크박스)',
    '- `## 수용 기준`',
    '- `## 테스트 시나리오`',
    '- `## 위험 요소`',
    '',
    '요구사항:',
    requirement,
    '',
  ].join('\n');
  const rel = writePrompt('pm', promptBody);
  const planFile = CONFIG.planFile || 'docs/plan.md';
  console.log(`[cca] PM(codex) 실행 → ${planFile}`);
  const r = run('codex', ['exec', followInstruction(rel), '-s', 'read-only', '-o', planFile]);
  if (r.status === 0 && existsSync(resolve(ROOT, planFile))) {
    console.log(`[cca] plan 생성 완료: ${planFile}`);
  } else {
    console.error('[cca] PM 단계 실패.');
  }
  return r.status;
}

// ---------- test ----------
function cmdTest() {
  ensureDirs();
  const testCmd = CONFIG.testCommand || 'node --test';
  console.log(`[cca] 테스트 실행: ${testCmd}`);
  // 셸로 실행하되 출력 캡처 → test.log + 콘솔
  const res = spawnSync(testCmd, {
    cwd: ROOT,
    timeout: EXTERNAL_TIMEOUT_MS,
    encoding: 'utf8',
    shell: true,
  });
  const out = (res.stdout ?? '') + (res.stderr ?? '');
  process.stdout.write(out);
  const logPath = resolve(AI_DIR, 'test.log');
  writeFileSync(logPath, out, 'utf8');
  const exitCode = res.status == null ? 1 : res.status;
  const passed = exitCode === 0;
  writeFileSync(
    resolve(AI_DIR, 'last-test.json'),
    JSON.stringify({ exitCode, passed }, null, 2),
    'utf8'
  );
  console.log(`[cca] 테스트 ${passed ? '통과' : '실패'} (exit ${exitCode}) → .ai/test.log`);
  return exitCode;
}

// ---------- debug ----------
function cmdDebug(modeArg) {
  ensureDirs();
  // 모드 결정: 인자 우선, 없으면 last-test.json 자동판단
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
  console.log(`[cca] debug 모드: ${mode}`);

  // 변경사항 수집: git diff + git status --porcelain
  const diff = run('git', ['diff'], { capture: true });
  writeFileSync(resolve(AI_DIR, 'changes.diff'), diff.stdout, 'utf8');
  const status = run('git', ['status', '--porcelain'], { capture: true });
  writeFileSync(resolve(AI_DIR, 'changes.status'), status.stdout, 'utf8');
  const untracked = status.stdout
    .split('\n')
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);

  const untrackedNote =
    untracked.length > 0
      ? `\n새로 생성된(아직 추적되지 않은) 파일은 diff에 안 나오니 직접 열어서 확인하라:\n${untracked.map((f) => '- ' + f).join('\n')}\n`
      : '';

  let promptBody;
  if (mode === 'fail') {
    promptBody = [
      '너는 디버거다. 테스트가 실패했다.',
      '다음 파일들을 읽고 실패 원인과 구체적 수정안을 제시하라. **파일은 수정하지 마라.**',
      '- `.ai/test.log` (테스트 출력)',
      '- `.ai/changes.diff` (git diff)',
      '- `.ai/changes.status` (git status --porcelain)',
      untrackedNote,
      '결과는 요구된 JSON 스키마(root_cause / fix_suggestion / files_to_change / severity)로만 응답하라.',
    ].join('\n');
  } else {
    promptBody = [
      '너는 코드 리뷰어다. 테스트는 이미 통과했다.',
      '`.ai/test.log` 는 보지 말고, 변경된 코드를 리뷰하라. **파일은 수정하지 마라.**',
      '다음을 읽어라:',
      '- `.ai/changes.diff` (git diff)',
      '- `.ai/changes.status` (git status --porcelain)',
      untrackedNote,
      '버그·설계 결함·누락된 처리를 찾아 severity 로 평가하라.',
      '결과는 요구된 JSON 스키마(root_cause / fix_suggestion / files_to_change / severity)로만 응답하라.',
      '(review 모드에서 root_cause 는 핵심 리뷰 요약, fix_suggestion 은 개선 제안으로 사용)',
    ].join('\n');
  }
  const rel = writePrompt('debug', promptBody);

  console.log('[cca] 디버거(agy) 실행...');
  const r = run(
    'agy',
    [
      '-p',
      followInstruction(rel),
      '--mode',
      'plan',
      '--effort',
      'high',
      '--output-format',
      'json',
      '--json-schema',
      '.ai/debug-schema.json',
      '--print-timeout',
      '5m',
    ],
    { capture: true }
  );

  if (r.notFound || r.timedOut || r.status !== 0) {
    console.error('[cca] agy 실행 실패.');
    if (r.stderr) console.error(r.stderr.trim());
    return 1; // 실행 실패만 비0
  }

  // agy json 출력 파싱: 스키마 객체 추출
  const parsed = extractJson(r.stdout);
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
  if (Array.isArray(parsed.files_to_change) && parsed.files_to_change.length) {
    console.log(`[대상 파일] ${parsed.files_to_change.join(', ')}`);
  }
  console.log('=======================\n');
  // 실행 성공이면 severity 와 무관하게 0, severity 는 마지막 줄로 노출
  console.log(`SEVERITY: ${severity}`);
  return 0;
}

// agy json 출력에서 스키마 객체를 최대한 견고하게 추출
function extractJson(text) {
  if (!text) return null;
  // 1) 전체가 JSON 인 경우
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct && typeof direct === 'object') {
    return pickSchema(direct);
  }
  // 2) severity 키를 포함하는 마지막 JSON 객체를 역순으로 탐색
  const candidates = [...trimmed.matchAll(/\{[\s\S]*?\}/g)].map((m) => m[0]);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const obj = tryParse(candidates[i]);
    if (obj && obj.severity) return obj;
  }
  // 3) 중첩 구조일 수 있으니 전체에서 severity 포함 객체 재귀 탐색
  if (direct) {
    const found = findWithSeverity(direct);
    if (found) return found;
  }
  return null;
}

function pickSchema(obj) {
  if (obj.severity) return obj;
  const found = findWithSeverity(obj);
  return found || obj;
}

function findWithSeverity(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.severity) return obj;
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = findWithSeverity(v);
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
  node .cca/cca.mjs pm "<요구사항>"     PM(codex)로 docs/plan.md 생성
  node .cca/cca.mjs test                테스트 실행 → .ai/test.log
  node .cca/cca.mjs debug [fail|review] 디버거(agy) 실행 (모드 생략 시 자동판단)`);
}

const [sub, ...rest] = process.argv.slice(2);
let code = 0;
switch (sub) {
  case 'pm':
    code = cmdPm(rest.join(' ').trim());
    break;
  case 'test':
    code = cmdTest();
    break;
  case 'debug':
    code = cmdDebug(rest[0]);
    break;
  default:
    usage();
    code = sub ? 2 : 0;
}
process.exit(code);
