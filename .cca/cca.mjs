#!/usr/bin/env node
// cca-workflow 오케스트레이션 CLI
// 워크플로: run / next / status / abort  (흐름 정의는 .cca/workflows/*.json, 전이는 engine.mjs)
// 단일 명령: pm / tests / test / debug / dispute
// codex(PM) · agy(Debugger/테스트작성/판정) 호출과 테스트 실행을 이 한 곳으로 통일한다.
//
// "테스트 선작성 + 테스트 잠금" 구조:
//   tests   : agy 가 plan.md 를 보고 테스트 파일을 생성(JSON으로 받아 cca 가 저장),
//             해시를 .ai/test-lock.json 에 기록, 1회 실행해 red(전부 실패) 확인.
//   test    : 실행 전 잠금 해시와 비교, 다르면 "테스트 변조" 로 실패 처리.
//   dispute : 테스트가 틀렸다는 이의를 agy 가 판정, accept 면 테스트 교체 + 해시 갱신.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { completeCoder, createRun, drive, findStep, recordDispute, validateWorkflow } from './engine.mjs';
import { lockHash } from './lock.mjs';
import { agyDiag, parseAgy, untrackedFiles, extractJson, tryParse } from './parse.mjs';
import {
  backendLabel, backendsFor, isLimitHit, mapEffort, normalizeAgyUsage, normalizeCodexUsage,
  needsUsageRecheck, strictSchema, usageBlocked, validateRoles, withFallback,
} from './backends.mjs';

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
    language: 'auto', // auto | node | python | rust | cpp
    framework: null, // 언어별 대안 러너 (python: "pytest")
    testCommand: null, // 지정 시 프리셋 명령을 덮어씀
    planFile: 'docs/plan.md',
    maxDebugRetries: 5,
    maxDisputeRejects: 2, // run 하나에서 dispute 기각이 이 횟수에 닿으면 escalated
    usageCheck: true, // backend 호출 전 사용량 한도 확인(모델 호출 없음)
    usageMinRemaining: 0.05, // 남은 비율이 이 값 이하면 그 backend 를 건너뜀
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

// ---------- 언어 프리셋 ----------
// 각 프리셋: PM 계약 작성 기준(contractHint), 테스트 작성 규칙(testRules),
// 테스트 명령(testCommand), 러너 출력에서 pass/fail 수 추출(parseCounts).
const LANG_PRESETS = {
  node: {
    label: 'Node.js (JavaScript ESM)',
    testCommand: () => 'node --test',
    contractHint:
      'JavaScript(ESM, `.mjs`) 기준: 파일 경로, export 함수 시그니처, 입출력 타입(JSDoc 수준), throw 하는 Error 종류와 메시지.',
    testRules: [
      '- 러너는 `node --test` + `node:assert/strict` 를 사용한다(별도 설치 금지).',
      '- 테스트 파일명은 `*.test.mjs` 로 하고, 구현 모듈은 계약의 경로에서 ESM 으로 import 한다.',
    ],
    testExample: 'csv.test.mjs',
    parseCounts(out) {
      const mp = out.match(/(?:ℹ\s*)?pass (\d+)/);
      const mf = out.match(/(?:ℹ\s*)?fail (\d+)/);
      return { pass: mp ? Number(mp[1]) : null, fail: mf ? Number(mf[1]) : null };
    },
  },
  python: {
    label: 'Python 3 (unittest)',
    testCommand: () => 'python -m unittest discover -s tests -t . -v',
    contractHint:
      'Python 3 기준: 패키지/모듈 경로(저장소 루트 기준, 예: `csvtool/parser.py`), 함수·클래스 시그니처(타입 힌트 포함), 반환형, raise 하는 예외 클래스와 메시지.',
    testRules: [
      '- 러너는 표준 라이브러리 `unittest` 를 사용한다(pytest 등 별도 설치 금지).',
      '- 테스트 파일은 `tests/test_*.py` 에 두고, 빈 `tests/__init__.py` 도 함께 만든다.',
      '- 구현 패키지는 저장소 루트 기준 절대 import 한다(예: `from csvtool.parser import parse`). sys.path 조작 금지.',
    ],
    testExample: 'tests/test_parser.py',
    parseCounts(out) {
      const ran = out.match(/^Ran (\d+) tests?/m);
      if (!ran) return { pass: null, fail: null };
      const total = Number(ran[1]);
      const n = (k) => Number((out.match(new RegExp(`${k}=(\\d+)`)) || [])[1] || 0);
      const fail = n('failures') + n('errors');
      return { pass: Math.max(0, total - fail - n('skipped')), fail };
    },
  },
  'python:pytest': {
    label: 'Python 3 (pytest)',
    testCommand: () => 'python -m pytest -q',
    contractHint: null, // python 과 동일
    testRules: [
      '- 러너는 `pytest` 를 사용한다(플러그인 등 추가 설치 금지).',
      '- 테스트 파일은 `tests/test_*.py` 에 두고, 빈 `tests/__init__.py` 도 함께 만든다.',
      '- 구현 패키지는 저장소 루트 기준 절대 import 한다(예: `from csvtool.parser import parse`). sys.path 조작 금지.',
    ],
    testExample: 'tests/test_parser.py',
    parseCounts(out) {
      const n = (k) => {
        const m = out.match(new RegExp(`(\\d+) ${k}`));
        return m ? Number(m[1]) : null;
      };
      const pass = n('passed');
      const failed = n('failed');
      const errors = n('errors?');
      if (pass == null && failed == null && errors == null) return { pass: null, fail: null };
      return { pass: pass ?? 0, fail: (failed ?? 0) + (errors ?? 0) };
    },
  },
  rust: {
    label: 'Rust (cargo test)',
    testCommand: () => 'cargo test --color never',
    contractHint:
      'Rust 기준: 크레이트 이름(Cargo.toml `package.name`, lib 크레이트), 모듈 경로, `pub fn`/`pub struct` 시그니처(소유권·참조 포함), 반환형, 에러 타입(`Result<T, E>` 의 E 정의와 Display 메시지).',
    testRules: [
      '- 통합 테스트로 `tests/*.rs` 에 작성하고 `cargo test` 로 실행된다(외부 크레이트 추가 금지).',
      '- 계약의 크레이트 이름으로 `use <crate>::...` 한다(크레이트명의 `-` 는 `_`).',
      '- `Cargo.toml` 과 `src/` 는 구현자가 만든다. 테스트 쪽에서 만들지 마라.',
    ],
    testExample: 'tests/parser.rs',
    parseCounts(out) {
      let pass = 0;
      let fail = 0;
      let found = false;
      for (const m of out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)) {
        found = true;
        pass += Number(m[1]);
        fail += Number(m[2]);
      }
      return found ? { pass, fail } : { pass: null, fail: null };
    },
  },
  cpp: {
    label: 'C++17 (CMake + CTest)',
    testCommand() {
      const { cmake, ctest } = findCmake();
      return [
        `${cmake} -S . -B build`,
        `${cmake} --build build --config Debug`,
        `${ctest} --test-dir build -C Debug --output-on-failure`,
      ].join(' && ');
    },
    contractHint:
      'C++17 + CMake 기준: 라이브러리 CMake 타깃 이름, 헤더 경로(include 기준 경로), 네임스페이스, 함수/클래스 시그니처, 반환형, 에러 처리 방식(예외 타입과 what() 메시지, 또는 std::optional/에러코드).',
    testRules: [
      '- 외부 테스트 프레임워크(GoogleTest, Catch2 등) 금지. 표준 라이브러리만 쓰는 자체 미니 하네스로 작성한다.',
      '- 테스트 파일은 `tests/test_*.cpp`. 실행파일은 인자로 케이스 이름을 받아 해당 케이스만 실행하고, 실패 시 stderr 에 이유를 출력하고 1 을 반환한다.',
      '- `tests/CMakeLists.txt` 도 함께 작성한다: 각 파일을 `add_executable` + `target_link_libraries(<계약의 라이브러리 타깃>)` 로 빌드하고, **케이스마다** `add_test(NAME <케이스> COMMAND <실행파일> <케이스>)` 로 등록한다.',
      '- 루트 `CMakeLists.txt`(라이브러리 타깃 정의, `enable_testing()`, `add_subdirectory(tests)`)는 구현자가 만든다. 테스트 쪽에서 만들지 마라.',
    ],
    testExample: 'tests/test_parser.cpp',
    parseCounts(out) {
      const m = out.match(/(\d+)% tests passed, (\d+) tests? failed out of (\d+)/);
      if (!m) return { pass: null, fail: null };
      const fail = Number(m[2]);
      return { pass: Number(m[3]) - fail, fail };
    },
  },
};

