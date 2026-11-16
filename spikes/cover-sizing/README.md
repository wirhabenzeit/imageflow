# Cover sizing for the Kyrgyzstan formats

Research dated 16 November 2026. Automatic cover sizing is feasible for all five print formats in the Kyrgyzstan template. WhiteWall's exact cover dimensions and spine guides can be reproduced from three stepped formulas. Blurb exposes exact dimensions through its calculator; its spine tables depend on paper, with different tables for the two layflat papers.

The book and its template were inspected without changing them. Its format IDs are `blurb33x28`, `blurb30x30`, `whitewallPortfolioPortrait`, `landscape`, and `square`. The current nine-page draft is below the printers' minimum page counts; this research uses valid hypothetical final page counts.

## WhiteWall

Source: the [PDF upload workflow](https://www.whitewall.com/us/coffee-table-book/pdf-upload), its public [Printbox product configuration](https://whitewall-pbx2.getprintbox.com/api/editor/product-families/21/) (request headers `X-Version: v6`, `X-Pbx-Store-Name: store_DE`), and the official downloadable IDML templates linked by that configuration. `probe_whitewall.py` retrieves configuration and extracts physical dimensions and guides directly from each template. No account or project creation is needed.

Let N be the interior page count, in steps of four. All dimensions below are millimetres. These are recovered formulas, validated against template outputs, rather than published manufacturer formulas:

- Fedrigoni Symbol Freelife Gloss, with or without high gloss varnish: S = 8.2 + 1.1 × floor((N − 28) / 16).
- Sappi Magno Volume silk-matt: S = 8.4 + 1.5 × floor((N − 28) / 16).
- Fuji Crystal Archive Glossy, Lustre or Velvet: S = 11 + 1.5 × floor((N − 28) / 8).

S is spine width. The first two formulas apply for 28–200 pages. Photo papers apply for 28–112 in Gallery Square and 28–100 in Portfolio landscape. The current configuration offers no photo-paper combination for Portfolio portrait.

| Format | Cover panel width | Cover trim height | Horizontal bleed per edge | Vertical bleed per edge |
| --- | ---: | ---: | ---: | ---: |
| Gallery Square | 296 | 296 | 10 | 10 |
| Portfolio portrait | 276 | 362 | 10 | 10 |
| Portfolio landscape | 389 | 296 | 15 | 10 |

Cover trim width = 2 × panel width + S. Export width adds both horizontal bleed edges; export height adds both vertical bleed edges. In particular, landscape has a 389 mm cover panel despite its 382 mm interior width. Do not derive cover panels solely by adding the same allowance to every interior format.

The six vertical template guides occur at P−2, P, P+2, P+S−2, P+S, P+S+2, where P is the panel width. The middle line in each group is a spine boundary, with 2 mm guides on either side. Coordinates are relative to the cover trim's left edge. Other hinge/fold avoidance regions require separate treatment: WhiteWall describes the fold as extending 10–12 mm onto the covers in its [design instructions](https://www.whitewall.com/us/coffee-table-book/pdf-upload).

WhiteWall's [design guidance](https://service.whitewall.com/hc/en-us/articles/4411236486929-04-Notes-on-design) specifies a 5 mm safety margin inside page or cover edges and at least 2 mm from spine edges for text. The example applies that spine inset on all four edges. The [upload instructions](https://service.whitewall.com/hc/en-us/articles/4411222671249-06-Uploading-the-PDF-files) limit the cover PDF to 250 MB; the example uses a conservative decimal cap of 250,000,000 bytes. These requirements come from the documentation rather than the IDML dimension extraction.

The example declares a 12 mm `foldAvoidance` band on each panel next to the spine, using the upper end of WhiteWall's published 10–12 mm range as a conservative content warning. It does not add to the sheet dimensions or assert that every physical hinge is exactly 12 mm wide.

The configuration offers glossy, silk-matt and printed-linen hardcover finishes. All three finishes, and both black and white endpapers, link to the same cover template for a given size, paper and page count. These options therefore do not alter the template geometry in the current configuration. There are no dust-jacket flap options in this configuration.

`whitewall-options.json` preserves the available combinations and page ranges. `whitewall-samples.json` preserves each template URL, extracted trim dimensions, bleed and guides. `analysis.json` is generated output: `analyze.py` regenerates its derived export dimensions, validation result and Blurb boundary coverage. The 519 unique templates cover every linked valid page count for all three sizes and all available papers; all match the formulas and guides within 0.00001 mm. This validates consistency with official templates, not successful acceptance by the live PDF uploader.

## Blurb

Source: [official specification calculator](https://www.blurb.com/make/pdf_to_book/booksize_calculator). `probe_blurb.py` submits read-only measurement requests for both sizes, six paper choices and available hardcover constructions. `blurb_bands.py` locates spine changes on even page counts by bisection; this assumes nondecreasing spine width within each paper profile. It measures both endpoints before stopping recursion, then explicitly verifies both sides of every discovered change and the minimum/maximum counts across every supported size/binding combination. These boundary observations are required by the offline validator, independently of the probe's verification metadata.

Blurb's [published page-count limits](https://support.blurb.com/hc/en-us/articles/7607055286541-How-many-pages-can-my-book-have) separately confirm 20–440 pages for Standard photo-book paper, 20–240 for Premium and non-layflat Mohawk papers, and 20–110 for both layflat papers. The exception for Mini photo books does not apply to these two large formats. These are documented product limits, not limits inferred solely from calculator responses.

Large Square and Large Landscape offer ImageWrap and dust-jacket hardcovers. Softcover is explicitly unavailable at these sizes. Layflat uses ImageWrap. Standard, Premium, Superfine Eggshell, proPhoto Pearl, and the two layflat papers must be treated as distinct inputs even where their tables coincide.

Let S be the printer's spine width in points. The sampled calculator outputs have these export dimensions:

| Format | ImageWrap PDF | Dust jacket PDF | Jacket flap width |
| --- | --- | --- | ---: |
| Large Square | (1760 + S) × 918 pt | (1776 + S + 2F) × 882 pt | F = floor((601 − S) / 2) pt |
| Large Landscape | (1880 + S) × 837 pt | (1880 + S + 2F) × 801 pt | F = ceil((639 − S) / 2) pt |

Dust-jacket flaps shrink as the spine grows, keeping the total jacket width almost constant. Integer-point rounding makes the width vary by 1 pt. This is an important difference from ImageWrap: increasing page count does not simply increase the outer jacket width.

ImageWrap has 22 pt bleed/wrap on each outer edge; dust jackets have 9 pt. Both specify an 18 pt safe inset. ImageWrap trim dimensions follow by subtracting 44 pt from each PDF dimension; jacket trim dimensions subtract 18 pt. Treat the calculator's dimensions as authoritative, including its rounding, rather than deriving the wrap from nominal book size.

The recovered sheet, trim, flap and spine rules match 474 distinct calculator configurations with zero mismatches. The same per-paper transition tables were verified at both sides of every change across all 20 supported paper/size/binding combinations: four combinations per non-layflat paper, and both ImageWrap sizes per layflat paper. Boundary discovery still assumes nondecreasing spine width; intermediate equal-width intervals were not exhaustively queried. PDF upload acceptance has not been tested.

The original bisection probe stopped before measuring adjacent endpoints, allowing an unmeasured midpoint to shift a transition by two pages. The corrected tables move Standard transitions to 148 and 370 pages; the last Premium, Superfine Eggshell and proPhoto Pearl transitions to 202; Superfine Eggshell Layflat transitions to 84 and 96; and a proPhoto Pearl Layflat transition to 44. The validator now fails if endpoint evidence is absent, rather than accepting agreement only on the samples that happen to exist.

The spine observations are in `blurb-samples.json`, grouped in `analysis.json`. The additional `blurb-bands-*.json` files contain the recovered intervals and their supporting calculator responses, up to 440 pages for Standard, 240 for other bound papers and 110 for layflat. A profile must reject counts outside its range. The two layflat papers differ substantially; a generic layflat coefficient is insufficient.

| Paper | Even page intervals → spine width in pt |
| --- | --- |
| Standard | 20–72 → 33; 74–146 → 41; 148–220 → 54; 222–294 → 66; 296–368 → 79; 370–440 → 89 |
| Premium lustre or matte | 20–50 → 33; 52–100 → 41; 102–160 → 54; 162–200 → 66; 202–240 → 79 |
| Superfine Eggshell | 20–40 → 33; 42–80 → 41; 82–120 → 54; 122–160 → 66; 162–200 → 79; 202–240 → 89 |
| proPhoto Pearl | 20–40 → 33; 42–80 → 41; 82–120 → 54; 122–160 → 66; 162–200 → 79; 202–240 → 89 |
| Superfine Eggshell Layflat | 20–34 → 40; 36–50 → 54; 52–62 → 71; 64–68 → 81; 70–82 → 94; 84–94 → 110; 96–110 → 137 |
| proPhoto Pearl Layflat | 20–34 → 40; 36–42 → 53; 44–52 → 63; 54–62 → 81; 64–80 → 104; 82–92 → 110; 94–98 → 122; 100–110 → 144 |

See the [draft template data model](data-model.md) for a concrete declaration proposal, types and examples.

## Implications for ImageFlow

Resolve cover geometry at book level from printer, size, paper, binding and final interior page count. The resolver should return a complete physical sheet plus named front, back, spine and optional flap regions, outer allowances and safety guides. Templates can then anchor front-cover content to its panel and spine content to its centre independently of page-count changes.

Keep cover and interior delivery specifications separate. Both printers support a separate cover PDF and single-page interior PDF; WhiteWall's cover allowances differ from its interior's three-edge bleed. Cover pages should not increase the interior count used to calculate the spine.

The current Kyrgyzstan template copies WhiteWall's 28–112 step-four restriction into all five formats. Paper-specific constraints belong in the print profile: WhiteWall landscape photo paper stops at 100, inkjet reaches 200, and Blurb accepts even page counts with its own paper-dependent limits.

Use versioned, offline geometry profiles and retain the source measurements as regression fixtures. Recheck representative configurations against the official tools before releasing a profile or placing a real order. A manual spine or custom-specification override is useful for unsupported products, but ordinary supported configurations need no manual spread dimensions.

## Reproducing the research

Run `python3 spikes/cover-sizing/probe_whitewall.py`, `python3 spikes/cover-sizing/probe_blurb.py`, `python3 spikes/cover-sizing/blurb_bands.py`, then `python3 spikes/cover-sizing/analyze.py`. The probes use Python's standard library. Cached measurements are reused in `blurb-samples.json`; `blurb_probe.py` supplies the shared calculator client and writes each successful observation atomically. Request or parse failures stop the probe with an error instead of silently producing partial success. The band files retain the baseline observations plus a verification manifest for each size/binding pair. These are research utilities, not application integration or a live printer API dependency.


For offline verification without querying either printer:

```sh
python3 spikes/cover-sizing/probe_blurb.py --offline
python3 spikes/cover-sizing/blurb_bands.py --offline
python3 -m unittest discover -s spikes/cover-sizing -p 'test_*.py'
python3 spikes/cover-sizing/analyze.py
```

The regression tests cover a change at the only midpoint of a four-page interval, every possible even transition in a test domain, adjacent changes, constant ranges, and rejection of missing or incorrect boundary evidence. Offline band verification must find both endpoints of every recovered band for every supported size/binding pair in the cache. `analyze.py` also checks PDF-to-trim differences and reports missing or overlapping spine bands explicitly.

The probe retries transient HTTP statuses (408, 429, 500, 502, 503 and 504) and transport failures up to three attempts. Permanent HTTP errors fail immediately. A response explicitly reporting an invalid or expired CSRF/authenticity token triggers one form/token refresh and one resubmission; unrelated 403/422 errors are not retried. Tokens rotated in successful responses are carried forward. `test_probe_client.py` verifies these paths with mocked responses without contacting Blurb.

`whitewall_rules.py` names all six supported papers explicitly and rounds the recovered millimetre values to three decimal places. Unknown papers raise an error. The TypeScript example applies the same normalization after its formula; printer-specific point rounding remains in the Blurb example before conversion to millimetres.
