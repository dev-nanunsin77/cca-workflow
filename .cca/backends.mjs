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

// ---------- 사용량 한도 조회 결과 해석 ----------
// 두 backend 의 조회 결과를 같은 형태로 맞춘다:
//   { windows: [{ window: '5h'|'weekly'|..., remaining: 0~1, resetAt: ISO|null }], reached: string|null, scope }
// 해석할 수 없으면 null (조회 실패와 같게 취급해 확인을 건너뛴다).

// agy `-p /usage --output-format json`. 모델 그룹별 한도 중 Gemini 그룹을 기준으로 본다
// (agy 기본 모델 그룹. 다른 그룹 모델을 쓰도록 설정했다면 판정이 실제와 다를 수 있다).
export function normalizeAgyUsage(json) {
  const groups = json && json.command && json.command.data && json.command.data.groups;
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const g = groups.find((x) => x.name === 'Gemini Models') || groups.find((x) => /gemini/i.test(x.name)) || groups[0];
  const windows = (g.buckets || [])
    .filter((b) => typeof b.remaining_fraction === 'number')
    .map((b) => ({ window: b.window || b.id, remaining: b.remaining_fraction, resetAt: b.reset_time || null }));
  if (windows.length === 0) return null;
  return { windows, reached: null, scope: g.name };
}

// codex app-server `account/rateLimits/read` 의 result.
export function normalizeCodexUsage(result) {
  const rl = result && result.rateLimits;
  if (!rl) return null;
  const win = (w, fallback) =>
    w && typeof w.usedPercent === 'number'
      ? {
          window:
            w.windowDurationMins === 300 ? '5h'
            : w.windowDurationMins === 10080 ? 'weekly'
            : w.windowDurationMins != null ? `${w.windowDurationMins}m`
            : fallback,
          remaining: Math.max(0, 1 - w.usedPercent / 100),
          resetAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
        }
      : null;
  const windows = [win(rl.primary, 'primary'), win(rl.secondary, 'secondary')].filter(Boolean);
  const reached =
    rl.rateLimitReachedType || (rl.spendControlReached ? 'spend_control_reached' : null) ||
    (result.ordinaryUsageAllowed === false ? 'ordinary_usage_not_allowed' : null);
  if (windows.length === 0 && !reached) return null;
  return { windows, reached, scope: rl.limitId || 'codex' };
}

// adapter 실패 중 '프로세스 비정상 종료'만 호출 후 한도 재확인 대상이다(빈 결과·형식 불일치는 제외).
export function needsUsageRecheck(r) {
  return !!r && !r.ok && !r.limitHit && /exit \d+/.test(r.reason || '');
}

// 한도 도달(또는 남은 비율이 minRemaining 이하)이면 사유 문자열, 아니면 null.
export function usageBlocked(usage, minRemaining = 0.05) {
  if (!usage) return null;
  if (usage.reached) return `한도 도달(${usage.reached})`;
  const low = usage.windows.filter((w) => w.remaining <= minRemaining);
  if (low.length === 0) return null;
  return low
    .map((w) => `${w.window} 남은 ${Math.round(w.remaining * 100)}%${w.resetAt ? `, 초기화 ${w.resetAt}` : ''}`)
    .join(' / ');
}