// 저장소 내용으로 언어 추정 (language: "auto")
function detectLanguage() {
  const has = (f) => existsSync(resolve(ROOT, f));
  if (has('Cargo.toml')) return 'rust';
  if (has('CMakeLists.txt')) return 'cpp';
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt')) return 'python';
  if (has('package.json')) return 'node';
  return null;
}

let _lang;
function getLang() {
  if (_lang) return _lang;
  let language = CONFIG.language || 'auto';
  if (language === 'auto') {
    const d = detectLanguage();
    if (!d) console.warn('[cca] ⚠ language=auto 인데 언어를 추정할 수 없어 node 로 진행합니다. .cca/config.json 의 language 를 지정하세요.');
    language = d || 'node';
  }
  const key = CONFIG.framework ? `${language}:${CONFIG.framework}` : language;
  const preset = LANG_PRESETS[key];
  if (!preset) {
    console.error(`[cca] 지원하지 않는 언어/프레임워크: ${key} (지원: ${Object.keys(LANG_PRESETS).join(', ')})`);
    process.exit(2);
  }
  const base = LANG_PRESETS[language];
  _lang = {
    key,
    ...preset,
    contractHint: preset.contractHint || base.contractHint,
    testCommand: CONFIG.testCommand || preset.testCommand(),
  };
  return _lang;
}

