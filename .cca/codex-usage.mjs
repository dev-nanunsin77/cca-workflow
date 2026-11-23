#!/usr/bin/env node
// codex 사용량 한도 조회 (모델 호출 없음). cca.mjs 가 spawnSync 로 부른다.
// codex app-server(stdio JSON-RPC)에 initialize → account/rateLimits/read 만 보내고,
// 결과(result)를 JSON 한 줄로 출력한다. 실패·타임아웃이면 exit 1.
//
// app-server 는 stdin 이 닫히면 진행 중 요청에 답하기 전에 끝나므로, 응답을 받을 때까지
// stdin 을 열어 두어야 한다(그래서 별도 비동기 스크립트).
// 주의: 같은 프로토콜의 account/rateLimitResetCredit/consume(무료 한도 초기화 크레딧 소비)은
// 절대 호출하지 않는다. 이 스크립트는 조회 메서드만 쓴다.
import { spawn, spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';

const TIMEOUT_MS = Number(process.argv[2]) || 20000;
// Windows 는 codex 가 .cmd 셰임이라 셸이 필요하다(인자 없는 고정 명령 문자열로 넘긴다)
const child =
  process.platform === 'win32'
    ? spawn('codex app-server', { shell: true, stdio: ['pipe', 'pipe', 'ignore'] })
    : spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
child.stdin.on('error', () => {});
const done = (code, out) => {
  clearTimeout(timer);
  // process.exit 직전이라 비동기 write 는 파이프에서 유실될 수 있어 동기 출력
  if (out) writeSync(1, out + '\n');
  // stdin 을 닫으면 app-server 가 스스로 끝난다. Windows 는 cmd.exe 경유라 kill() 이
  // cmd 만 죽이고 codex 가 남을 수 있어 프로세스 트리째 종료한다.
  child.stdin.end();
  if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
  process.exit(code);
};
const timer = setTimeout(() => done(1), TIMEOUT_MS);

let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id === 1) {
      if (m.error) return done(1);
      send({ method: 'initialized' });
      send({ id: 2, method: 'account/rateLimits/read', params: null });
    } else if (m.id === 2) {
      return m.result ? done(0, JSON.stringify(m.result)) : done(1);
    }
  }
});
child.on('error', () => done(1));
child.on('close', () => done(1)); // stdout 을 다 읽은 뒤 발생(exit 는 그 전에 올 수 있음)
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cca', version: '0.2.0' } } });
