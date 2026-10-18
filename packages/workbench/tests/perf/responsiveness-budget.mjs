import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Lower these policy ceilings and the JSON budget together after a proven win.
// Candidate configuration cannot remove a protected scenario or undo its gain.
const revisitCeilings = { codeWarmMs: 0.76, nativeWarmMs: 0.75 };
const scenarioNames = ['codeColdMs', 'codeWarmMs', 'nativeColdMs', 'nativeWarmMs'];
const median = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length / 2) - 1];

// Compare raw samples from two builds measured on the same runner. Ratios avoid
// treating one host's absolute milliseconds as another host's calibrated budget.
export function checkResponsivenessBudget(baseline, candidate, budget) {
  assert.equal(baseline.conditions.commit, budget.baselineCommit, 'Wrong baseline commit');
  assert.equal(candidate.conditions.dirty, false, 'Candidate must measure its committed source');
  if (budget.baselineDirtyHash) {
    assert.match(budget.baselineDirtyHash, /^[a-f0-9]{64}$/);
    assert.equal(baseline.conditions.dirty, true);
    assert.equal(baseline.conditions.dirtyHash, budget.baselineDirtyHash, 'Wrong baseline harness overlay');
  } else {
    assert.equal(baseline.conditions.dirty, false, 'Baseline overlay requires its recorded source hash');
  }
  for (const key of ['mode', 'repeats', 'samples', 'harnessSha256', 'chrome', 'node',
    'cpu', 'cpuCount', 'platform', 'seed', 'viewport']) {
    assert.notEqual(baseline.conditions[key], undefined, `Missing condition: ${key}`);
    assert.deepEqual(candidate.conditions[key], baseline.conditions[key], `Different condition: ${key}`);
  }
  const distributions = report => {
    assert.equal(report.conditions.mode, 'ordinary-switches');
    assert.ok(report.conditions.repeats >= 3 && Number.isInteger(report.conditions.repeats));
    assert.ok(report.conditions.samples >= 15 && Number.isInteger(report.conditions.samples));
    assert.equal(report.runs.length, report.conditions.repeats);
    const result = Object.fromEntries(scenarioNames.map(name => [name, []]));
    for (const [index, run] of report.runs.entries()) {
      assert.equal(run.repeat, index + 1);
      assert.equal(run.status, 'complete', 'Incomplete/crashed run is not passing evidence');
      assert.equal(run.size, 'large');
      assert.deepEqual(run.fixture, { nativeCount: 200, codeCount: 1000 });
      for (const name of scenarioNames) {
        const values = run.scenarios[name];
        assert.equal(values.n, report.conditions.samples);
        assert.equal(values.samples.length, report.conditions.samples);
        assert.equal(values.targets.length, report.conditions.samples);
        assert.ok(values.samples.every(value => Number.isFinite(value) && value > 0));
        result[name].push(median(values.samples));
      }
    }
    return result;
  };
  const before = distributions(baseline), after = distributions(candidate);
  for (let i = 0; i < baseline.runs.length; i++) {
    assert.ok(baseline.runs[i].switchTargets, 'Missing target/hop provenance');
    assert.deepEqual(candidate.runs[i].switchTargets, baseline.runs[i].switchTargets, 'Different target/hop selection');
    for (const name of scenarioNames) {
      assert.deepEqual(candidate.runs[i].scenarios[name].targets, baseline.runs[i].scenarios[name].targets,
        `Different measured workload: run ${i + 1} ${name}`);
    }
  }
  for (const [name, ceiling] of Object.entries(revisitCeilings)) {
    assert.ok(Object.hasOwn(budget.maxRatio, name), `Missing calibrated budget: ${name}`);
    assert.ok(Number.isFinite(budget.maxRatio[name]) && budget.maxRatio[name] > 0
      && budget.maxRatio[name] <= ceiling, `Budget exceeds established ceiling: ${name}`);
  }
  const scenarios = {};
  for (const [name, maxRatio] of Object.entries(budget.maxRatio)) {
    assert.ok(scenarioNames.includes(name));
    assert.ok(Number.isFinite(maxRatio) && maxRatio > 0 && maxRatio < 1, 'Budget must retain a measured win');
    const baselineMs = median(before[name]), candidateMs = median(after[name]);
    scenarios[name] = { baselineMs, candidateMs, ratio: candidateMs / baselineMs, maxRatio,
      baselineRangeMs: [Math.min(...before[name]), Math.max(...before[name])],
      candidateRangeMs: [Math.min(...after[name]), Math.max(...after[name])] };
  }
  return { passed: Object.values(scenarios).every(value => value.ratio <= value.maxRatio), scenarios };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [baselinePath, candidatePath, budgetPath, expectedHead] = process.argv.slice(2);
  assert.ok(baselinePath && candidatePath && budgetPath && expectedHead,
    'Usage: node responsiveness-budget.mjs baseline.json candidate.json budget.json EXPECTED_HEAD');
  const read = file => JSON.parse(readFileSync(file, 'utf8'));
  const candidate = read(candidatePath);
  assert.equal(candidate.conditions.commit, expectedHead, 'Wrong candidate commit');
  const result = checkResponsivenessBudget(read(baselinePath), candidate, read(budgetPath));
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
