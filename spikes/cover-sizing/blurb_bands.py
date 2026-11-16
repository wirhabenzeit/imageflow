"""Locate each spine change on valid even page counts, using monotonic bisection."""
import urllib.request,urllib.parse,http.cookiejar,re,json,pathlib,concurrent.futures
ROOT=pathlib.Path(__file__).parent;URL='https://www.blurb.com/make/pdf_to_book/booksize_calculator'
existing=json.loads((ROOT/'blurb-samples.json').read_text())
def run(paper):
 op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()));t=op.open(URL).read().decode();token=re.search('name="authenticity_token"[^>]*value="([^"]+)',t)[1]
 cache={r['pages']:r for r in existing if r['size']=='large_square' and r['paper']==paper and r['cover']=='lithowrap'}
 def get(n):
  if n not in cache:
   data=dict(authenticity_token=token,book_type='large_square',paper_type=paper,page_count=n,cover_type='lithowrap',unit_measurement='points');t=op.open(URL,urllib.parse.urlencode(data).encode(),timeout=40).read().decode();text=re.sub(r'\s+',' ',re.sub('<[^>]+>',' ',t));start=text.find('Your Book Specifications');end=text.find('If you have Adobe',start)
   if start<0:raise ValueError((paper,n))
   cache[n]=dict(size='large_square',paper=paper,cover='lithowrap',pages=n,specification=text[start:end])
  return int(re.search(r'Gutter / Spine \(w x h\) (\d+)',cache[n]['specification'])[1])
 last=110 if 'layflat' in paper else 440 if paper=='standard' else 240
 def split(a,b):
  if b-a<=2 or get(a)==get(b):return
  m=((a+b)//4)*2
  split(a,m);split(m,b)
 split(20,last)
 bands=[];start=20;spine=get(20)
 for n in sorted(cache):
  if get(n)!=spine:
   bands.append(dict(min=start,max=n-2,spine=spine));start=n;spine=get(n)
 bands.append(dict(min=start,max=last,spine=spine))
 (ROOT/('blurb-bands-'+paper+'.json')).write_text(json.dumps(dict(paper=paper,bands=bands,samples=list(cache.values())),indent=2)+'\n');print(paper,bands,flush=True)
with concurrent.futures.ThreadPoolExecutor(3) as pool:list(pool.map(run,['standard','premium-matte','pro-uncoated-paper','pro-medium-gloss-paper','pro_uncoated_layflat','pro_photo_layflat']))
