import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { databaseUrl, events, row } from './fixtures/sql-postgres-stub.mjs';

const filename = fileURLToPath(import.meta.url);
const scenario = process.argv[2];
if (['query', 'exec', 'patch'].includes(scenario)) {
  // Child isolation keeps the module hook and captured CLI output out of other tests.
  Object.assign(process.env, { APP_NAME: 'Vivary', NODE_ENV: 'production',
    DATABASE_URL: databaseUrl, DATABASE_URL_UNPOOLED: databaseUrl });
  const stubUrl = new URL('./fixtures/sql-postgres-stub.mjs', import.meta.url).href;
  registerHooks({ resolve(specifier, context, nextResolve) {
    return specifier === 'postgres' ? { url: stubUrl, shortCircuit: true } : nextResolve(specifier, context);
  } });
  const core = await realpath(new URL('../node_modules/@agent-native/core', import.meta.url));
  const load = name => import(pathToFileURL(path.join(core, 'dist', name)).href);
  const [{ runWithRequestContext }, { default: run }] = await Promise.all([
    load('server/request-context.js'), load(`scripts/db/${scenario}.js`),
  ]);
  const args = {
    query: ['--sql', 'SELECT id, body FROM inspection_notes', '--format', 'json'],
    exec: ['--sql', 'UPDATE inspection_notes SET body = ? WHERE id = ?',
      '--args', JSON.stringify(['changed row', 'own']), '--format', 'json'],
    patch: ['--table', 'inspection_notes', '--column', 'body', '--where', "id = 'own'",
      '--find', 'seeded', '--replace', 'patched', '--format', 'json'],
  }[scenario];
  const output = [];
  const originalLog = console.log;
  console.log = (...values) => output.push(values.join(' '));
  try {
    await runWithRequestContext({ userEmail: row.owner_email }, () => run(args));
  } finally { console.log = originalLog; }
  console.log(JSON.stringify({ events, row, output: JSON.parse(output.join('\n')) }));
} else {
  for (const name of ['query', 'exec', 'patch']) {
    test(`mocked PostgreSQL db-${name} pins literal escaping before transaction SQL`, () => {
      const result = JSON.parse(execFileSync(process.execPath, [filename, name], { encoding: 'utf8', timeout: 30000 }));
      // Positive controls prove each actual script reaches its user SQL and returns normally.
      assert.ok(result.events.some(event => event.kind === 'commit'));
      if (name === 'query') {
        assert.deepEqual(result.output.rows, [{ id: 'own', body: 'own seeded row' }]);
        assert.ok(result.events.some(event => event.kind === 'user-select'));
      } else {
        assert.ok(result.events.some(event => event.kind === 'user-update'));
        assert.equal(result.row.body, name === 'exec' ? 'changed row' : 'own patched row');
        assert.equal(name === 'exec' ? result.output.changes : result.output.applied, 1);
      }
      const transaction = result.events.filter(event => event.transaction);
      assert.ok(transaction.some(event => event.kind === 'scope-setup'));
      assert.equal(transaction[0]?.kind, 'literal-policy',
        'SET LOCAL standard_conforming_strings = on must precede scoped setup and user SQL');
      assert.equal(transaction.filter(event => event.kind === 'literal-policy').length, 1);
    });
  }
}
