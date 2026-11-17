#!/usr/bin/env node
// cca-workflow 오케스트레이션 CLI
// 하위 명령: pm / test / debug
// codex(PM) · agy(Debugger) 호출과 테스트 실행을 이 한 곳으로 통일한다.
// 속도 최적화: 디버거 프롬프트에 로그/diff/신규파일 내용을 직접 포함해
//   에이전트가 파일을 열 필요가 없게 한다("다른 파일은 열지 마라").

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..'); // 저장소 루트
const AI_DIR = resolve(ROOT, '.ai');
const PROMPTS_DIR = resolve(AI_DIR, 'prompts');

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
// shell:true 로 실행하되 인자를 직접 따옴표로 감싸 안전하게 전달한다.
function quoteArg(a) {
  // 우리 인자는 ASCII(경로/고정 문구)뿐이라 큰따옴표 래핑으로 충분하다.
  return `"${String(a).replace(/"/g, '\\"')}"`;
}

// 외부 명령 실행 (타임아웃 + 소요시간 출력). 반환: {status, timedOut, notFound, elapsedMs}
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
  if (notFound) {
    console.error(`[cca] '${cmd}' 실행 파일을 찾을 수 없습니다. PATH/로그인을 확인하세요.`);
  }
  if (timedOut) {
    console.error(`[cca] '${cmd}' 가 ${EXTERNAL_TIMEOUT_MS / 60000}분 타임아웃으로 종료되었습니다.`);
  }
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
  const p = resolve(PROMPTS_DIR, `${name}.md`);
  writeFileSync(p, body, 'utf8');
  return '.ai/prompts/' + name + '.md';
}

function followInstruction(relPath) {
  return `Read the file ${relPath} and follow its instructions exactly.`;
}

// 마지막 N줄만 남긴다 (앞부분이 잘리면 안내 표시)
function tailLines(text, n = TAIL_LINES) {
  const lines = (text || '').split('\n');
  if (lines.length <= n) return text || '';
  return `… (앞 ${lines.length - n}줄 생략) …\n` + lines.slice(-n).join('\n');
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
  const effort = CONFIG.pmReasoningEffort || 'medium';
  console.log(`[cca] PM(codex) 실행 (effort=${effort}) → ${planFile}`);
  const r = run(
    'codex',
    [
      'exec',
      '-c',
      `model_reasoning_effort=${effort}`,
      followInstruction(rel),
      '-s',
      'read-only',
      '-o',
      planFile,
    ],
    { label: 'codex(pm)' }
  );
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
  const effort =
    (mode === 'fail' ? CONFIG.debugEffortFail : CONFIG.debugEffortReview) ||
    (mode === 'fail' ? 'high' : 'low');
  console.log(`[cca] debug 모드: ${mode} (effort=${effort})`);

  // 변경사항 수집: git diff + git status --porcelain
  const diff = run('git', ['diff'], { capture: true, label: 'git diff' });
  writeFileSync(resolve(AI_DIR, 'changes.diff'), diff.stdout, 'utf8');
  const status = run('git', ['status', '--porcelain'], { capture: true, label: 'git status' });
  writeFileSync(resolve(AI_DIR, 'changes.status'), status.stdout, 'utf8');
  const untracked = status.stdout
    .split('\n')
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    // 워크플로 자신의 런타임 산출물(.ai/, 디렉터리 항목)은 첨부 대상에서 제외
    .filter((f) => !f.startsWith('.ai/') && !f.endsWith('/'));

  // 신규 파일 내용 인라인 포함 (작은 파일만)
  const inlineFiles = [];
  const bigFiles = [];
  for (const f of untracked) {
    const abs = resolve(ROOT, f);
    try {
      const sz = statSync(abs).size;
      if (sz <= INLINE_FILE_MAX_BYTES) {
        inlineFiles.push(`--- ${f} ---\n${readFileSync(abs, 'utf8')}`);
      } else {
        bigFiles.push(`${f} (${sz} bytes, 너무 커서 생략)`);
      }
    } catch {
      bigFiles.push(`${f} (읽기 실패)`);
    }
  }

  // 프롬프트 공통 꼬리: 첨부 섹션
  const attachments = [];
  if (mode === 'fail') {
    attachments.push('===== 테스트 로그 (마지막 300줄) =====', tailLines(readSafe('test.log')), '');
  }
  attachments.push('===== git diff (마지막 300줄) =====', tailLines(diff.stdout) || '(빈 diff)', '');
  attachments.push('===== git status --porcelain =====', status.stdout.trim() || '(없음)', '');
  if (inlineFiles.length) {
    attachments.push('===== 신규 파일 내용 =====', inlineFiles.join('\n\n'), '');
  }
  if (bigFiles.length) {
    attachments.push('===== 포함되지 않은 신규 파일 =====', bigFiles.join('\n'), '');
  }

  let header;
  if (mode === 'fail') {
    header = [
      '너는 디버거다. 테스트가 실패했다.',
      '아래에 **필요한 모든 정보(테스트 로그, git diff, git status, 신규 파일 내용)를 직접 첨부**했다.',
      '**추가로 다른 파일을 열지 마라.** 첨부된 내용만으로 실패 원인과 구체적 수정안을 제시하라.',
      '**파일은 수정하지 마라.**',
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
    [
      '-p',
      followInstruction(rel),
      '--mode',
      'plan',
      '--effort',
      effort,
      '--output-format',
      'json',
      '--json-schema',
      '.ai/debug-schema.json',
      '--print-timeout',
      '5m',
    ],
    { capture: true, label: `agy(${mode})` }
  );

  if (r.notFound || r.timedOut || r.status !== 0) {
    console.error('[cca] agy 실행 실패.');
    if (r.stderr) console.error(r.stderr.trim());
    return 1; // 실행 실패만 비0
  }

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

function readSafe(name) {
  try {
    return readFileSync(resolve(AI_DIR, name), 'utf8');
  } catch {
    return '';
  }
}

// agy json 출력에서 스키마 객체를 최대한 견고하게 추출
function extractJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct && typeof direct === 'object') {
    return pickSchema(direct);
  }
  const candidates = [...trimmed.matchAll(/\{[\s\S]*?\}/g)].map((m) => m[0]);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const obj = tryParse(candidates[i]);
    if (obj && obj.severity) return obj;
  }
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
