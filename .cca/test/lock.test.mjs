// 테스트 잠금 해시 단위 테스트
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockHash } from '../lock.mjs';

test('LF 와 CRLF 는 같은 해시', () => {
  assert.equal(lockHash('a\nb\n'), lockHash('a\r\nb\r\n'));
});

test('내용이 다르면 다른 해시', () => {
  assert.notEqual(lockHash('assert_eq!(1, 1);\n'), lockHash('assert_eq!(1, 2);\n'));
});

test('단독 CR 은 통일하지 않는다(내용 변경으로 본다)', () => {
  assert.notEqual(lockHash('a\rb'), lockHash('a\nb'));
});

test('LF 내용의 해시는 정규화 이전 방식(sha256 원문)과 같다 — 기존 잠금 호환', async () => {
  const { createHash } = await import('node:crypto');
  const raw = 'fn t() {}\n';
  assert.equal(lockHash(raw), createHash('sha256').update(raw, 'utf8').digest('hex'));
});
