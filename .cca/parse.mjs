// agy 출력 해석 (순수 함수, 외부 CLI·파일 I/O 없음)

// agy json 출력 해석: structured_output 우선, 없으면 response 문자열에서 추출.
// 외곽 JSON 의 json_schema(스키마 정의)를 결과로 오인하지 않도록 그 필드는 보지 않는다.
// accept(data) 가 false 면 실패로 보고, 원인 파악용 진단(denied_actions·response)을 붙인다.
export function parseAgy(stdout, key, accept) {
  const outer = tryParse((stdout || '').trim());
  let data = null;
  if (outer && typeof outer === 'object' && 'conversation_id' in outer) {
    if (outer.structured_output) data = findWithKey(outer.structured_output, key);
    if (!data && typeof outer.response === 'string') data = extractJson(outer.response, key);
  } else {
    data = extractJson(stdout, key);
  }
  if (data && accept(data)) return { data };
  const diag = [];
  const denied = outer && Array.isArray(outer.denied_actions) ? outer.denied_actions : [];
  if (denied.length) diag.push(`권한 거부: ${denied.map((d) => d.display_name || d.action).join(', ')}`);
  const resp = outer && typeof outer.response === 'string' ? outer.response.trim() : '';
  diag.push(resp ? `응답: ${resp.slice(0, 160).replace(/\s+/g, ' ')}` : '빈 응답');
  return { data: null, diag: diag.join(' / ') };
}

// 텍스트에서 특정 key 를 가진 객체를 견고하게 추출
export function extractJson(text, key) {
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

export function findWithKey(obj, key) {
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

export function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
