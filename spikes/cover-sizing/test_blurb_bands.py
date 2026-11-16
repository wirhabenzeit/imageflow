"""Offline regressions for transition discovery and coverage requirements."""
import unittest
from blurb_bands import boundary_counts, discover_bands, validate_boundaries
from blurb_probe import combinations


class DiscoverBandsTests(unittest.TestCase):
    def test_transition_at_the_only_midpoint_is_measured(self):
        seen = []

        def get(n):
            seen.append(n)
            return 33 if n == 20 else 41

        self.assertEqual(discover_bands(get, 20, 24), [
            {'min': 20, 'max': 20, 'spine': 33},
            {'min': 22, 'max': 24, 'spine': 41},
        ])
        self.assertIn(22, seen)

    def test_every_possible_even_transition(self):
        for first_new in range(22, 62, 2):
            with self.subTest(first_new=first_new):
                seen = set()

                def get(n):
                    seen.add(n)
                    return 33 if n < first_new else 41

                bands = discover_bands(get, 20, 60)
                self.assertEqual(bands, [
                    {'min': 20, 'max': first_new - 2, 'spine': 33},
                    {'min': first_new, 'max': 60, 'spine': 41},
                ])
                self.assertTrue(set(boundary_counts(bands)) <= seen)

    def test_multiple_transitions_including_adjacent_counts(self):
        widths = {n: (33 if n < 24 else 41 if n < 26 else 54 if n < 58 else 66)
                  for n in range(20, 62, 2)}
        bands = discover_bands(widths.__getitem__, 20, 60)
        self.assertEqual(bands, [
            {'min': 20, 'max': 22, 'spine': 33},
            {'min': 24, 'max': 24, 'spine': 41},
            {'min': 26, 'max': 56, 'spine': 54},
            {'min': 58, 'max': 60, 'spine': 66},
        ])

    def test_constant_and_single_count_ranges(self):
        self.assertEqual(discover_bands(lambda n: 33, 20, 60),
                         [{'min': 20, 'max': 60, 'spine': 33}])
        self.assertEqual(discover_bands(lambda n: 33, 20, 20),
                         [{'min': 20, 'max': 20, 'spine': 33}])

    def test_decreasing_function_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Non-monotonic'):
            discover_bands(lambda n: 100 - n, 20, 60)


class BoundaryEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.paper = 'premium-matte'
        self.bands = [{'min': 20, 'max': 22, 'spine': 33},
                      {'min': 24, 'max': 28, 'spine': 41}]
        self.observed = {(size, self.paper, cover, n): band['spine']
                         for size, cover in combinations(self.paper)
                         for band in self.bands for n in (band['min'], band['max'])}

    def test_requires_both_sides_in_all_four_combinations(self):
        failures, coverage = validate_boundaries(self.paper, self.bands, self.observed)
        self.assertEqual(failures, [])
        self.assertEqual(len(coverage), 4)
        self.assertTrue(all(c['verifiedCounts'] == c['requiredCounts'] == 4 for c in coverage))
        key = ('large_format_landscape', self.paper, 'hardcover', 22)
        del self.observed[key]
        failures, _ = validate_boundaries(self.paper, self.bands, self.observed)
        self.assertEqual(failures, [(*key, 'missing boundary measurement')])

    def test_wrong_boundary_width_is_rejected(self):
        key = ('large_square', self.paper, 'lithowrap', 24)
        self.observed[key] = 33
        failures, _ = validate_boundaries(self.paper, self.bands, self.observed)
        self.assertEqual(failures, [(*key, 'boundary spine mismatch')])


if __name__ == '__main__':
    unittest.main()