// PATH 에 cmake 가 없으면 Visual Studio 번들 CMake 를 찾는다.
function findCmake() {
  const onPath = spawnSync(process.platform === 'win32' ? 'where cmake' : 'command -v cmake', {
    shell: true,
    encoding: 'utf8',
  });
  if (onPath.status === 0 && onPath.stdout.trim()) return { cmake: 'cmake', ctest: 'ctest' };
  if (process.platform === 'win32') {
    const vswhere = 'C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe';
    if (existsSync(vswhere)) {
      const r = spawnSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' });
      const vs = (r.stdout || '').trim().split(/\r?\n/)[0];
      const bin = vs && resolve(vs, 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin');
      if (bin && existsSync(resolve(bin, 'cmake.exe')))
        return { cmake: quoteArg(resolve(bin, 'cmake.exe')), ctest: quoteArg(resolve(bin, 'ctest.exe')) };
    }
  }
  console.warn('[cca] ⚠ cmake 를 찾지 못했습니다. PATH 에 추가하거나 config.testCommand 를 지정하세요.');
  return { cmake: 'cmake', ctest: 'ctest' };
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
// shell: true 는 .cmd 셰임(codex 등)용. 실행 파일(agy.exe)은 shell: false 로 직접 실행하면
// cmd.exe 의 8191자 제한·줄바꿈 깨짐 없이 긴 프롬프트를 인자로 넘길 수 있다(CreateProcess 32767자).
// input 을 주면 stdin 으로 전달한다(codex exec '-' 프롬프트).
function run(cmd, args, { capture = false, label, shell = true, input, timeoutMs = EXTERNAL_TIMEOUT_MS } = {}) {
  const start = process.hrtime.bigint();
  const stdin = input != null ? 'pipe' : 'ignore';
  const opts = {
    cwd: ROOT,
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: capture ? [stdin, 'pipe', 'pipe'] : [stdin, 'inherit', 'inherit'],
    shell,
    ...(input != null ? { input } : {}),
  };
  const res = shell ? spawnSync([cmd, ...args.map(quoteArg)].join(' '), opts) : spawnSync(cmd, args, opts);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const notFound = res.error && res.error.code === 'ENOENT';
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  if (notFound) console.error(`[cca] '${cmd}' 실행 파일을 찾을 수 없습니다. PATH/로그인을 확인하세요.`);
  if (timedOut) console.error(`[cca] '${cmd}' 가 ${(timeoutMs / 60000).toFixed(1)}분 타임아웃.`);
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

// ---------- backend adapter ----------
// adapter(req) → { ok, data?, text?, reason?, limitHit?, elapsedMs }
// req: { name, prompt, schema(스키마 파일 경로|null), key, accept(data), effort, label }
//   schema 가 있으면 JSON 결과(data), 없으면 텍스트 결과(text).
// 모든 backend 는 읽기 전용으로 실행한다. 파일 쓰기는 cca 가 결과를 받아 수행한다.
const SEVERITIES = ['critical', 'major', 'minor', 'none'];

// 프로세스 수준 실패 판정(실행 파일 없음·타임아웃·비정상 종료). 정상이면 null.
function processFailure(backend, r) {
  if (r.notFound) return { ok: false, reason: '실행 파일 없음', elapsedMs: r.elapsedMs };
  if (r.timedOut) return { ok: false, reason: '타임아웃', elapsedMs: r.elapsedMs };
  if (r.status !== 0) {
    const limitHit = isLimitHit(r);
    const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 200);
    if (tail) console.error(`[cca] ${backend}: ${tail}`);
    return { ok: false, limitHit, reason: `${limitHit ? '사용량 한도 ' : ''}exit ${r.status}`, elapsedMs: r.elapsedMs };
  }
  return null;
}

// agy: 프롬프트를 인자로 직접 넘긴다. "파일을 읽어라" 간접 지시는 agy(plan 모드)가 셸로 파일을
// 찾다 권한 거부(denied_actions)되고 빈 결과로 끝나는 일이 있다. 한도를 넘는 프롬프트만 파일 지시.
// CreateProcess 한도 32767자에서 다른 인자와 따옴표 이스케이프(\") 증가분 여유를 둔다
const AGY_INLINE_MAX = 24000;

// plan 모드 agy 는 과제를 받으면 저장소부터 살펴보려고 셸을 쓰다 권한 거부되고 빈 응답으로
// 끝나는 일이 있다(plan 작성·테스트 작성에서 관찰). 필요한 정보는 모두 프롬프트에 넣었으니
// 도구를 쓰지 말고 바로 답하라고 모든 agy 프롬프트 앞에 못박는다.
const AGY_PREAMBLE = [
  '[실행 규칙] 이 지시문에 필요한 정보가 모두 들어 있다. 이 지시문 외의 파일을 읽거나',
  '셸·검색·편집 도구를 쓰지 말고, 저장소를 탐색하지 말고, 바로 최종 답을 출력하라.',
  '되묻지 마라. 모호한 부분은 합리적으로 정해서 답에 반영하라.',
  '',
  '',
].join('\n');

function invokeAgy(req) {
  const body = AGY_PREAMBLE + req.prompt;
  const rel = writePrompt(req.name, body);
  const inline = body.length <= AGY_INLINE_MAX;
  if (!inline) console.warn(`[cca] ⚠ 프롬프트가 ${body.length}자라 파일 지시(${rel})로 전달합니다.`);
  const args = (prompt) => ['-p', prompt, '--mode', 'plan', '--effort', mapEffort('agy', req.effort),
    '--output-format', 'json', ...(req.schema ? ['--json-schema', req.schema] : []), '--print-timeout', '5m'];
  let r = run('agy', args(inline ? body : followInstruction(rel)), { capture: true, label: req.label, shell: false });
  // 셸 없이는 .exe 만 찾는다. agy 가 .cmd 셰임으로 설치된 환경이면 셸 + 파일 지시로 대체
  if (r.notFound && process.platform === 'win32') {
    console.warn('[cca] ⚠ agy 실행 파일(.exe)을 찾지 못해 셸 경유(파일 지시)로 재시도합니다.');
    r = run('agy', args(followInstruction(rel)), { capture: true, label: req.label });
  }
  const fail = processFailure('agy', r);
  if (fail) return fail;
  if (req.schema) {
    const p = parseAgy(r.stdout, req.key, req.accept);
    if (p.data) return { ok: true, data: p.data, elapsedMs: r.elapsedMs };
    console.error(`[cca] agy 결과가 비었거나 형식이 다릅니다: ${p.diag}`);
    return { ok: false, reason: `결과 없음 — ${p.diag}`, elapsedMs: r.elapsedMs };
  }
  const outer = tryParse(r.stdout.trim());
  const text = outer && typeof outer.response === 'string' ? outer.response.trim() : '';
  if (text) return { ok: true, text, elapsedMs: r.elapsedMs };
  const diag = agyDiag(outer);
  console.error(`[cca] agy 결과가 비었습니다: ${diag}`);
  return { ok: false, reason: `결과 없음 — ${diag}`, elapsedMs: r.elapsedMs };
}

// codex: 프롬프트를 stdin('-')으로 넘기고, 마지막 메시지를 -o 파일로 받는다.
// JSON task 는 --output-schema 로 강제하되, OpenAI 구조화 출력 규칙에 맞춘 엄격 스키마로 변환해 쓴다.
function invokeCodex(req) {
  writePrompt(req.name, req.prompt);
  const outDir = resolve(AI_DIR, 'out');
  mkdirSync(outDir, { recursive: true });
  const outFile = resolve(outDir, `${req.name}.codex.txt`);
  writeFileSync(outFile, '', 'utf8');
  const schemaArgs = [];
  if (req.schema) {
    const strictPath = resolve(outDir, `${req.name}.codex-schema.json`);
    writeFileSync(strictPath, JSON.stringify(strictSchema(JSON.parse(readSafe(resolve(ROOT, req.schema)))), null, 2), 'utf8');
    schemaArgs.push('--output-schema', relative(ROOT, strictPath).replace(/\\/g, '/'));
  }
  const r = run(
    'codex',
    ['exec', '-c', `model_reasoning_effort=${mapEffort('codex', req.effort)}`, '-s', 'read-only',
      ...schemaArgs, '-o', relative(ROOT, outFile).replace(/\\/g, '/'), '-'],
    { capture: true, label: req.label, input: req.prompt }
  );
  const fail = processFailure('codex', r);
  if (fail) return fail;
  const text = readSafe(outFile).trim();
  if (!text) return { ok: false, reason: '빈 응답', elapsedMs: r.elapsedMs };
  if (!req.schema) return { ok: true, text, elapsedMs: r.elapsedMs };
  const data = extractJson(text, req.key);
  if (data && req.accept(data)) return { ok: true, data, elapsedMs: r.elapsedMs };
  return { ok: false, reason: `결과 형식 불일치 — ${text.slice(0, 160).replace(/\s+/g, ' ')}`, elapsedMs: r.elapsedMs };
}

const ADAPTERS = { agy: invokeAgy, codex: invokeCodex };

// ---------- 사용량 한도 조회 (모델 호출 없음) ----------
// agy: `agy -p /usage --output-format json` (슬래시 명령이라 모델 턴 없이 즉시 응답)
// codex: app-server 의 account/rateLimits/read (.cca/codex-usage.mjs 경유)
// 조회 실패는 null → 확인을 건너뛰고 평소대로 호출한다.
const USAGE_TTL_MS = 5 * 60 * 1000;
const USAGE_TIMEOUT_MS = 30 * 1000;
const USAGE_PROBE_PATH = resolve(AI_DIR, 'usage-probe.json');
const _usage = new Map();

// agy 가 /usage 를 슬래시 명령으로 처리하지 못하는 버전이면 프롬프트로 받아 모델 턴을 쓴다.
// 그런 버전은 기록해 두고 다시 조회하지 않는다(사용량 낭비 방지).
function agyUsageUnsupported(version) {
  return tryParse(readSafe(USAGE_PROBE_PATH) || 'null')?.agyUnsupported === version;
}
function markAgyUsageUnsupported(version) {
  ensureDirs();
  writeFileSync(USAGE_PROBE_PATH, JSON.stringify({ agyUnsupported: version }, null, 2), 'utf8');
}

function queryAgyUsage() {
  const ver = run('agy', ['--version'], { capture: true, shell: false, label: 'agy --version', timeoutMs: USAGE_TIMEOUT_MS });
  const version = (ver.stdout || '').trim() || 'unknown';
  if (ver.notFound || agyUsageUnsupported(version)) return null;
  const r = run('agy', ['-p', '/usage', '--output-format', 'json'], {
    capture: true, shell: false, label: 'agy(usage)', timeoutMs: USAGE_TIMEOUT_MS,
  });
  if (r.status !== 0) return null;
  const json = tryParse(r.stdout.trim());
  if (json && !json.command && Number(json.num_turns) > 0) {
    console.warn(`[cca] ⚠ agy ${version} 은 -p /usage 를 지원하지 않습니다(모델 턴으로 처리됨). 이 버전에서는 사용량 확인을 건너뜁니다.`);
    markAgyUsageUnsupported(version);
    return null;
  }
  return normalizeAgyUsage(json);
}

function queryCodexUsage() {
  const r = run(process.execPath, [resolve(__dirname, 'codex-usage.mjs'), String(USAGE_TIMEOUT_MS - 5000)], {
    capture: true, shell: false, label: 'codex(usage)', timeoutMs: USAGE_TIMEOUT_MS,
  });
  return r.status === 0 ? normalizeCodexUsage(tryParse(r.stdout.trim())) : null;
}

const USAGE_QUERIES = { agy: queryAgyUsage, codex: queryCodexUsage };

function queryUsage(backend, { fresh = false } = {}) {
  const hit = _usage.get(backend);
  if (!fresh && hit && Date.now() - hit.at < USAGE_TTL_MS) return hit.usage;
  let usage = null;
  try {
    usage = USAGE_QUERIES[backend] ? USAGE_QUERIES[backend]() : null;
  } catch {
    usage = null;
  }
  _usage.set(backend, { at: Date.now(), usage });
  return usage;
}

// 호출 전 확인: 한도 근처면 호출하지 않고 실패로 돌려 다음 backend 로 넘긴다.
// 호출 후 확인: 프로세스가 비정상 종료했으면 다시 조회해 한도 때문인지 판정한다.
function invokeWithUsageCheck(b, req) {
  const min = Number(CONFIG.usageMinRemaining);
  const check = CONFIG.usageCheck !== false;
  if (check) {
    const blocked = usageBlocked(queryUsage(b), min);
    if (blocked) {
      console.warn(`[cca] ⚠ ${b} 사용량 한도 근처 — 호출하지 않음: ${blocked}`);
      return { ok: false, limitHit: true, reason: `사용량 사전 확인: ${blocked}`, elapsedMs: 0 };
    }
  }
  const r = ADAPTERS[b](req);
  if (check && needsUsageRecheck(r)) {
    const blocked = usageBlocked(queryUsage(b, { fresh: true }), min);
    if (blocked) return { ...r, limitHit: true, reason: `사용량 한도(${blocked}) — ${r.reason}` };
  }
  return r;
}

// ---------- 역할 라우팅 (.cca/roles.json) ----------
const TASK_NAMES = ['plan', 'write_tests', 'analyze_failure', 'review', 'judge_dispute'];
const DEFAULT_ROLES = {
  roles: {
    pm: { backends: ['codex', 'agy'] },
    tester: { backends: ['agy', 'codex'] },
    debugger: { backends: ['agy', 'codex'] },
    reviewer: { backends: ['agy', 'codex'] },
    judge: { backends: ['agy', 'codex'] },
  },
  tasks: { plan: 'pm', write_tests: 'tester', analyze_failure: 'debugger', review: 'reviewer', judge_dispute: 'judge' },
};

let _roles;
function getRoles() {
  if (_roles) return _roles;
  const p = resolve(__dirname, 'roles.json');
  let cfg = DEFAULT_ROLES;
  if (existsSync(p)) {
    cfg = tryParse(readFileSync(p, 'utf8'));
    if (!cfg) {
      console.error('[cca] .cca/roles.json 파싱 실패.');
      process.exit(2);
    }
  }
  const errors = validateRoles(cfg, { tasks: TASK_NAMES });
  if (errors.length) {
    console.error('[cca] .cca/roles.json 정의 오류:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }
  _roles = cfg;
  return cfg;
}

// task 를 역할의 backend 순서대로 시도한다. 반환: withFallback 결과 + label('agy→codex' 등)
function invokeRole(task, req) {
  const { role, backends } = backendsFor(getRoles(), task);
  const res = withFallback(
    backends,
    (b) => {
      console.log(`[cca] ${task} → ${b} (role=${role}, effort=${mapEffort(b, req.effort)})`);
      return invokeWithUsageCheck(b, { ...req, label: `${b}(${req.name})` });
    },
    { onFallback: (from, to, r) => console.warn(`[cca] ⚠ ${from} 실패(${r.reason}) → ${to} 로 대체`) }
  );
  return { ...res, label: backendLabel(res) };
}

// run 기록용 요약: fallback 이 있었으면 앞 backend 의 실패 사유를 붙인다.
function attemptNote(res) {
  return res.attempts.map((a) => `${a.backend}: ${a.reason}`).join(' / ');
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
    map[rel] = lockHash(f.content);
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
  const testCmd = getLang().testCommand;
  console.log(`[cca] 테스트 실행 [${getLang().key}]: ${testCmd}`);
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

// 러너 요약에서 pass/fail 수 추출(파싱 불가면 null)
function parseCounts(out) {
  return getLang().parseCounts(out);
}

// ---------- task: plan (PM) ----------
// task 함수는 { result, summary?, artifact?, backend?, elapsedMs? } 를 반환한다.
// result 는 워크플로 전이 키다. 실행 자체가 실패하면 'error'.
function taskPlan(requirement) {
  const promptBody = [
    '너는 PM이다. 아래 요구사항을 분석해 Markdown 문서를 작성한다.',
    '',
    '**중요: 파일을 쓰지 말고 문서를 응답으로만 내보내라.** 응답 전체가 그대로 plan 파일로 저장되므로 문서 앞뒤에 설명 문장을 붙이지 마라.',
    '',
    '문서는 **정확히 다음 6개 제목**을 순서대로 포함해야 한다:',
    '- `## 목표`',
    '- `## 작업 목록`  (각 항목은 `- [ ]` 체크박스)',
    '- `## 수용 기준`',
    '- `## 테스트 시나리오`',
    '- `## 위험 요소`',
    '- `## 인터페이스 계약`  (파일명, export 함수 시그니처, 입출력 타입, 에러 형식/메시지 규약을 구체적으로)',
    '',
    `구현 언어: **${getLang().label}**. 인터페이스 계약은 이 언어 기준으로 작성하라 —`,
    getLang().contractHint,
    '',
    '`## 인터페이스 계약` 은 이후 단계에서 테스트를 먼저 작성하는 근거가 되므로,',
    '모호함 없이 파일 경로·함수명·인자·반환형·에러 조건을 못박아라.',
    '',
    '요구사항:',
    requirement,
    '',
  ].join('\n');
  const planFile = CONFIG.planFile || 'docs/plan.md';
  const effort = CONFIG.pmReasoningEffort || 'medium';
  const res = invokeRole('plan', { name: 'pm', prompt: promptBody, schema: null, effort });
  const base = { backend: res.label, elapsedMs: res.elapsedMs, artifact: planFile };
  if (!res.ok) {
    console.error('[cca] PM 단계 실패.');
    return { ...base, result: 'error', summary: attemptNote(res) };
  }
  const abs = resolve(ROOT, planFile);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, res.text + '\n', 'utf8');
  console.log(`[cca] plan 생성 완료: ${planFile}`);
  return { ...base, result: 'ok', ...(res.attempts.length ? { summary: attemptNote(res) } : {}) };
}

// ---------- task: write_tests (테스트 선작성 + 잠금) ----------
function taskWriteTests() {
  ensureDirs();
  const planFile = CONFIG.planFile || 'docs/plan.md';
  const planAbs = resolve(ROOT, planFile);
  if (!existsSync(planAbs)) {
    console.error(`[cca] ${planFile} 가 없습니다. 먼저 pm 을 실행하세요.`);
    return { result: 'error', summary: `${planFile} 없음` };
  }
  const effort = CONFIG.testsEffort || 'high';
  const promptBody = [
    '너는 테스트 작성자다. 아래 계획(plan.md)의 `## 인터페이스 계약` 과 `## 수용 기준`,',
    '`## 테스트 시나리오` 를 근거로 **실행 가능한 테스트 파일**을 작성하라.',
    '',
    '규칙:',
    '- 구현 코드는 아직 존재하지 않는다. 테스트는 인터페이스 계약에 명시된 모듈/함수를 import 해 검증한다.',
    `- 언어/러너: **${getLang().label}**. 실행 명령은 \`${getLang().testCommand}\` 이다.`,
    ...getLang().testRules,
    '- 각 수용 기준/시나리오를 빠짐없이 커버하라.',
    '- 테스트만 작성하라. 구현 파일은 만들지 마라.',
    '- **다른 파일을 열지 마라.** 아래 첨부된 plan 내용만으로 작성하라.',
    '',
    '출력은 요구된 JSON 스키마 `{ files: [{ path, content }] }` 로만 응답하라.',
    `path 는 저장소 루트 기준 상대 경로다(예: \`${getLang().testExample}\`).`,
    '',
    '===== plan.md =====',
    readSafe(planAbs),
  ].join('\n');
  const res = invokeRole('write_tests', {
    name: 'tests',
    prompt: promptBody,
    schema: '.ai/tests-schema.json',
    key: 'files',
    accept: (d) => Array.isArray(d.files) && d.files.length > 0,
    effort,
  });
  const base = { backend: res.label, elapsedMs: res.elapsedMs, artifact: '.ai/test-lock.json' };
  if (!res.ok) return { ...base, result: 'error', summary: attemptNote(res) };
  const parsed = res.data;

  const map = saveFiles(parsed.files);
  if (Object.keys(map).length === 0) {
    console.error('[cca] 저장된 테스트 파일이 없습니다.');
    return { ...base, result: 'error', summary: '저장된 테스트 파일 없음' };
  }
  writeLock(map);
  console.log(`[cca] 테스트 잠금 기록: .ai/test-lock.json (${Object.keys(map).length}개 파일)`);

  // red 확인: 구현이 없으니 전부 실패해야 한다
  console.log('[cca] red 확인을 위해 테스트 1회 실행...');
  const t = runTestsRaw();
  const { pass, fail } = parseCounts(t.out);
  let red;
  if (pass != null) {
    if (pass > 0)
      console.warn(`[cca] ⚠ 경고: 통과하는 테스트가 ${pass}개 있습니다. 테스트는 모두 실패(red)여야 합니다.`);
    if (fail === 0)
      console.warn('[cca] ⚠ 경고: 실패(red)하는 테스트가 없습니다. 테스트가 구현을 제대로 강제하는지 확인하세요.');
    if (pass === 0 && fail != null && fail > 0)
      console.log('[cca] ✅ red 확인: 모든 테스트가 실패 상태입니다.');
    red = `red 확인: pass ${pass} / fail ${fail ?? '?'}`;
  } else if (t.passed) {
    console.warn('[cca] ⚠ 경고: 테스트가 통과했습니다(red 여야 함).');
    red = '⚠ 테스트가 통과함(red 아님)';
  } else {
    console.log('[cca] red 확인: 테스트가 실패 상태입니다(카운트 파싱 불가).');
    red = 'red 확인(카운트 파싱 불가)';
  }
  return { ...base, result: 'ok', summary: `${Object.keys(map).length}개 파일 잠금, ${red}` };
}

// ---------- task: test (잠금 검증 후 실행) ----------
function taskTest() {
  const lock = loadLock();
  if (lock && lock.files) {
    const tampered = [];
    for (const [rel, h] of Object.entries(lock.files)) {
      const cur = lockHash(readSafe(resolve(ROOT, rel)));
      if (cur !== h) tampered.push(rel);
    }
    if (tampered.length) {
      console.error('[cca] ❌ 테스트 변조 감지. 잠금과 다른 테스트 파일:');
      for (const f of tampered) console.error(`  - ${f}`);
      console.error('[cca] 테스트는 직접 수정할 수 없습니다. 변경이 필요하면 `dispute` 로 이의를 제기하세요.');
      return { result: 'tampered', exitCode: 3, summary: `변조: ${tampered.join(', ')}` };
    }
  } else {
    console.warn('[cca] ⚠ 테스트 잠금(.ai/test-lock.json)이 없습니다. 먼저 `tests` 로 생성하세요.');
  }
  const start = process.hrtime.bigint();
  const t = runTestsRaw();
  const { pass, fail } = parseCounts(t.out);
  return {
    result: t.passed ? 'pass' : 'fail',
    exitCode: t.exitCode,
    elapsedMs: Number(process.hrtime.bigint() - start) / 1e6,
    artifact: '.ai/test.log',
    summary: pass != null ? `pass ${pass} / fail ${fail ?? '?'}` : `exit ${t.exitCode}`,
  };
}

// ---------- task: judge_dispute (테스트 이의 판정) ----------
function taskDispute(claim) {
  const lock = loadLock();
  if (!lock || !lock.files) {
    console.error('[cca] 잠긴 테스트가 없습니다. 먼저 `tests` 를 실행하세요.');
    return { result: 'error', summary: '잠긴 테스트 없음' };
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
    `- 수정 테스트도 원래 규칙을 따른다 (${getLang().label}):`,
    ...getLang().testRules.map((r) => '  ' + r),
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
  const res = invokeRole('judge_dispute', {
    name: 'dispute',
    prompt: promptBody,
    schema: '.ai/dispute-schema.json',
    key: 'verdict',
    accept: (d) => d.verdict === 'accept' || d.verdict === 'reject',
    effort,
  });
  const base = { backend: res.label, elapsedMs: res.elapsedMs, artifact: '.ai/dispute.json' };
  if (!res.ok) return { ...base, result: 'error', summary: attemptNote(res) };
  const parsed = res.data;
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
  return { ...base, result: parsed.verdict, summary: parsed.reason ?? null };
}

// ---------- task: analyze_failure / review (디버거·리뷰어) ----------
// 디버그 모드 자동판단: 마지막 테스트가 통과면 review, 아니면 fail
function autoDebugMode() {
  try {
    return JSON.parse(readFileSync(resolve(AI_DIR, 'last-test.json'), 'utf8')).passed === true ? 'review' : 'fail';
  } catch {
    return 'fail';
  }
}

function taskDebug(mode) {
  ensureDirs();
  const effort =
    (mode === 'fail' ? CONFIG.debugEffortFail : CONFIG.debugEffortReview) ||
    (mode === 'fail' ? 'high' : 'low');
  console.log(`[cca] debug 모드: ${mode} (effort=${effort})`);

  const diff = run('git', ['diff'], { capture: true, label: 'git diff' });
  writeFileSync(resolve(AI_DIR, 'changes.diff'), diff.stdout, 'utf8');
  // -uall: 새 디렉터리를 `?? src/` 로 접지 않고 안의 파일을 하나씩 나열한다.
  // core.quotePath=false: 한글 등 비ASCII 경로를 8진 이스케이프 없이 그대로 받는다.
  const status = run('git', ['-c', 'core.quotePath=false', 'status', '--porcelain', '-uall'], {
    capture: true,
    label: 'git status',
  });
  writeFileSync(resolve(AI_DIR, 'changes.status'), status.stdout, 'utf8');
  const untracked = untrackedFiles(status.stdout);

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
      `너는 디버거다. 테스트가 실패했다. (언어/러너: ${getLang().label}, 명령: \`${getLang().testCommand}\`)`,
      '아래에 **필요한 모든 정보(테스트 로그, git diff, git status, 신규 파일 내용)를 직접 첨부**했다.',
      '**추가로 다른 파일을 열지 마라.** 첨부된 내용만으로 실패 원인과 구체적 수정안을 제시하라.',
      '**파일은 수정하지 마라.** 특히 테스트 파일은 잠겨 있으니 구현을 고치는 방향으로 제안하라.',
      '결과는 요구된 JSON 스키마(root_cause / fix_suggestion / files_to_change / severity)로만 응답하라.',
      '',
    ];
  } else {
    header = [
      `너는 코드 리뷰어다. 테스트는 이미 통과했다(로그는 불필요하여 첨부하지 않음). 언어: ${getLang().label}.`,
      '아래에 **git diff, git status, 신규 파일 내용을 직접 첨부**했다.',
      '**추가로 다른 파일을 열지 마라.** 첨부된 변경 코드만 리뷰하라. **파일은 수정하지 마라.**',
      '버그·설계 결함·누락된 처리를 찾아 severity 로 평가하라.',
      '결과는 요구된 JSON 스키마(root_cause / fix_suggestion / files_to_change / severity)로만 응답하라.',
      '(review 모드에서 root_cause 는 핵심 리뷰 요약, fix_suggestion 은 개선 제안으로 사용)',
      '',
    ];
  }
  const res = invokeRole(mode === 'fail' ? 'analyze_failure' : 'review', {
    name: 'debug',
    prompt: [...header, ...attachments].join('\n'),
    schema: '.ai/debug-schema.json',
    key: 'severity',
    // severity 가 없으면 'none' 으로 간주하지 않는다(빈 결과가 리뷰 통과로 처리되는 것을 막음)
    accept: (d) => SEVERITIES.includes(d.severity),
    effort,
  });
  const base = { backend: res.label, elapsedMs: res.elapsedMs, artifact: '.ai/debug.json' };
  if (!res.ok) return { ...base, result: 'error', summary: attemptNote(res) };
  const parsed = res.data;
  writeFileSync(resolve(AI_DIR, 'debug.json'), JSON.stringify(parsed, null, 2), 'utf8');

  const severity = parsed.severity;
  console.log('\n===== 디버거 결과 =====');
  console.log(`[원인/요약] ${parsed.root_cause ?? '(없음)'}`);
  console.log(`[수정/제안] ${parsed.fix_suggestion ?? '(없음)'}`);
  if (Array.isArray(parsed.files_to_change) && parsed.files_to_change.length)
    console.log(`[대상 파일] ${parsed.files_to_change.join(', ')}`);
  console.log('=======================\n');
  console.log(`SEVERITY: ${severity}`);
  return { ...base, result: severity, summary: parsed.root_cause ?? null };
}

// ---------- workflow run (run / next / status / abort) ----------
const RUN_PATH = resolve(AI_DIR, 'run.json');
const WORKFLOWS_DIR = resolve(__dirname, 'workflows');
const ACTIVE = new Set(['running', 'waiting_coder', 'failed']);

// workflow 의 agent step 이 부를 수 있는 task
const TASKS = {
  plan: (step, rs) => taskPlan(rs.requirement),
  write_tests: () => taskWriteTests(),
  analyze_failure: () => taskDebug('fail'),
  review: () => taskDebug('review'),
};
const EXECUTORS = {
  agent: (step, rs) => TASKS[step.task](step, rs),
  test: () => taskTest(),
};

function listWorkflows() {
  try {
    return readdirSync(WORKFLOWS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

function loadWorkflow(name) {
  const p = resolve(WORKFLOWS_DIR, `${name}.json`);
  if (!/^[\w-]+$/.test(name || '') || !existsSync(p)) {
    console.error(`[cca] workflow '${name}' 가 없습니다. (사용 가능: ${listWorkflows().join(', ') || '없음'})`);
    return null;
  }
  let wf;
  try {
    wf = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[cca] workflow '${name}' 파싱 실패: ${e.message}`);
    return null;
  }
  const errors = validateWorkflow(wf, { tasks: Object.keys(TASKS) });
  if (errors.length) {
    console.error(`[cca] workflow '${name}' 정의 오류:`);
    for (const e of errors) console.error(`  - ${e}`);
    return null;
  }
  return wf;
}

function loadRun() {
  try {
    return JSON.parse(readFileSync(RUN_PATH, 'utf8'));
  } catch {
    return null;
  }
}
function saveRun(rs) {
  ensureDirs();
  writeFileSync(RUN_PATH, JSON.stringify(rs, null, 2), 'utf8');
}

function fmtMs(ms) {
  if (ms == null) return '-';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

// Claude 가 읽는 결과 블록. ACTION 줄로 다음 행동을 지시한다.
function reportRun(rs, wf) {
  const step = wf && findStep(wf, rs.current);
  const lastCoder = rs.history.map((h) => h.kind).lastIndexOf('coder');
  const recent = rs.history.slice(lastCoder + 1);
  const lines = ['', '===== cca run =====', `RUN: ${rs.id} (workflow: ${rs.workflow})`, `STATUS: ${rs.status}`];
  for (const h of recent) {
    const tag = h.task ? `${h.step}(${h.task}${h.backend ? `@${h.backend}` : ''})` : h.step;
    const extra = [h.summary, h.artifact && `[${h.artifact}]`].filter(Boolean).join(' ');
    lines.push(`RESULT: ${tag} → ${h.result}${extra ? ` — ${extra}` : ''}`);
  }
  if (rs.status === 'waiting_coder') {
    lines.push(`STEP: ${rs.current}`, 'ACTION: implement');
    if (step && step.instruction) lines.push(`INSTRUCTION: ${step.instruction}`);
    lines.push('NEXT: 작업을 마치면 `node .cca/cca.mjs next` (테스트가 틀렸다면 `dispute "<이의>"`)');
  } else if (rs.status === 'done') {
    lines.push('ACTION: commit', `ELAPSED: ${fmtMs(new Date(rs.endedAt) - new Date(rs.startedAt))}`);
  } else if (rs.status === 'escalated') {
    lines.push('ACTION: report', `REASON: ${rs.note}`);
  } else if (rs.status === 'failed') {
    lines.push(`STEP: ${rs.current}`, 'ACTION: retry', `REASON: ${rs.note}`);
    lines.push('NEXT: 원인을 해결한 뒤 `node .cca/cca.mjs next` 로 같은 step 재시도, 또는 `abort`');
  } else if (rs.status === 'aborted') {
    lines.push('ACTION: none');
  }
  lines.push('===================');
  console.log(lines.join('\n'));
}

function exitCodeOf(rs) {
  return { waiting_coder: 0, done: 0, aborted: 0, escalated: 4, failed: 1 }[rs.status] ?? 1;
}

function driveAndReport(rs, wf) {
  drive(rs, wf, { executors: EXECUTORS, config: CONFIG, save: saveRun });
  reportRun(rs, wf);
  return exitCodeOf(rs);
}

function cmdRun(args) {
  const i = args.indexOf('--reason');
  const reason = i >= 0 ? args[i + 1] ?? null : null;
  const pos = i >= 0 ? [...args.slice(0, i), ...args.slice(i + 2)] : args;
  const [flow, ...reqParts] = pos;
  const requirement = reqParts.join(' ').trim();
  if (!flow || !requirement) {
    console.error('[cca] 사용법: node .cca/cca.mjs run <workflow> "<요구사항>" [--reason "<선택 근거>"]');
    console.error(`[cca] 사용 가능한 workflow: ${listWorkflows().join(', ') || '없음'}`);
    return 2;
  }
  const prev = loadRun();
  if (prev && ACTIVE.has(prev.status)) {
    console.error(`[cca] 진행 중인 run 이 있습니다: ${prev.id} (status=${prev.status}, step=${prev.current}).`);
    console.error('[cca] 이어서 하려면 `next`, 버리려면 `abort` 후 다시 실행하세요.');
    return 2;
  }
  const wf = loadWorkflow(flow);
  if (!wf) return 2;
  const rs = createRun({ workflow: wf, requirement, reason });
  saveRun(rs);
  console.log(`[cca] run 시작: ${rs.id}`);
  return driveAndReport(rs, wf);
}

function cmdNext() {
  const rs = loadRun();
  if (!rs) {
    console.error('[cca] run 이 없습니다. `run <workflow> "<요구사항>"` 으로 시작하세요.');
    return 2;
  }
  const wf = loadWorkflow(rs.workflow);
  if (!wf) return 2;
  if (rs.status === 'waiting_coder') completeCoder(rs, wf);
  else if (!ACTIVE.has(rs.status)) {
    console.log(`[cca] run 이 이미 끝났습니다 (status=${rs.status}).`);
    reportRun(rs, wf);
    return exitCodeOf(rs);
  }
  return driveAndReport(rs, wf);
}

function cmdStatus() {
  const rs = loadRun();
  if (!rs) {
    console.log('[cca] run 이 없습니다.');
    return 0;
  }
  console.log(`요구사항: ${rs.requirement}`);
  if (rs.reason) console.log(`선택 근거: ${rs.reason}`);
  console.log(`시작: ${rs.startedAt}${rs.endedAt ? `  종료: ${rs.endedAt}` : ''}`);
  console.log('\n기록:');
  for (const h of rs.history) {
    const tag = h.task ? `${h.step}(${h.task}${h.backend ? `@${h.backend}` : ''})` : h.step;
    console.log(`  ${tag.padEnd(28)} ${String(h.result).padEnd(9)} ${fmtMs(h.elapsedMs).padStart(7)}  ${h.summary ?? ''}`);
  }
  if (rs.disputes.length) {
    console.log('\ndispute:');
    for (const d of rs.disputes) console.log(`  ${d.step}: ${d.verdict} — ${d.reason ?? ''}`);
  }
  reportRun(rs, loadWorkflow(rs.workflow));
  return 0;
}

function cmdAbort() {
  const rs = loadRun();
  if (!rs || !ACTIVE.has(rs.status)) {
    console.log('[cca] 진행 중인 run 이 없습니다.');
    return 0;
  }
  rs.status = 'aborted';
  rs.endedAt = new Date().toISOString();
  saveRun(rs);
  console.log(`[cca] run 중단: ${rs.id}`);
  return 0;
}

// ---------- 단일 명령 (수동 사용) ----------
function cmdPm(requirement) {
  if (!requirement) {
    console.error('[cca] 사용법: node .cca/cca.mjs pm "<요구사항>"');
    return 2;
  }
  return taskPlan(requirement).result === 'ok' ? 0 : 1;
}

function cmdTests() {
  return taskWriteTests().result === 'ok' ? 0 : 1;
}

function cmdTest() {
  return taskTest().exitCode;
}

function cmdDebug(modeArg) {
  const mode = modeArg === 'fail' || modeArg === 'review' ? modeArg : autoDebugMode();
  return taskDebug(mode).result === 'error' ? 1 : 0;
}

// 진행 중인 run 의 coder step 에서 호출되면 결과를 run 에 기록한다.
function cmdDispute(claim) {
  if (!claim) {
    console.error('[cca] 사용법: node .cca/cca.mjs dispute "<이의 내용 (plan 조항 인용 필수)>"');
    return 2;
  }
  const r = taskDispute(claim);
  if (r.result === 'error') return 1;
  const rs = loadRun();
  if (rs && rs.status === 'waiting_coder') {
    const rejects = recordDispute(rs, { verdict: r.result, reason: r.summary }, { maxRejects: CONFIG.maxDisputeRejects });
    saveRun(rs);
    if (rs.status === 'escalated') {
      reportRun(rs, loadWorkflow(rs.workflow));
      return exitCodeOf(rs);
    }
    if (r.result === 'reject') console.log(`[cca] 이 run 의 dispute 기각 ${rejects}/${CONFIG.maxDisputeRejects}회`);
  }
  return 0;
}

// ---------- main ----------
function usage() {
  console.log(`cca-workflow CLI
워크플로:
  node .cca/cca.mjs run <workflow> "<요구사항>" [--reason "..."]
                                            run 시작. 자동 step 을 진행하고 Claude 차례(ACTION)에서 멈춤
  node .cca/cca.mjs next                    Claude 작업 완료 → 다음 step 진행 (실패한 step 재시도도 이것)
  node .cca/cca.mjs status                  현재 run 기록과 다음 행동
  node .cca/cca.mjs abort                   현재 run 중단
  사용 가능한 workflow: ${listWorkflows().join(', ') || '없음'}

단일 명령:
  node .cca/cca.mjs pm "<요구사항>"        PM 역할로 docs/plan.md 생성
  node .cca/cca.mjs tests                   plan 기반 테스트 선작성 + 잠금 + red 확인
  node .cca/cca.mjs test                    잠금 검증 후 테스트 실행
  node .cca/cca.mjs debug [fail|review]     디버거 실행 (모드 생략 시 자동판단)
  node .cca/cca.mjs dispute "<이의 내용>"   테스트 이의 판정(accept 시 교체)
  node .cca/cca.mjs lang                    적용될 언어 프리셋과 테스트 명령 출력
  node .cca/cca.mjs roles                   task → 역할 → backend 순서(.cca/roles.json) 출력
  node .cca/cca.mjs usage                   backend 별 사용량 한도 잔량(모델 호출 없음)`);
}

const [sub, ...rest] = process.argv.slice(2);
let code = 0;
switch (sub) {
  case 'run':
    code = cmdRun(rest);
    break;
  case 'next':
    code = cmdNext();
    break;
  case 'status':
    code = cmdStatus();
    break;
  case 'abort':
    code = cmdAbort();
    break;
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
  case 'usage': {
    const min = Number(CONFIG.usageMinRemaining);
    for (const b of Object.keys(USAGE_QUERIES)) {
      const u = queryUsage(b, { fresh: true });
      if (!u) {
        console.log(`${b.padEnd(6)} 조회 실패(미설치·미지원·로그인 필요)`);
        continue;
      }
      const wins = u.windows.map((w) => `${w.window} ${Math.round(w.remaining * 100)}% 남음${w.resetAt ? ` (초기화 ${w.resetAt})` : ''}`);
      const blocked = usageBlocked(u, min);
      console.log(`${b.padEnd(6)} [${u.scope}] ${wins.join(', ')}${u.reached ? ` 도달: ${u.reached}` : ''}${blocked ? ' → 건너뜀' : ''}`);
    }
    console.log(`기준: 남은 비율 ${Math.round(min * 100)}% 이하면 건너뜀 (config.usageMinRemaining)`);
    break;
  }
  case 'roles': {
    const cfg = getRoles();
    for (const t of TASK_NAMES) {
      const { role, backends } = backendsFor(cfg, t);
      console.log(`${t.padEnd(16)} ${role.padEnd(10)} ${backends.join(' → ')}`);
    }
    break;
  }
  case 'lang':
    console.log(`language: ${getLang().key} (${getLang().label})`);
    console.log(`testCommand: ${getLang().testCommand}`);
    break;
  default:
    usage();
    code = sub ? 2 : 0;
}
process.exit(code);
