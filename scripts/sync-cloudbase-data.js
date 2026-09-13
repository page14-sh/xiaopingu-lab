const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(PROJECT_ROOT, 'server', 'local-data.json');
const ENV_ID = 'xpg-demo-d3gzsswtcc3233ea0';
const TABLES = ['assessments', 'counselors', 'sessions', 'pcoms_ratings', 'visitor_users'];
const APPLY = process.argv.includes('--apply');

function runTcb(args) {
  const result = spawnSync('tcb', args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `tcb exited with ${result.status}`).trim());
  }
  return result.stdout;
}

function parseTcbJson(output) {
  const start = output.indexOf('{');
  if (start < 0) throw new Error(`CloudBase CLI did not return JSON: ${output.trim()}`);
  return JSON.parse(output.slice(start));
}

function execute(commands) {
  const output = runTcb([
    'db', 'nosql', 'execute',
    '--command', JSON.stringify(commands),
    '--json'
  ]);
  return parseTcbJson(output).data.results;
}

function safeDocument(value) {
  if (Array.isArray(value)) return value.map(safeDocument);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '_id' || key === '__proto__' || key === 'prototype' || key === 'constructor' || key.startsWith('$')) continue;
    output[key] = safeDocument(child);
  }
  return output;
}

function recordTime(record) {
  const value = record.updated_at || record.created_at || '';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function chunks(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function queryRemoteMetadata() {
  const commands = TABLES.map((table) => ({
    TableName: table,
    CommandType: 'QUERY',
    Command: JSON.stringify({
      find: table,
      filter: {},
      projection: { _id: 0, id: 1, updated_at: 1, created_at: 1 },
      limit: 1000
    })
  }));
  const results = execute(commands);
  return Object.fromEntries(TABLES.map((table, index) => [table, Array.isArray(results[index]) ? results[index] : []]));
}

function countRemote() {
  const commands = TABLES.map((table) => ({
    TableName: table,
    CommandType: 'COMMAND',
    Command: JSON.stringify({ count: table, query: {} })
  }));
  const results = execute(commands);
  return Object.fromEntries(TABLES.map((table, index) => {
    const value = results[index] && results[index][0] && results[index][0].n;
    return [table, Number(value && value.$numberInt !== undefined ? value.$numberInt : value || 0)];
  }));
}

function applyInserts(table, records) {
  for (const batch of chunks(records, 8)) {
    execute([{
      TableName: table,
      CommandType: 'INSERT',
      Command: JSON.stringify({ insert: table, documents: batch })
    }]);
  }
}

function applyUpdates(table, records) {
  for (const batch of chunks(records, 8)) {
    execute([{
      TableName: table,
      CommandType: 'UPDATE',
      Command: JSON.stringify({
        update: table,
        updates: batch.map((record) => ({
          q: { id: record.id },
          u: { $set: record },
          multi: false,
          upsert: false
        }))
      })
    }]);
  }
}

function main() {
  if (!fs.existsSync(DATA_FILE)) throw new Error(`Local data file not found: ${DATA_FILE}`);
  const local = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  runTcb(['env', 'use', ENV_ID]);

  const remote = queryRemoteMetadata();
  const plans = {};

  for (const table of TABLES) {
    const localRows = (Array.isArray(local[table]) ? local[table] : []).map(safeDocument);
    const remoteById = new Map(remote[table].filter((row) => row.id).map((row) => [row.id, row]));
    const insert = [];
    const update = [];
    let skippedEqualOrNewer = 0;

    for (const row of localRows) {
      if (!row.id) throw new Error(`${table} contains a record without id`);
      const existing = remoteById.get(row.id);
      if (!existing) {
        insert.push(row);
      } else if (recordTime(row) > recordTime(existing)) {
        update.push(row);
      } else {
        skippedEqualOrNewer += 1;
      }
    }

    plans[table] = {
      local: localRows.length,
      remoteBefore: remote[table].length,
      insert: insert.length,
      update: update.length,
      skippedEqualOrNewer,
      remoteOnlyPreserved: remote[table].filter((row) => !localRows.some((localRow) => localRow.id === row.id)).length
    };

    if (APPLY) {
      applyInserts(table, insert);
      applyUpdates(table, update);
    }
  }

  const result = {
    mode: APPLY ? 'apply' : 'dry-run',
    envId: ENV_ID,
    dataFile: path.relative(PROJECT_ROOT, DATA_FILE),
    plans
  };
  if (APPLY) result.remoteAfter = countRemote();
  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
