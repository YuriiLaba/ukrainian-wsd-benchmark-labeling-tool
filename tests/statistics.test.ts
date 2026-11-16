import { test } from "node:test";
import assert from "node:assert/strict";
import { finitePopulationInterval, hypergeomTails, planningMargin } from "../lib/audit/statistics.ts";

function choose(n: number, k: number) {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result *= (n - i + 1) / i;
  return result;
}
test("tail recurrence matches independent enumeration of combinations", () => {
  for (let N = 1; N <= 14; N++) for (let n = 1; n <= N; n++) for (let K = 0; K <= N; K++) for (let k = 0; k <= n; k++) {
    let lower = 0, upper = 0;
    for (let x = 0; x <= n; x++) { const p = choose(K, x) * choose(N - K, n - x) / choose(N, n); if (x <= k) lower += p; if (x >= k) upper += p; }
    const actual = hypergeomTails(N, K, n, k);
    assert.ok(Math.abs(actual.lower - lower) < 1e-12);
    assert.ok(Math.abs(actual.upper - upper) < 1e-12);
  }
});
test("exact interval achieves at least 95% coverage for every small finite population", () => {
  for (let N = 1; N <= 20; N++) for (let n = 1; n <= N; n++) for (let K = 0; K <= N; K++) {
    let coverage = 0;
    for (let k = 0; k <= n; k++) {
      const interval = finitePopulationInterval(N, n, k);
      if (interval.lowerCount <= K && K <= interval.upperCount) coverage += choose(K, k) * choose(N - K, n - k) / choose(N, n);
    }
    assert.ok(coverage >= .95 - 1e-12, `N=${N} n=${n} K=${K}: ${coverage}`);
  }
});
test("benchmark-scale intervals match Python exact-integer combinatorial reference", () => {
  const expected = [[0, 0, 120], [1, 1, 182], [200, 5999, 7311], [350, 11169, 12050], [380, 12302, 12896], [400, 13190, 13310]];
  for (const [k, lower, upper] of expected) {
    const interval = finitePopulationInterval(13310, 400, k);
    assert.equal(interval.lowerCount, lower); assert.equal(interval.upperCount, upper);
  }
});
test("census has zero sampling uncertainty and boundary cases remain bounded", () => {
  for (const k of [0, 1, 5, 10]) {
    const interval = finitePopulationInterval(10, 10, k);
    assert.equal(interval.lower, k / 10); assert.equal(interval.upper, k / 10);
  }
  assert.equal(planningMargin(1, 1), 0);
  assert.ok(Math.abs(planningMargin(13310, 400) - .04826) < .0001);
  assert.equal(finitePopulationInterval(13310, 400, 0).lower, 0);
  assert.equal(finitePopulationInterval(13310, 400, 400).upper, 1);
  for (const args of [[0, 0, 0], [10, 11, 2], [10, 2, 3], [10, 0, 0]]) assert.throws(() => finitePopulationInterval(...args as [number, number, number]));
});
