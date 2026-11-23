// agy 출력 해석 단위 테스트. 입력은 실제로 관찰된 agy 1.5.14 출력 형태를 줄인 것.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgy, untrackedFiles } from '../parse.mjs';

const FILES_SCHEMA = {
  type: 'object',
  properties: { files: { type: 'array', items: { type: 'object' } } },
  required: ['files'],
};
const SEV_SCHEMA = {
  type: 'object',
  properties: { severity: { type: 'string', enum: ['critical', 'major', 'minor', 'none'] } },
  required: ['severity'],
};
const hasFiles = (d) => Array.isArray(d.files) && d.files.length > 0;
const hasSeverity = (d) => ['critical', 'major', 'minor', 'none'].includes(d.severity);

const outer = (extra) => JSON.stringify({ conversation_id: 'c1', status: 'SUCCESS', num_turns: 1, ...extra });

test('정상: structured_output 에서 결과를 읽는다', () => {
  const out = outer({
    response: '{"files":[{"path":"tests/parse.rs","content":"x"}]}',
    structured_output: { files: [{ path: 'tests/parse.rs', content: 'x' }] },
    json_schema: FILES_SCHEMA,
  });
  const p = parseAgy(out, 'files', hasFiles);
  assert.deepEqual(p.data.files, [{ path: 'tests/parse.rs', content: 'x' }]);
});

test('권한 거부 후 빈 응답: 실패 + 진단에 거부된 도구 표시', () => {
  const out = outer({
    response: '',
    json_schema: FILES_SCHEMA,
    denied_actions: [{ action: 'command', display_name: 'Bash' }],
  });
  const p = parseAgy(out, 'files', hasFiles);
  assert.equal(p.data, null);
  assert.match(p.diag, /권한 거부: Bash/);
  assert.match(p.diag, /빈 응답/);
});

test('json_schema 의 properties 를 결과로 오인하지 않는다', () => {
  // structured_output 이 없을 때 외곽 전체를 뒤지면 json_schema.properties.severity 가 잡힌다
  const out = outer({ response: '', json_schema: SEV_SCHEMA });
  const p = parseAgy(out, 'severity', hasSeverity);
  assert.equal(p.data, null);
});

test('plan 모드가 되묻고 빈 결과(files: [])를 내면 실패로 본다', () => {
  const out = outer({
    response: 'What would you like to plan for `cca-workflow`?\n{"files":[]}\n',
    num_turns: 2,
    structured_output: { files: [] },
    json_schema: FILES_SCHEMA,
  });
  const p = parseAgy(out, 'files', hasFiles);
  assert.equal(p.data, null);
  assert.match(p.diag, /What would you like to plan/);
});

test('structured_output 이 없으면 response 문자열 안의 JSON 을 쓴다', () => {
  const out = outer({
    response: '분석 결과:\n{"root_cause":"r","fix_suggestion":"f","severity":"major"}',
    json_schema: SEV_SCHEMA,
  });
  const p = parseAgy(out, 'severity', hasSeverity);
  assert.equal(p.data.severity, 'major');
});

test('severity 가 enum 밖이면 실패(빈 결과를 none 으로 통과시키지 않음)', () => {
  const out = outer({ structured_output: { root_cause: '', severity: '' }, json_schema: SEV_SCHEMA });
  assert.equal(parseAgy(out, 'severity', hasSeverity).data, null);
});

test('외곽 래퍼 없이 결과 JSON 만 온 경우도 처리한다', () => {
  const p = parseAgy('{"verdict":"reject","reason":"계약대로임"}', 'verdict', (d) => d.verdict === 'reject');
  assert.equal(p.data.reason, '계약대로임');
});

test('JSON 이 아니면 실패', () => {
  const p = parseAgy('Error: something', 'files', hasFiles);
  assert.equal(p.data, null);
});

test('untrackedFiles: -uall 출력에서 새 디렉터리 안 파일을 모두 고른다', () => {
  const out = [
    ' M .cca/config.json',
    ' M docs/plan.md',
    '?? Cargo.lock',
    '?? Cargo.toml',
    '?? src/lib.rs',
    '?? tests/parse.rs',
    '?? .ai/changes.diff',
    '?? .ai/prompts/debug.md',
    '',
  ].join('\r\n');
  assert.deepEqual(untrackedFiles(out), ['Cargo.lock', 'Cargo.toml', 'src/lib.rs', 'tests/parse.rs']);
});

test('untrackedFiles: 디렉터리 항목은 빼고, 따옴표 경로는 벗긴다', () => {
  const out = '?? src/\n?? "my file.rs"\n?? 한글/파일.rs\n';
  assert.deepEqual(untrackedFiles(out), ['my file.rs', '한글/파일.rs']);
});
