"""Validate recovered WhiteWall rules against every downloaded template."""
import json,pathlib,re,collections,math
ROOT=pathlib.Path(__file__).parent
rows=json.loads((ROOT/'whitewall-samples.json').read_text());errors=[]
summary=[]
for r in rows:
 size,paper,n=r['url'].rsplit('/',1)[1][6:-5].split('_');n=int(n)
 if paper.startswith('paper-fuji'): spine=11+1.5*math.floor((n-28)/8)
 elif paper=='paper-digital-matte':spine=8.4+1.5*math.floor((n-28)/16)
 else:spine=8.2+1.1*math.floor((n-28)/16)
 panel,height,bleedx={'A3square':(296,296,10),'A3portrait':(276,362,10),'A3landscape':(389,296,15)}[size]
 expected={'trimWidth':2*panel+spine,'trimHeight':height,'guides':[panel-2,panel,panel+2,panel+spine-2,panel+spine,panel+spine+2]}
 for key,v in expected.items():
  vals=zip(v,r[key]) if isinstance(v,list) else [(v,r[key])]
  if any(abs(a-b)>1e-5 for a,b in vals):errors.append((r['url'],key,v,r[key]))
 if r['bleed']!={'Top':10,'Bottom':10,'InsideOrLeft':bleedx,'OutsideOrRight':bleedx}:errors.append((r['url'],'bleed'))
 summary.append(dict(size=size,paper=paper,pages=n,spine=round(spine,3),pdfWidth=round(2*panel+spine+2*bleedx,3),pdfHeight=height+20))
result={'whitewall':{'samples':len(rows),'failures':errors,'dimensions':summary}}
if (ROOT/'blurb-samples.json').exists():
 groups=collections.defaultdict(list)
 observations=json.loads((ROOT/'blurb-samples.json').read_text())
 for path in ROOT.glob('blurb-bands-*.json'):observations.extend(json.loads(path.read_text())['samples'])
 observations=list({(r['size'],r['paper'],r['cover'],r['pages']):r for r in observations}.values())
 for r in observations:
  s=r['specification'].split('Cover Specifications')[1]
  dims=[tuple(map(int,m)) for m in re.findall(r'(\d+) x (\d+)',s)]
  groups[(r['size'],r['paper'],r['cover'])].append(dict(pages=r['pages'],pdf=dims[0],trim=dims[1],spine=dims[-1][0],flap=(dims[2][0] if len(dims)==4 else None)))
 result['blurb']=[dict(size=k[0],paper=k[1],cover=k[2],samples=sorted(v,key=lambda r:r['pages'])) for k,v in groups.items()]
bands={json.loads(p.read_text())['paper']:json.loads(p.read_text()) for p in ROOT.glob('blurb-bands-*.json')}
checks=[]
for group in result.get('blurb',[]):
 for sample in group['samples']:
  square=group['size']=='large_square';wrap=group['cover']=='lithowrap'
  base,height=(1760,918) if square and wrap else (1776,882) if square else (1880,837) if wrap else (1880,801)
  if not wrap:
   flap=(math.floor if square else math.ceil)(((601 if square else 639)-sample['spine'])/2)
   if sample['flap']!=flap:checks.append((group['size'],group['paper'],sample['pages'],'flap'))
   base+=2*flap
  if sample['pdf']!= (base+sample['spine'],height) and list(sample['pdf'])!=[base+sample['spine'],height]:checks.append((group['size'],group['paper'],group['cover'],sample['pages'],'sheet'))
  if group['paper'] in bands:
   band=next(b for b in bands[group['paper']]['bands'] if b['min']<=sample['pages']<=b['max'])
   if sample['spine']!=band['spine']:checks.append((group['size'],group['paper'],group['cover'],sample['pages'],'spine'))
result['blurbValidation']={'failures':checks,'bandsAvailable':list(bands)}
(ROOT/'analysis.json').write_text(json.dumps(result,indent=2)+'\n')
print('WhiteWall:',len(rows),'templates;',len(errors),'rule mismatches')
print('Blurb:',sum(len(g['samples']) for g in result.get('blurb',[])),'samples')

print("Blurb geometry and spine mismatches:",len(checks))
raise SystemExit(bool(errors or checks))
