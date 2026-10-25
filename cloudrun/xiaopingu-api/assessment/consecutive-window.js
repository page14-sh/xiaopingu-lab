// Map contains successful events for one card in one cycle. No gap filling,
// sorting-and-slicing of sparse rows, or inclusion of the baseline recheck.
function consecutiveWindow(map, session, count, minimum = 1) {
  if (!Number.isSafeInteger(session) || !Number.isSafeInteger(count) || count < 1 ||
      count > map.size || session - count + 1 < minimum) return [];
  const result = [];
  for (let n = session - count + 1; n <= session; n++) {
    const event = map.get(n); if (!event) return []; result.push(event);
  }
  return result;
}
module.exports = { consecutiveWindow };
