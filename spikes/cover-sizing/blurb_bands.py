"""Recover spine bands and verify both sides of every change across constructions."""
import argparse
import concurrent.futures
from blurb_probe import (Client, PAPERS, ROOT, Samples, combinations, maximum_pages,
                         spine_width, write_json)


def discover_bands(get, minimum, maximum, step=2):
    """Recover a nondecreasing step function; measure endpoints BEFORE stopping."""
    measured = {}

    def value(n):
        if n not in measured:
            measured[n] = get(n)
        return measured[n]

    def split(a, b):
        left, right = value(a), value(b)
        if left > right:
            raise ValueError(f'Non-monotonic spine widths at {a} and {b}')
        if b - a <= step or left == right:
            return
        midpoint = a + ((b - a) // step // 2) * step
        split(a, midpoint)
        split(midpoint, b)

    split(minimum, maximum)
    bands = []
    start, previous_n, previous_width = minimum, minimum, measured[minimum]
    for n, width in sorted(measured.items()):
        if width != previous_width:
            if n - previous_n != step:
                raise ValueError(f'Unproven transition between {previous_n} and {n}')
            bands.append(dict(min=start, max=previous_n, spine=previous_width))
            start = n
        previous_n, previous_width = n, width
    bands.append(dict(min=start, max=maximum, spine=previous_width))
    return bands


def boundary_counts(bands):
    return sorted({n for band in bands for n in (band['min'], band['max'])})


def validate_boundaries(paper, bands, observed):
    """Require raw observations at every band endpoint for each supported pair."""
    failures, coverage = [], []
    for size, cover in combinations(paper):
        verified = 0
        for band in bands:
            for n in sorted({band['min'], band['max']}):
                key = (size, paper, cover, n)
                if key not in observed:
                    failures.append((*key, 'missing boundary measurement'))
                elif observed[key] != band['spine']:
                    failures.append((*key, 'boundary spine mismatch'))
                else:
                    verified += 1
        coverage.append(dict(size=size, paper=paper, cover=cover, verifiedCounts=verified,
                             requiredCounts=len(boundary_counts(bands))))
    return failures, coverage


def recover(paper, samples):
    client = None if samples.offline else Client()
    get = lambda n: spine_width(samples.get('large_square', paper, 'lithowrap', n, client))
    bands = discover_bands(get, 20, maximum_pages(paper))
    # Explicitly confirm endpoints even when an equal-width interval was pruned.
    # Other size/binding combinations are independently checked at these counts.
    verified = []
    for size, cover in combinations(paper):
        for band in bands:
            for n in sorted({band['min'], band['max']}):
                row = samples.get(size, paper, cover, n, client)
                if spine_width(row) != band['spine']:
                    raise ValueError(f'Shared table mismatch: {(size, paper, cover, n)}')
        verified.append(dict(size=size, cover=cover, counts=boundary_counts(bands)))
    with samples.lock:
        baseline = [row for key, row in sorted(samples.rows.items())
                    if key[:3] == ('large_square', paper, 'lithowrap')]
    write_json(ROOT / f'blurb-bands-{paper}.json', dict(
        paper=paper, bands=bands, samples=baseline, boundaryVerification=verified))
    print(paper, bands, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true', help='Require cached observations; make no requests.')
    args = parser.parse_args()
    samples = Samples(offline=args.offline)
    with concurrent.futures.ThreadPoolExecutor(3) as pool:
        list(pool.map(lambda paper: recover(paper, samples), PAPERS))


if __name__ == '__main__':
    main()
