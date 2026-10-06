import assert from 'node:assert/strict';
import test from 'node:test';
import { checkResponsivenessBudget } from './responsiveness-budget.mjs';

const budget = { baselineCommit: 'baseline', maxRatio: { codeWarmMs: 0.76, nativeWarmMs: 0.75 } };
function report(commit, ms) {
  return { conditions: { commit, dirty: false, dirtyHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', mode: 'ordinary-switches', repeats: 3, samples: 15,
    harnessSha256: 'same-harness', chrome: 'same-browser', node: 'same-node', cpu: 'same-cpu',
    cpuCount: 6, platform: 'same-platform', seed: 188, viewport: { width: 1440, height: 1000 } },
    runs: Array.from({ length: 3 }, (_, repeat) => ({ size: 'large', repeat: repeat + 1, status: 'complete',
      switchTargets: { code: { leave: 'native-hop', pool: ['code'] }, native: { leave: 'code-hop', pool: ['native'] } },
      fixture: { codeCount: 1000, nativeCount: 200 }, scenarios: Object.fromEntries(
        ['codeColdMs', 'codeWarmMs', 'nativeColdMs', 'nativeWarmMs'].map(key => [key,
          { n: 15, samples: Array(15).fill(ms), p50: ms, targets: Array(15).fill(key) }])) })) };
}

test('paired guard accepts a substantial win and rejects a lost win', () => {
  const base = report('baseline', 1000);
  assert.equal(checkResponsivenessBudget(base, report('candidate', 600), budget).passed, true);
  const regression = checkResponsivenessBudget(base, report('candidate', 900), budget);
  assert.equal(regression.passed, false);
  assert.equal(regression.scenarios.codeWarmMs.ratio, 0.9);
});

test('reported summaries cannot hide a regression in raw samples', () => {
  const candidate = report('candidate', 900);
  for (const run of candidate.runs) for (const value of Object.values(run.scenarios)) value.p50 = 1;
  assert.equal(checkResponsivenessBudget(report('baseline', 1000), candidate, budget).passed, false);
});

test('incomplete, crashed, mismatched and invalid evidence cannot pass', () => {
  const changes = [
    value => value.runs.pop(),
    value => { value.runs[0].status = 'crashed'; },
    value => { value.runs[0].scenarios.codeWarmMs.samples.pop(); },
    value => { value.runs[0].scenarios.nativeWarmMs.samples[0] = NaN; },
    value => { value.conditions.harnessSha256 = 'other'; },
    value => { value.conditions.chrome = 'other'; },
    value => { value.conditions.mode = 'full'; },
    value => { value.runs[0].scenarios.codeWarmMs.targets[0] = 'different-workload'; },
    value => { value.runs[0].switchTargets.native.leave = 'different-hop'; },
    value => { value.conditions.dirty = true; },
    value => { value.runs[0].fixture.codeCount = 10; },
  ];
  for (const change of changes) {
    const candidate = report('candidate', 600); change(candidate);
    assert.throws(() => checkResponsivenessBudget(report('baseline', 1000), candidate, budget));
  }
  assert.throws(() => checkResponsivenessBudget(report('other-base', 1000), report('candidate', 600), budget));
});

test('a dirty baseline overlay requires the exact separately recorded source hash', () => {
  const base = report('baseline', 1000);
  base.conditions.dirty = true;
  base.conditions.dirtyHash = 'a'.repeat(64);
  const candidate = report('candidate', 600);
  assert.throws(() => checkResponsivenessBudget(base, candidate, budget));
  assert.equal(checkResponsivenessBudget(base, candidate, { ...budget, baselineDirtyHash: 'a'.repeat(64) }).passed, true);
  assert.throws(() => checkResponsivenessBudget(base, candidate, { ...budget, baselineDirtyHash: 'b'.repeat(64) }));
});

test('the paired guard refuses a missing calibrated revisit scenario', () => {
  for (const scenario of ['codeWarmMs', 'nativeWarmMs']) {
    const weakened = structuredClone(budget);
    delete weakened.maxRatio[scenario];
    assert.throws(() => checkResponsivenessBudget(report('baseline', 1000), report('candidate', 600), weakened));
  }
});

test('the paired guard refuses ceilings above the established wins', () => {
  for (const scenario of ['codeWarmMs', 'nativeWarmMs']) {
    const weakened = structuredClone(budget);
    weakened.maxRatio[scenario] = 0.99;
    assert.throws(() => checkResponsivenessBudget(report('baseline', 1000), report('candidate', 600), weakened));
  }
});

test('established ceilings and stricter budgets remain valid', () => {
  const baseline = report('baseline', 1000), candidate = report('candidate', 600);
  assert.equal(checkResponsivenessBudget(baseline, candidate, budget).passed, true);
  assert.equal(checkResponsivenessBudget(baseline, candidate,
    { ...budget, maxRatio: { codeWarmMs: 0.7, nativeWarmMs: 0.7 } }).passed, true);
  assert.throws(() => checkResponsivenessBudget(baseline, candidate,
    { ...budget, maxRatio: { ...budget.maxRatio, unknownScenario: 0.5 } }));
});
