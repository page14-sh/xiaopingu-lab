const { RISK_SCALE, SCALES: S, AssessmentError, documentKey, basisReference, assertScope } = require('./model');
const { replayEventScores } = require('./score-replay');
const { validateThresholds, RULE_PARAMETERS } = require('./signal-parameters');
const { consecutiveWindow } = require('./consecutive-window');

const CARDS = [S.state, S.feel, S.pro];
const RELEVANT = [S.baseline, ...CARDS, RISK_SCALE];
const level = (signals) => signals.reduce((max, s) => Math.max(max, Number(s.level.slice(1))), 0);
const levelName = (n) => n ? `L${n}` : null;
const ref = (event) => ({ event_id: event.event_id, session_no: event.session_no, scale_code: event.scale_code,
  basis_ref: basisReference(event), quality_flag: event.quality_flag });

// The same final set of events always chooses the same rules, irrespective of
// arrival order. Each result records that policy separately from source bases.
function evaluateCombinations(match, input) {
  const rows = input.filter((e) => e.status === 'submitted' && RELEVANT.includes(e.scale_code));
  const byCard = new Map(RELEVANT.map((card) => [card, new Map()]));
  for (const event of rows) {
    assertScope(event, match);
    const replay = replayEventScores(event);
    if (!replay.matches) throw new AssessmentError('XG_COMBINATION_SCORES_MISMATCH', '历史分数与冻结依据不一致，组合判读暂停', 503);
    const map = byCard.get(event.scale_code);
    if (map.has(event.session_no)) throw new AssessmentError('XG_COMBINATION_DUPLICATE', '同一位置存在重复成功答卷', 503);
    map.set(event.session_no, event);
  }
  const get = (card, session) => byCard.get(card).get(session);
  const baseline = get(S.baseline, 0), recheck = get(S.state, 1), reference = recheck || baseline;
  const window = (card, session, count) => consecutiveWindow(byCard.get(card), session, count, card === S.state ? 2 : 1);
  const sessions = [...new Set(rows.map((e) => e.session_no))].sort((a, b) => a - b);
  return sessions.map((session) => {
    const state = get(S.state, session), feel = get(S.feel, session), pro = get(S.pro, session);
    const risk=get(RISK_SCALE,session);
    const policy = state || feel || pro || risk || baseline;
    let t;
    try { t = validateThresholds(policy.basis.rules.thresholds); }
    catch { throw new AssessmentError('XG_RULE_PARAMETERS_INVALID', '历史阈值不符合当前参数契约，请核对后重算', 503); }
    const signals = [];
    function add(rule, severity, anchor, sources, facts = {}) {
      signals.push({ signal_id: documentKey(match.match_id, anchor.session_no, rule), rule_id: rule,
        level: severity, event_id: anchor.event_id, evidence: sources.map(ref), facts,
        parameters: Object.fromEntries(RULE_PARAMETERS[rule].map((key) => [key, t[key]])),
        window_sessions: sources.filter((e) => e.scale_code === anchor.scale_code &&
          (e.scale_code !== S.state || e.session_no >= 2)).map((e) => e.session_no) });
    }
    if(risk&&risk.raw_answers.k1>=risk.basis.rules.risk_recheck.positive_min)add('RISK-RECHECK',risk.raw_answers.k1>=risk.basis.rules.risk_recheck.urgent_min?'L3':'L2',risk,[risk],{value:risk.raw_answers.k1,safety_line:true});
    if (baseline?.scores.dissoc_level === 2) add('DISSOC', 'L3', baseline, [baseline], { value: 2 });
    if (state && session >= 2) {
      const current = state.scores.total;
      if (current * 100 < t.l3_low_pct * 70) add('OUT-LOW', 'L3', state, [state], { total: current, threshold_pct: t.l3_low_pct });
      if (reference) {
        const delta = current - reference.scores.total;
        const dropped = (e) => e.scores.total - reference.scores.total <= -t.outcome_drop_abs;
        const dropWindow = window(S.state, session, t.outcome_drop_consecutive);
        if (dropWindow.length && dropWindow.every(dropped)) {
          add('OUT-DROP', 'L2', state, [reference, ...dropWindow], { reference_total: reference.scores.total, totals: dropWindow.map((e) => e.scores.total), threshold: t.outcome_drop_abs });
          const recent = window(S.state, session, t.l3_consecutive);
          if (recent.length >= 3) {
            if (recent.every((e, i) => !i || e.scores.total < recent[i - 1].scores.total)) add('OUT-MONO', 'L3', state, recent);
            const totals = recent.map((e) => e.scores.total);
            const priorNonIncreasing = totals.slice(0, -1).every((value, i) => !i || value <= totals[i - 1]);
            if (totals.at(-1) - totals.at(-2) <= -t.outcome_drop_abs && priorNonIncreasing) add('OUT-ACCEL', 'L3', state, recent);
          }
        }
        const flatWindow = window(S.state, session, t.outcome_flat_consecutive);
        if (flatWindow.length && flatWindow.every((e) => Math.abs(e.scores.total - reference.scores.total) < t.outcome_flat_delta)) {
          add('OUT-FLAT', 'L2', state, [reference, ...flatWindow], { reference_total: reference.scores.total, totals: flatWindow.map((e) => e.scores.total), threshold: t.outcome_flat_delta });
        }
        if (delta <= -t.outcome_drop_abs && !signals.some((s) => s.rule_id.startsWith('OUT-') && s.level !== 'L1')) add('OUT-SINGLE', 'L1', state, [reference, state], { delta });
      }
      const stable = window(S.state, session, t.stability_consecutive);
      if (stable.length && stable.every((e) => e.basis.context.optional_enabled &&
          ['s8','s9','s10'].some((code) => e.raw_answers[code] <= t.stability_item_max))) {
        add('STAB-SELF', 'L2', state, stable);
      }
    }
    if (feel) {
      const recent = window(S.feel, session, t.alliance_consecutive);
      if (recent.length && recent.every((e) => e.scores.total <= t.alliance_total_max)) add('ALL-TOTAL', 'L2', feel, recent, { totals: recent.map((e) => e.scores.total) });
      if (recent.length && recent.every((e) => ['f1','f2','f3','f4'].some((code) => e.raw_answers[code] <= t.alliance_dim_max))) {
        add('ALL-DIM', 'L2', feel, recent, { items: recent.map((e) => ({ event_id: e.event_id,
          codes: ['f1','f2','f3','f4'].filter((code) => e.raw_answers[code] <= t.alliance_dim_max) })) });
      }
    }
    if (pro) {
      const recent = window(S.pro, session, t.stability_consecutive);
      if (recent.length && recent.every((e) => e.basis.context.optional_enabled && e.raw_answers.p4 <= t.stability_item_max)) add('STAB-PRO', 'L2', pro, recent);
    }
    const comparable = !!(feel && pro && Number.isFinite(pro.scores.total));
    // Compare cross-multiplied integer totals, never rounded display percentages.
    const gapNumerator = comparable ? Math.abs(feel.scores.total * 60 - pro.scores.total * 40) * 100 : null;
    const gap = comparable && gapNumerator >= t.diff_post_warn * 2400;
    const diff = comparable ? Math.round(gapNumerator / 2400 * 100) / 100 : null;
    if (gap) add('ALL-GAP', 'L2', feel, [feel, pro], { diff_post: diff, numerator: gapNumerator, denominator: 2400, threshold: t.diff_post_warn });
    signals.sort((a, b) => a.rule_id.localeCompare(b.rule_id));
    const missing = (session >= 2 ? CARDS : session === 1 ? [S.feel, S.pro] : []).filter((card) => !get(card, session));
    const original = level(signals);
    const allianceStable = comparable && feel.scores.total > t.alliance_total_max &&
      ['f1','f2','f3','f4'].every((code) => feel.raw_answers[code] > t.alliance_dim_max) && !gap;
    // Every L2/L3 signal other than OUT-DROP is independently retained. A stable
    // current alliance must not erase an existing alliance/stability/flat signal.
    const canDowngrade = !!(state && session >= 2 && !missing.length && allianceStable && original === 2 &&
      signals.some((s) => s.rule_id === 'OUT-DROP') && signals.every((s) => s.level === 'L1' || s.rule_id === 'OUT-DROP'));
    const reason = original === 3 ? 'preserve_l3' : signals.some((s) => s.rule_id === 'OUT-FLAT') ? 'preserve_flat'
      : missing.length ? 'awaiting_cards' : session === 1 ? 'first_session_not_comparable'
        : canDowngrade ? 'outcome_drop_alliance_stable' : gap ? 'alliance_gap' : 'preserve_original';
    return { session_no: session,
      raw: { policy: { engine_id: 'xg-combination-t03-v2', source_event_id: policy.event_id,
        rule_version: policy.basis.rule_version, rule_hash: policy.basis.rule_hash, thresholds: t }, signals },
      combined: { status: session === 0 ? 'baseline_only' : missing.length ? 'pending_cards' : session === 1 ? 'not_comparable' : state && !reference ? 'pending_baseline' : 'complete',
        missing_cards: missing, reference_event_id: reference?.event_id || null,
        baseline_pending: !!(state && session >= 2 && !reference),
        event_ids: { state: state?.event_id || null, feel: feel?.event_id || null, pro: pro?.event_id || null },
        source_bases: [state, feel, pro].filter(Boolean).map(ref),
        original_level: levelName(original), display_level: canDowngrade ? 'L1' : levelName(original),
        diff_post: diff, alliance_stable: allianceStable, downgraded: canDowngrade, reason,
        signal_ids: signals.map((s) => s.signal_id) }
    };
  });
}

module.exports = { evaluateCombinations, RELEVANT };
