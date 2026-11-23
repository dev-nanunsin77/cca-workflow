// 역할 → 백엔드 라우팅 (순수 로직, 외부 CLI·파일 I/O 없음)
// 실제 호출은 cca.mjs 의 adapter 가 하고, 여기서는 순서·fallback·판정만 다룬다.

export const KNOWN_BACKENDS = ['codex', 'agy'];

// roles.json 검증. 문제 목록(빈 배열이면 정상).
export function validateRoles(cfg, { tasks = [] } = {}) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return ['roles.json 이 객체가 아닙니다.'];
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(cfg.roles)) return ['roles 가 객체가 아닙니다.'];
  if (!isObj(cfg.tasks)) return ['tasks 가 객체가 아닙니다.'];
  const roles = cfg.roles;
  for (const [role, def] of Object.entries(roles)) {
    const list = def && def.backends;
    if (!Array.isArray(list) || list.length === 0) errors.push(`role '${role}': backends 가 비어 있습니다.`);
    else for (const b of list) if (!KNOWN_BACKENDS.includes(b)) errors.push(`role '${role}': 알 수 없는 backend '${b}'`);
  }
  for (const t of tasks) {
    const role = Object.hasOwn(cfg.tasks, t) ? cfg.tasks[t] : null;
    if (!role) errors.push(`task '${t}' 에 role 이 지정되지 않았습니다.`);
    else if (!Object.hasOwn(roles, role)) errors.push(`task '${t}': 없는 role '${role}'`);
  }
  return errors;
}

export function backendsFor(cfg, task) {
  const role = cfg.tasks[task];
  return { role, backends: cfg.roles[role].backends };
}

// 앞 backend 부터 시도하고, 실패하면 다음으로 넘긴다.
// invoke(backend) → { ok, data?, text?, reason?, limitHit?, elapsedMs? }
// 반환: 성공한 결과 + attempts(실패 기록) + 총 소요 시간. 모두 실패하면 ok=false.
export function withFallback(backends, invoke, { onFallback = () => {} } = {}) {
  const attempts = [];
  let elapsedMs = 0;
  for (let i = 0; i < backends.length; i++) {
    const b = backends[i];
    let r;
    try {
      r = invoke(b) || { ok: false, reason: '결과 없음' };
    } catch (e) {
      // adapter 내부 예외(스키마 파일 파싱 실패 등)도 그 backend 의 실패로 보고 다음으로 넘긴다
      r = { ok: false, reason: `예외: ${e && e.message ? e.message : e}` };
    }
    elapsedMs += r.elapsedMs || 0;
    if (r.ok) return { ...r, backend: b, attempts, elapsedMs };
    attempts.push({ backend: b, reason: r.reason || '실패', limitHit: !!r.limitHit });
    if (i + 1 < backends.length) onFallback(b, backends[i + 1], r);
  }
  return { ok: false, backend: backends[backends.length - 1], attempts, elapsedMs };
}

// 기록용 backend 표기: 'agy' 또는 fallback 이 있었으면 'agy→codex'
export function backendLabel(res) {
  return [...res.attempts.map((a) => a.backend), res.ok ? res.backend : null].filter(Boolean).join('→');
}

// 사용량 한도 응답 추정. CLI 별 실제 형태는 아직 실측하지 못해 일반적인 문구로 판정한다.
// 결과 내용(생성된 코드 등)에 우연히 들어간 단어로 오판하지 않도록, 실패한 실행에만 적용한다.
const LIMIT_RE = /usage limit|rate limit|rate_limit|quota|resource[_ ]exhausted|too many requests|\b429\b|limit reached|credits? (?:exhausted|depleted)|out of credits/i;
export function isLimitHit({ status, stdout, stderr }) {
  if (status === 0) return false;
  return LIMIT_RE.test(`${stderr || ''}\n${(stdout || '').slice(-4000)}`);
}

// backend 마다 받는 effort 값이 다르다.
//   codex model_reasoning_effort: minimal | low | medium | high | xhigh
//   agy --effort: low | medium | high | xhigh | max
const EFFORTS = {
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  agy: ['low', 'medium', 'high', 'xhigh', 'max'],
};
export function mapEffort(backend, effort) {
  const allowed = EFFORTS[backend];
  if (!allowed || allowed.includes(effort)) return effort;
  if (effort === 'max') return allowed[allowed.length - 1];
  if (effort === 'minimal') return allowed[0];
  return 'medium';
}

// OpenAI 구조화 출력(codex --output-schema)용 엄격 스키마로 변환:
// 모든 object 에 additionalProperties:false, 모든 속성을 required 로.
// 원래 선택이던 속성은 null 을 허용해 "없음" 을 표현하게 한다.
export function strictSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(strictSchema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k] = k === 'properties' ? v : strictSchema(v);
  if (schema.type === 'object' && schema.properties) {
    const required = new Set(schema.required || []);
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      const s = strictSchema(v);
      out.properties[k] = required.has(k) ? s : nullable(s);
    }
    out.required = Object.keys(schema.properties);
    out.additionalProperties = false;
  }
  return out;
}
function nullable(s) {
  if (typeof s.type === 'string') return { ...s, type: [s.type, 'null'], ...(s.enum ? { enum: [...s.enum, null] } : {}) };
  return { anyOf: [s, { type: 'null' }] };
}
