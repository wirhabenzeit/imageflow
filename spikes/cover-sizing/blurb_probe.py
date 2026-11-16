"""Shared, cached access to Blurb's read-only specification calculator."""
import http.cookiejar
import json
from pathlib import Path
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).parent
URL = 'https://www.blurb.com/make/pdf_to_book/booksize_calculator'
PAPERS = ('standard', 'premium-matte', 'pro-uncoated-paper',
          'pro-medium-gloss-paper', 'pro_uncoated_layflat', 'pro_photo_layflat')
SIZES = ('large_square', 'large_format_landscape')


def maximum_pages(paper):
    if paper not in PAPERS:
        raise ValueError(f'Unknown Blurb paper: {paper}')
    return 110 if 'layflat' in paper else 440 if paper == 'standard' else 240


def combinations(paper):
    covers = ('lithowrap',) if 'layflat' in paper else ('lithowrap', 'hardcover')
    return [(size, cover) for size in SIZES for cover in covers]


def sample_key(row):
    return tuple(row[k] for k in ('size', 'paper', 'cover', 'pages'))


def spine_width(row):
    match = re.search(r'Gutter / Spine \(w x h\) (\d+)', row['specification'])
    if not match:
        raise ValueError(f'Missing spine measurement for {sample_key(row)}')
    return int(match[1])


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


class Client:
    def __init__(self, opener=None):
        self.opener = opener if opener is not None else urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.refresh_token()

    def refresh_token(self):
        text = self.request().decode()
        token = self.read_token(text)
        if token is None:
            raise ValueError('Calculator form has no authenticity token')
        self.token = token

    @staticmethod
    def read_token(text):
        match = re.search(r'name="authenticity_token"[^>]*value="([^"]+)', text)
        return match[1] if match else None

    @staticmethod
    def expired_token(text):
        return bool(re.search(
            r'InvalidAuthenticityToken|(?:invalid|expired) (?:CSRF|authenticity) token'
            r'|(?:CSRF|authenticity) token (?:is )?(?:invalid|expired)', text, re.IGNORECASE))

    def request(self, data=None):
        for attempt in range(3):
            try:
                with self.opener.open(URL, data, timeout=40) as response:
                    return response.read()
            except urllib.error.HTTPError as error:
                # HTTPError is also a URLError: don't retry permanent 4xx here.
                if error.code not in (408, 429, 500, 502, 503, 504) or attempt == 2:
                    raise
                error.close()
                time.sleep(attempt + 1)
            except (urllib.error.URLError, TimeoutError):
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)

    def fetch(self, size, paper, cover, pages):
        for attempt in range(2):
            data = dict(authenticity_token=self.token, book_type=size, paper_type=paper,
                        page_count=pages, cover_type=cover, unit_measurement='points')
            try:
                text = self.request(urllib.parse.urlencode(data).encode()).decode()
            except urllib.error.HTTPError as error:
                if error.code not in (403, 422) or attempt:
                    raise
                if not self.expired_token(error.read().decode(errors='replace')):
                    raise
                error.close()
                self.refresh_token()
                continue
            if 'Your Book Specifications' not in text and self.expired_token(text):
                if attempt:
                    raise ValueError('Calculator rejected the refreshed authenticity token')
                self.refresh_token()
                continue
            self.token = self.read_token(text) or self.token
            break
        text = re.sub(r'\s+', ' ', re.sub('<[^>]+>', ' ', text))
        start = text.find('Your Book Specifications')
        end = text.find('If you have Adobe', start)
        if start < 0 or end < 0:
            raise ValueError(f'No specification returned for {(size, paper, cover, pages)}')
        specification = text[start:end]
        if not re.search(rf'\b{pages} pages Page Specifications', specification):
            raise ValueError(f'Unexpected page count for {(size, paper, cover, pages)}')
        row = dict(size=size, paper=paper, cover=cover, pages=pages,
                   specification=specification)
        spine_width(row)
        return row


class Samples:
    def __init__(self, root=ROOT, offline=False):
        self.root = root
        self.offline = offline
        self.lock = threading.Lock()
        self.rows = {}
        path = root / 'blurb-samples.json'
        sources = [json.loads(path.read_text())] if path.exists() else []
        sources += [json.loads(p.read_text())['samples']
                    for p in sorted(root.glob('blurb-bands-*.json'))]
        for rows in sources:
            for row in rows:
                key = sample_key(row)
                if key in self.rows and self.rows[key] != row:
                    raise ValueError(f'Conflicting cached measurements for {key}')
                self.rows[key] = row

    def get(self, size, paper, cover, pages, client):
        key = (size, paper, cover, pages)
        if (size, cover) not in combinations(paper) or pages < 20 or pages > maximum_pages(paper) or pages % 2:
            raise ValueError(f'Unsupported calculator configuration: {key}')
        with self.lock:
            if key in self.rows:
                return self.rows[key]
        if self.offline:
            raise ValueError(f'Missing cached measurement for {key}')
        row = client.fetch(*key)
        with self.lock:
            self.rows[key] = row
            write_json(self.root / 'blurb-samples.json',
                       [self.rows[k] for k in sorted(self.rows)])
        return row
