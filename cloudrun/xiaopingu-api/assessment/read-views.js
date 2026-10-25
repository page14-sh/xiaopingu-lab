const { SCALE_CODES, RISK_SCALE, SCALES: S, SCORE_FIELDS, basisReference } = require('./model');
const { deny } = require('./authorization');
const { validateOutput } = require('./llm-contract');

const COUNSELOR_CARDS = Object.freeze([S.feel, S.pro]);
const VISITOR_CARDS = Object.freeze(SCALE_CODES.filter((code) => code !== S.pro));
const numbered = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
const ANSWERS = Object.freeze({
  [RISK_SCALE]: ['k1'],
  [S.baseline]: [...numbered('s', 7), ...numbered('b', 3), 'r1', 'r2', 'd1'],
  [S.state]: numbered('s', 10), [S.feel]: numbered('f', 4), [S.pro]: numbered('p', 6),
  [S.end]: numbered('e', 6), [S.evaluation]: [...numbered('v', 3), 'o1'], [S.follow]: numbered('u', 6)
});
const DIMENSIONS = Object.freeze(['ORS', '联盟', '稳定度', '目标进展']);
const BANNED_TEXT = /恶化|病情|严重|抑郁|焦虑症/;

function professional(role) { if (!['counselor', 'admin'].includes(role)) deny(); }
function visibleCard(role, code) {
  if (role === 'admin') return SCALE_CODES.includes(code);
  if (role === 'counselor') return COUNSELOR_CARDS.includes(code);
  if (role === 'visitor') return VISITOR_CARDS.includes(code);
  return false;
}
function text(value, max = 128) { return typeof value === 'string' && value.length <= max ? value : null; }
function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function scores(row, allowed) {
  return Object.fromEntries(allowed.map((key) => [key, number(row?.[key])]));
}

// Positive field lists only: new storage fields never automatically become API fields.
function eventView(event, role) {
  if (!visibleCard(role, event.scale_code)) deny();
  const view = {
    id: text(event.event_id), scale_code: event.scale_code, session_no: number(event.session_no),
    follow_round: ['', '1m', '3m'].includes(event.follow_round) ? event.follow_round : '',
    status: ['started', 'submitted', 'rejected', 'abandoned'].includes(event.status) ? event.status : null,
    created_at: text(event.created_at), submitted_at: text(event.submitted_at)
  };
  if (role === 'visitor') return view;
  view.basis_ref = referenceView(basisReference(event));
  if (event.status === 'submitted') {
    Object.assign(view, scores(event.scores, role === 'admin' ? SCORE_FIELDS : ['total', 'pct']));
  }
  // Counselor M2/M3 answers are numeric only. Free text is explicitly admin-only.
  view.raw_answers = Object.fromEntries((ANSWERS[event.scale_code] || []).flatMap((key) => {
    const value = event.raw_answers?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return [[key, value]];
    if (key === 'o1' && role === 'admin' && typeof value === 'string') return [[key, value.slice(0, 2000)]];
    return [];
  }));
  return view;
}

function referenceView(reference) {
  if (!reference) return null;
  return {
    item_version: text(reference.item_version), rule_version: text(reference.rule_version),
    basis_hash: text(reference.basis_hash), config_revision: number(reference.config_revision),
    focus_revision: number(reference.focus_revision), optional_enabled: reference.optional_enabled === true
  };
}

function snapshotView(snapshot, allowed) {
  if (!snapshot) return null;
  return { event_id: text(snapshot.event_id), session_no: number(snapshot.session_no),
    submitted_at: text(snapshot.submitted_at), basis_ref: referenceView(snapshot.basis_ref), ...scores(snapshot, allowed) };
}

function trendView(trend) {
  const allowed = ['total', 'pct', 'ors_total', 'add_total'];
  return {
    match_id: trend.match_id,
    baseline: snapshotView(trend.baseline?.original, allowed),
    recheck: snapshotView(trend.baseline?.recheck, allowed),
    reference_baseline: trend.reference_baseline ? {
      source: trend.reference_baseline.source, ...snapshotView(trend.reference_baseline, allowed)
    } : null,
    points: trend.points.map((point) => snapshotView(point, allowed))
  };
}

function comparisonView(profiles) {
  return {
    match_id: profiles.match_id,
    baseline: snapshotView(profiles.baseline?.original, ['total', 'ors_total', 'supp_total']),
    recheck: snapshotView(profiles.baseline?.recheck, ['total', 'ors_total']),
    end: snapshotView(profiles.end?.end, ['total', 'supp_total']),
    follow_1m: snapshotView(profiles.end?.follow_1m, ['total', 'supp_total']),
    follow_3m: snapshotView(profiles.end?.follow_3m, ['total', 'supp_total'])
  };
}

function llmView(result) {
  if (result.superseded || result.review_status === 'rejected') return null;
  if (result.schema_version === 'llm-t19-v1') {
    if (!['validated','approved'].includes(result.review_status) || !result.available_dimensions ||
        DIMENSIONS.some(k=>typeof result.available_dimensions[k]!=='boolean')) return null;
    let valid;
    try { valid=validateOutput(JSON.stringify(Object.fromEntries(['summary','dim_scores','suggest_actions','tag_weight_adjust'].map(k=>[k,result[k]]))),result.available_dimensions); }
    catch { return null; }
    return {event_id:text(result.event_id),session_no:number(result.session_no),summary:valid.summary,dim_scores:valid.dim_scores,
      suggest_actions:valid.suggest_actions,model:text(result.model),prompt_version:text(result.prompt_version),scored_at:text(result.scored_at),
      generation:number(result.generation),weight_revision:number(result.weight_revision),review_status:result.review_status,advisory_only:true};
  }
  const summary = result.summary;
  const actions = result.suggest_actions;
  if (typeof summary !== 'string' || !summary.trim() || [...summary].length > 60 || BANNED_TEXT.test(summary) ||
      !Array.isArray(actions) || actions.length > 2 ||
      actions.some((action) => typeof action !== 'string' || action.length > 200 || BANNED_TEXT.test(action)) ||
      DIMENSIONS.some((key) => typeof result.dim_scores?.[key] !== 'number' ||
        !Number.isFinite(result.dim_scores[key]) || result.dim_scores[key] < 0 || result.dim_scores[key] > 100)) return null;
  return {
    event_id: text(result.event_id), session_no: number(result.session_no),
    dim_scores: Object.fromEntries(DIMENSIONS.map((key) => [key, result.dim_scores[key]])),
    summary, suggest_actions: actions.slice(), model: text(result.model),
    prompt_version: text(result.prompt_version), scored_at: text(result.scored_at)
  };
}

module.exports = { professional, visibleCard, eventView, trendView, comparisonView, llmView };
