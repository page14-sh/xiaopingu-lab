const { AssessmentError, SCALE_CODES, SCALES, requireId } = require('./model');
const { deny } = require('./authorization');
const { professional, visibleCard, eventView, trendView, comparisonView, llmView } = require('./read-views');

const PATHS = ['/v1/xg/events', '/v1/xg/trend', '/v1/xg/person-compare', '/v1/xg/llm-results'];
function badQuery() { throw new AssessmentError('XG_BAD_PARAM', '查询参数不合法', 400); }
function queryFields(params, allowed) {
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) badQuery();
}
function integer(params, key, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  if (!params.has(key)) return fallback;
  const value = params.get(key);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) badQuery();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) badQuery();
  return parsed;
}

async function handleAssessmentRead({ req, res, url, principal, repository, scopedMatch, sendJson }) {
  if (req.method !== 'GET' || !PATHS.includes(url.pathname)) return false;
  if (url.pathname !== '/v1/xg/events') professional(principal.role);
  const params = url.searchParams;
  const extras = url.pathname.endsWith('/events') ? ['event_id', 'scale_code', 'session_no', 'follow_round']
    : url.pathname.endsWith('/trend') ? ['scale_code', 'from_session', 'to_session']
      : url.pathname.endsWith('/llm-results') ? ['event_id'] : [];
  queryFields(params, ['match_id', 'limit', 'offset', ...extras]);
  const match = await scopedMatch(principal, requireId(params.get('match_id'), 'match_id'));
  const limit = integer(params, 'limit', 50, 1, 200);
  const offset = integer(params, 'offset', 0, 0, 100000);
  let eventId;
  if (params.has('event_id')) eventId = requireId(params.get('event_id'), 'event_id');
  let body;
  try {
    if (url.pathname.endsWith('/events')) {
      const scale = params.get('scale_code');
      if (scale !== null && !SCALE_CODES.includes(scale)) badQuery();
      if (scale && !visibleCard(principal.role, scale)) deny();
      const session = integer(params, 'session_no', null, 0);
      const round = params.get('follow_round');
      if (round !== null && !['', '1m', '3m'].includes(round)) badQuery();
      const selected = eventId ? [await repository.getEvent(match.match_id, eventId)].filter(Boolean)
        : await repository.listEvents(match.match_id);
      if (eventId && selected.length && !visibleCard(principal.role, selected[0].scale_code)) deny();
      // Filter authorized cards BEFORE paging. Counts/empty pages must not reveal M3 to visitors.
      const events = selected.filter((row) => visibleCard(principal.role, row.scale_code) &&
        (!scale || row.scale_code === scale) && (session === null || row.session_no === session) &&
        (round === null || row.follow_round === round));
      body = { events: events.slice(offset, offset + limit).map((row) => eventView(row, principal.role)) };
    } else if (url.pathname.endsWith('/trend')) {
      if (params.has('scale_code') && params.get('scale_code') !== SCALES.state) badQuery();
      const from = integer(params, 'from_session', 0, 0);
      const to = integer(params, 'to_session', Number.MAX_SAFE_INTEGER, 0);
      if (from > to) badQuery();
      const trend = await repository.getTrend(match.match_id);
      trend.points = trend.points.filter((point) => point.session_no >= from && point.session_no <= to).slice(offset, offset + limit);
      body = trendView(trend);
    } else if (url.pathname.endsWith('/person-compare')) {
      // Fixed stages, no cross-stage deltas or inferred clinical labels.
      body = comparisonView(await repository.getProfiles(match.match_id));
    } else {
      const results = await repository.listLlmResults(match.match_id, { eventId, limit, offset });
      body = { results: results.map(llmView).filter(Boolean) };
    }
  } catch (error) {
    if (error.code === 'XG_SCOPE_MISMATCH') deny();
    throw error;
  }
  sendJson(res, 200, body);
  return true;
}

module.exports = { handleAssessmentRead };
