const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { COLLECTIONS: C, SCALES: S, AssessmentError, requireId, documentKey, scopeOf, assertScope } = require('./model');
const DEFAULT_CATALOG = require('./definitions/items-v3-2.json');
const DEFAULT_RULES = require('./definitions/rules-t03-v1.json');
const { validateThresholds, parameterSchema } = require('./signal-parameters');

function invalid(message) { throw new AssessmentError('XG_BASIS_INVALID', message, 409); }
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  invalid('计分依据只允许有限数值和 JSON 数据');
}
function contentHash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function copy(value) { canonical(value); return structuredClone(value); }
function keys(value, expected) {
  if (!value || !isDeepStrictEqual(Object.keys(value).sort(), expected.slice().sort())) invalid('计分依据结构不完整或含未知字段');
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid('缺少有效的 expected_revision');
}
function string(value, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length > 5000) invalid('题面或配置文本不合法');
}

function validateCatalog(catalog) {
  keys(catalog, ['source_version', 'cards', 'items']);
  string(catalog.source_version);
  if (!Array.isArray(catalog.cards) || catalog.cards.length !== 7 ||
      !Array.isArray(catalog.items) || catalog.items.length !== 42) invalid('当前题库契约要求7张卡片和42道题');
  if (new Set(catalog.items.map((item) => item.code)).size !== 42 ||
      new Set(catalog.cards.map((card) => card.scale_code)).size !== 7) invalid('卡片或题号重复');
  for (const item of catalog.items) {
    const original = DEFAULT_CATALOG.items.find((row) => row.code === item.code);
    if (!original) invalid('未知题号');
    keys(item, Object.keys(original));
    for (const field of ['scale_code', 'item_type', 'is_dynamic', 'is_optional', 'sort_order']) {
      if (item[field] !== original[field]) invalid('题目类型、归属或选修结构变化需要新结构契约');
    }
    for (const field of ['label', 'dim', 'text']) string(item[field]);
    if (!item.text.trim()) invalid('题干不能为空');
    string(item.anchor_low, true); string(item.anchor_high, true);
    if (item.item_type === 'single_choice') {
      if (!Array.isArray(item.options) || item.options.length !== original.options.length) invalid('单选题选项不完整');
      item.options.forEach((option, index) => {
        keys(option, ['label', 'value']); string(option.label);
        if (option.value !== original.options[index].value) invalid('改变选项分值需要新计分契约');
      });
    } else if (item.options !== null) invalid('非单选题不可带单选选项');
  }
  for (const card of catalog.cards) {
    const original = DEFAULT_CATALOG.cards.find((row) => row.scale_code === card.scale_code);
    if (!original) invalid('未知卡片');
    keys(card, Object.keys(original));
    for (const field of ['phase', 'fill_role', 'timing', 'item_codes', 'optional_codes']) {
      if (!isDeepStrictEqual(card[field], original[field])) invalid('卡片组成变化需要新结构契约');
    }
    string(card.name); string(card.intro_text, true);
  }
  return copy(catalog);
}

function validateRules(rules) {
  keys(rules, Object.keys(DEFAULT_RULES));
  requireId(rules.engine_id, 'engine_id');
  string(rules.source_decision);
  // Current structural/score contract is the approved T03 rule set. Thresholds,
  // timing and quality duration can evolve under new immutable rule versions.
  for (const key of Object.keys(DEFAULT_RULES).filter((key) => !['engine_id', 'source_decision', 'thresholds', 'timing', 'quality'].includes(key))) {
    if (!isDeepStrictEqual(rules[key], DEFAULT_RULES[key])) invalid('计分结构变化需要升级规则契约');
  }
  validateThresholds(rules.thresholds);
  keys(rules.timing, Object.keys(DEFAULT_RULES.timing));
  if (Object.values(rules.timing).some((value) => !Number.isSafeInteger(value) || value <= 0)) invalid('时间间隔必须为正整数');
  keys(rules.quality, Object.keys(DEFAULT_RULES.quality));
  if (!Number.isFinite(rules.quality.duration_ms_per_answer) || rules.quality.duration_ms_per_answer <= 0 ||
      rules.quality.zero_variance !== 'low' || rules.quality.invalid_answers !== 'reject') invalid('质量规则不合法');
  return copy(rules);
}

