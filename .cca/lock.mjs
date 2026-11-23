// 테스트 잠금 해시 (순수 함수)
import { createHash } from 'node:crypto';

// 줄바꿈을 LF 로 통일한 뒤 해시한다. git 의 core.autocrlf 등으로 체크아웃 시
// LF ↔ CRLF 가 바뀌어도 내용이 같으면 같은 해시가 나와야 '테스트 변조' 오판이 없다.
export function lockHash(content) {
  return createHash('sha256').update(String(content).replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}
