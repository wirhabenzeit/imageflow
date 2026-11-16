"""Read-only probe of Blurb's official specification calculator; standard library only."""
import urllib.request, urllib.parse, http.cookiejar, re, json, pathlib, time
URL='https://www.blurb.com/make/pdf_to_book/booksize_calculator'
ROOT=pathlib.Path(__file__).parent
op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
t=op.open(URL).read().decode(); token=re.search('name="authenticity_token"[^>]*value="([^"]+)',t)[1]
path=ROOT/'blurb-samples.json'
rows=json.loads(path.read_text()) if path.exists() else []
papers=['standard','premium-matte','pro-uncoated-paper','pro-medium-gloss-paper','pro_uncoated_layflat','pro_photo_layflat']
for size in ['large_square','large_format_landscape']:
 for paper in papers:
  for cover in ['lithowrap','hardcover']:
   if 'layflat' in paper and cover=='hardcover': continue
   for pages in [20,28,40,42,60,80,82,100,110,112,120,160,200,240]:
    if 'layflat' in paper and pages>110: continue
    key=(size,paper,cover,pages)
    if any(tuple(r[k] for k in ['size','paper','cover','pages'])==key for r in rows): continue
    data=dict(authenticity_token=token,book_type=size,paper_type=paper,page_count=pages,cover_type=cover,unit_measurement='points')
    try:
     t=op.open(URL,urllib.parse.urlencode(data).encode(),timeout=40).read().decode()
     text=re.sub(r'\s+',' ',re.sub('<[^>]+>',' ',t))
     start=text.find('Your Book Specifications');end=text.find('If you have Adobe',start)
     spec=text[start:end]
     if start<0: raise ValueError('No specification returned')
     rows.append(dict(size=size,paper=paper,cover=cover,pages=pages,specification=spec))
     path.write_text(json.dumps(rows,indent=2)+'\n')
     print(key,flush=True)
    except Exception as e: print(key,str(e),flush=True)
    time.sleep(.15)