function defaultVersionBundle() {
  return { item_version: 'items-v3-2', rule_version: 'rules-t03-v1', catalog: copy(DEFAULT_CATALOG), rules: copy(DEFAULT_RULES) };
}

async function readVersions(tx) {
  const release = await tx.get(C.assessmentRelease, 'current');
  if (!release) throw new AssessmentError('XG_BASIS_NOT_CONFIGURED', '题库和计分规则尚未发布', 503);
  if (!Number.isSafeInteger(release.revision) || release.revision < 1) invalid('发布修订号不合法');
  const items = await tx.get(C.itemVersions, release.item_version);
  const rules = await tx.get(C.ruleVersions, release.rule_version);
  if (!items || !rules || items.version !== release.item_version || rules.version !== release.rule_version ||
      items.content_hash !== release.item_hash || rules.content_hash !== release.rule_hash ||
      items.content_hash !== contentHash(items.definition) || rules.content_hash !== contentHash(rules.definition)) invalid('题库或规则版本完整性校验失败');
  validateCatalog(items.definition); validateRules(rules.definition);
  return { release, items, rules };
}

async function readCaseConfig(tx, match) {
  const currentRevision = match.assessment_config_revision || 0;
  if (!currentRevision) return {
    ...scopeOf(match), revision: 0, optional_enabled: false, focus_text: null,
    focus_revision: 0, optional_revision: 0, changed_at: null, changed_by: null
  };
  const config = await tx.get(C.caseAssessmentConfigs, documentKey(match.match_id, currentRevision));
  assertScope(config, match);
  if (!config || config.revision !== currentRevision || typeof config.optional_enabled !== 'boolean') invalid('个案评估配置缺失');
  const { _id, record_hash, ...content } = config;
  if (contentHash(content) !== record_hash) invalid('个案配置完整性校验失败');
  return config;
}

async function captureBasisInTransaction(tx, match, event, timestamp) {
  const { release, items, rules } = await readVersions(tx);
  const config = await readCaseConfig(tx, match);
  const card = items.definition.cards.find((row) => row.scale_code === event.scale_code);
  if (!card) invalid('卡片未包含在题库版本中');
  const optionalCodes = config.optional_enabled ? card.optional_codes : [];
  const notApplicable = event.scale_code === S.pro && event.session_no === 1 ? ['p6'] : [];
  const dynamic = card.item_codes.includes('s7');
  const rendered = [...card.item_codes, ...optionalCodes].map((code, index) => {
    const item = items.definition.items.find((row) => row.code === code);
    const applicable = !notApplicable.includes(code);
    return {
      ...copy(item), source_text: item.text,
      text: item.is_dynamic && config.focus_text ? config.focus_text : item.text,
      sort_order: index + 1, applicable, required: applicable,
      not_applicable_reason: applicable ? null : 'first_session_no_previous'
    };
  });
  const basis = {
    schema_version: 1, item_version: items.version, rule_version: rules.version,
    item_hash: items.content_hash, rule_hash: rules.content_hash, release_revision: release.revision,
    rules: copy(rules.definition),
    card: Object.fromEntries(['scale_code', 'name', 'phase', 'fill_role', 'timing', 'intro_text'].map((key) => [key, card[key]])),
    items: rendered,
    context: {
      ...scopeOf(match), event_id: event.event_id, session_no: event.session_no, follow_round: event.follow_round,
      config_revision: config.revision, optional_enabled: config.optional_enabled,
      enabled_optional_codes: optionalCodes.slice(), focus_revision: dynamic ? config.focus_revision : null,
      focus_text: dynamic ? config.focus_text : null, focus_source: dynamic ? (config.focus_text ? 'case' : 'item_default') : null,
      not_applicable_codes: notApplicable,
      primary_max: notApplicable.length ? null : rules.definition.primary_max[event.scale_code],
      optional_max: optionalCodes.length ? rules.definition.optional.max : null
    },
    captured_at: timestamp
  };
  return { ...basis, basis_hash: contentHash(basis) };
}

