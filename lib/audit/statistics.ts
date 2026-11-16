// Equal-tailed test inversion for a fixed population. These are confidence
// bounds for K / N, NOT quantiles of a hypergeometric prediction distribution.
function logAdd(a: number, b: number) {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const hi = Math.max(a, b);
  return hi + Math.log1p(Math.exp(Math.min(a, b) - hi));
}

export function hypergeomTails(N: number, K: number, n: number, k: number) {
  const low = Math.max(0, n - (N - K)), high = Math.min(n, K);
  // Unnormalised log probabilities via adjacent-mass recurrence: no factorial
  // cancellation even for a large population or probabilities close to zero.
  let logWeight = 0, total = -Infinity, lower = -Infinity, upper = -Infinity;
  for (let x = low; x <= high; x++) {
    total = logAdd(total, logWeight);
    if (x <= k) lower = logAdd(lower, logWeight);
    if (x >= k) upper = logAdd(upper, logWeight);
    if (x < high) logWeight += Math.log(K - x) + Math.log(n - x) - Math.log(x + 1) - Math.log(N - K - n + x + 1);
  }
  return { lower: Math.exp(lower - total), upper: Math.exp(upper - total) };
}

export function finitePopulationInterval(N: number, n: number, k: number) {
  if (![N, n, k].every(Number.isInteger) || N < 1 || n < 1 || n > N || k < 0 || k > n) throw new Error("Invalid finite population counts");
  const minK = k, maxK = N - n + k, tail = 0.025;
  let lo = minK, hi = maxK;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (hypergeomTails(N, mid, n, k).upper >= tail) hi = mid;
    else lo = mid + 1;
  }
  const lowerCount = lo;
  lo = minK; hi = maxK;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (hypergeomTails(N, mid, n, k).lower >= tail) lo = mid;
    else hi = mid - 1;
  }
  return { lower: lowerCount / N, upper: lo / N, lowerCount, upperCount: lo, confidence: 0.95, method: "exact-equal-tailed-hypergeometric-inversion" };
}

export function planningMargin(N: number, n: number) {
  return n === N ? 0 : 1.959963984540054 * Math.sqrt(0.25 / n * (N - n) / (N - 1));
}
