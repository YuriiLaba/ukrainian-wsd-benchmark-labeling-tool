"""Independent exact-integer reference; Python standard library only.

Compare integer tail masses against 1/40, avoiding floating point altogether.
Run: python3 scripts/check-statistics-reference.py
"""
import math
import json


def accepted(population, sample, observed, successes, upper):
    low = max(0, sample - population + successes)
    high = min(sample, successes)
    weight = math.comb(successes, low) * math.comb(population - successes, sample - low)
    mass = 0
    for x in range(low, high + 1):
        if (upper and x >= observed) or (not upper and x <= observed):
            mass += weight
        if x < high:
            weight = weight * (successes - x) * (sample - x) // ((x + 1) * (population - successes - sample + x + 1))
    return mass * 40 >= math.comb(population, sample)


def interval(population, sample, observed):
    lo, hi = observed, population - sample + observed
    while lo < hi:
        mid = (lo + hi) // 2
        if accepted(population, sample, observed, mid, True):
            hi = mid
        else:
            lo = mid + 1
    lower = lo
    lo, hi = observed, population - sample + observed
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if accepted(population, sample, observed, mid, False):
            lo = mid
        else:
            hi = mid - 1
    return [observed, lower, lo]


if __name__ == "__main__":
    results = [interval(13310, 400, k) for k in (0, 1, 200, 350, 380, 400)]
    expected = [[0, 0, 120], [1, 1, 182], [200, 5999, 7311], [350, 11169, 12050], [380, 12302, 12896], [400, 13190, 13310]]
    assert results == expected, (results, expected)
    print(json.dumps(results, indent=2))