function verifyEventBasis(event) {
  if (!event.basis) return null; // Legacy provenance is unknown; never reconstruct from today's release.
  const { basis_hash, ...basis } = event.basis;
  keys(basis, ['schema_version', 'item_version', 'rule_version', 'item_hash', 'rule_hash', 'release_revision', 'rules', 'card', 'items', 'context', 'captured_at']);
  if (basis.schema_version !== 1 || contentHash(basis) !== basis_hash || contentHash(basis.rules) !== basis.rule_hash ||
      basis.card.scale_code !== event.scale_code) invalid('事件计分依据完整性校验失败');
  for (const key of ['match_id', 'visitor_id', 'counselor_id', 'event_id', 'session_no', 'follow_round']) {
    if (basis.context[key] !== event[key]) invalid('事件与计分依据归属不一致');
  }
  return copy(event.basis);
}

function createProvenanceRepository(store, { now = () => new Date().toISOString() } = {}) {
  function thresholdsView(release, rules) {
    return { revision: release.revision, item_version: release.item_version, rule_version: release.rule_version,
      thresholds: copy(rules.definition.thresholds), parameters: parameterSchema(),
      published_at: rules.published_at, published_by: rules.published_by,
      change_reason: rules.threshold_change?.reason || null,
      previous_rule_version: rules.previous_rule_version || null };
  }
  return {
    async getThresholds() {
      return store.transaction(async (tx) => {
        const { release, rules } = await readVersions(tx);
        return thresholdsView(release, rules);
      });
    },

    // Only admin HTTP or trusted operators may publish. Events already started
    // keep their captured rules; this never rewrites sources or queues a backfill.
    async publishThresholds({ rule_version, expected_revision, thresholds, reason, published_by }) {
      requireId(rule_version, 'rule_version'); requireId(published_by, 'published_by'); revision(expected_revision);
      const patch = validateThresholds(thresholds, { partial: true });
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) {
        throw new AssessmentError('XG_BAD_PARAM', '请提供1至500字符的阈值变更原因', 400);
      }
      const change = { base_revision: expected_revision, patch, reason: reason.trim(), published_by };
      return store.transaction(async (tx) => {
        const { release, rules } = await readVersions(tx);
        const existing = await tx.get(C.ruleVersions, rule_version);
        if (existing) {
          if (release.rule_version === rule_version && isDeepStrictEqual(existing.threshold_change, change)) {
            return { ...thresholdsView(release, rules), duplicated: true };
          }
          throw new AssessmentError('XG_VERSION_IMMUTABLE', '规则版本已存在，不可覆盖或重新激活');
        }
        if (release.revision !== expected_revision) throw new AssessmentError('XG_VERSION_CONFLICT', '发布版本已变化，请重新读取');
        const definition = validateRules({ ...copy(rules.definition), thresholds: { ...rules.definition.thresholds, ...patch } });
        if (isDeepStrictEqual(definition.thresholds, rules.definition.thresholds)) {
          throw new AssessmentError('XG_RULE_NO_CHANGE', '阈值没有变化，无需创建新版本');
        }
        const timestamp = now();
        const record = { version: rule_version, definition, content_hash: contentHash(definition),
          published_at: timestamp, published_by, previous_rule_version: release.rule_version, threshold_change: change };
        const next = { ...release, rule_version, rule_hash: record.content_hash, revision: release.revision + 1,
          published_at: timestamp, published_by };
        await tx.put(C.ruleVersions, rule_version, record);
        await tx.put(C.assessmentRelease, 'current', next);
        return { ...thresholdsView(next, record), duplicated: false };
      });
    },

    // Trusted configuration entry, not a client mutation route.
    async publishVersions({ item_version, rule_version, catalog, rules, published_by, expected_revision }) {
      requireId(item_version, 'item_version'); requireId(rule_version, 'rule_version'); requireId(published_by, 'published_by'); revision(expected_revision);
      const definitions = [
        [C.itemVersions, item_version, validateCatalog(catalog)],
        [C.ruleVersions, rule_version, validateRules(rules)]
      ];
      return store.transaction(async (tx) => {
        const current = await tx.get(C.assessmentRelease, 'current');
        for (const [collection, version, definition] of definitions) {
          const existing = await tx.get(collection, version);
          if (existing && (existing.content_hash !== contentHash(definition) || !isDeepStrictEqual(existing.definition, definition))) {
            throw new AssessmentError('XG_VERSION_IMMUTABLE', '题目或规则版本已存在，不可覆盖');
          }
        }
        if (current?.item_version === item_version && current?.rule_version === rule_version) return current;
        if ((current?.revision || 0) !== expected_revision) throw new AssessmentError('XG_VERSION_CONFLICT', '发布版本已变化，请重新读取');
        const timestamp = now();
        for (const [collection, version, definition] of definitions) {
          if (!await tx.get(collection, version)) await tx.put(collection, version, {
            version, definition, content_hash: contentHash(definition), published_by, published_at: timestamp
          });
        }
        const release = { item_version, rule_version, item_hash: contentHash(definitions[0][2]),
          rule_hash: contentHash(definitions[1][2]), revision: expected_revision + 1, published_by, published_at: timestamp };
        await tx.put(C.assessmentRelease, 'current', release);
        return release;
      });
    },

    async setCaseConfig(matchId, { optional_enabled, focus_text, expected_revision, changed_by }) {
      requireId(matchId, 'match_id'); requireId(changed_by, 'changed_by'); revision(expected_revision);
      if (typeof optional_enabled !== 'boolean' || (focus_text !== null && (typeof focus_text !== 'string' || !focus_text.trim() || focus_text.length > 500))) invalid('个案配置须明确选修开关及关注主题');
      return store.transaction(async (tx) => {
        const match = await tx.get(C.matches, matchId);
        if (!match) throw new AssessmentError('XG_NOT_FOUND', '咨询周期不存在', 404);
        if (match.match_id !== matchId) throw new AssessmentError('XG_SCOPE_MISMATCH', '咨询周期归属异常');
        if (match.status !== 'active') throw new AssessmentError('XG_RELATION_CLOSED', '已结案周期不可修改评估配置');
        const current = await readCaseConfig(tx, match);
        if (current.revision !== expected_revision) throw new AssessmentError('XG_VERSION_CONFLICT', '个案配置已变化，请重新读取');
        if (current.optional_enabled === optional_enabled && current.focus_text === focus_text) return current;
        const next = {
          ...scopeOf(match), revision: current.revision + 1, optional_enabled, focus_text,
          focus_revision: current.focus_revision + (current.focus_text === focus_text ? 0 : 1),
          optional_revision: current.optional_revision + (current.optional_enabled === optional_enabled ? 0 : 1),
          changed_at: now(), changed_by
        };
        if (await tx.get(C.caseAssessmentConfigs, documentKey(matchId, next.revision))) {
          throw new AssessmentError('XG_VERSION_IMMUTABLE', '个案配置历史不可覆盖');
        }
        next.record_hash = contentHash(next);
        await tx.put(C.caseAssessmentConfigs, documentKey(matchId, next.revision), next);
        await tx.put(C.matches, matchId, { ...match, assessment_config_revision: next.revision, version: match.version + 1 });
        return next;
      });
    },

    async eventBasis(matchId, eventId) {
      requireId(matchId, 'match_id'); requireId(eventId, 'event_id');
      return store.transaction(async (tx) => {
        const match = await tx.get(C.matches, matchId);
        const event = await tx.get(C.events, eventId);
        if (!match || !event) throw new AssessmentError('XG_NOT_FOUND', '周期或事件不存在', 404);
        if (match.match_id !== matchId) throw new AssessmentError('XG_SCOPE_MISMATCH', '咨询周期归属异常');
        assertScope(event, match);
        const basis = verifyEventBasis(event);
        return { event_id: eventId, match_id: matchId, available: Boolean(basis),
          reason: basis ? null : 'not_captured', basis };
      });
    }
  };
}

module.exports = { createProvenanceRepository, captureBasisInTransaction, verifyEventBasis, defaultVersionBundle, contentHash, readVersionsInTransaction: readVersions };
