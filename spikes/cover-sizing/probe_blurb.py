"""Collect representative Blurb calculator outputs; failures stop the probe."""
import argparse
from blurb_probe import Client, PAPERS, Samples, combinations, maximum_pages


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true', help='Require cached observations; make no requests.')
    args = parser.parse_args()
    samples = Samples(offline=args.offline)
    client = None if args.offline else Client()
    for paper in PAPERS:
        for size, cover in combinations(paper):
            for pages in [20, 28, 40, 42, 60, 80, 82, 100, 110, 112, 120, 160, 200, 240]:
                if pages <= maximum_pages(paper):
                    samples.get(size, paper, cover, pages, client)
    print(f'Cached {len(samples.rows)} distinct Blurb configurations.')


if __name__ == '__main__':
    main()
