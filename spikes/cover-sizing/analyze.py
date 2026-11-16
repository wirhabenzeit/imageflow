"""Validate WhiteWall templates and Blurb calculator outputs and boundary evidence."""
import json,pathlib,re,collections,math
from blurb_probe import PAPERS, Samples, maximum_pages
from blurb_bands import validate_boundaries
from whitewall_rules import spine_width_mm
ROOT=pathlib.Path(__file__).parent
rows=json.loads((ROOT/'whitewall-samples.json').read_text());errors=[]
summary=[]
for r in rows:
 size,paper,n=r['url'].rsplit('/',1)[1][6:-5].split('_');n=int(n)
 spine=spine_width_mm(paper,n)
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
 observations=list(Samples(offline=True).rows.values())
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
  if sample['pdf']!=(base+sample['spine'],height):checks.append((group['size'],group['paper'],group['cover'],sample['pages'],'sheet'))
  inset=44 if wrap else 18
  if sample['trim']!=tuple(v-inset for v in sample['pdf']):checks.append((group['size'],group['paper'],group['cover'],sample['pages'],'trim'))
  if group['paper'] in bands:
   matching=[b for b in bands[group['paper']]['bands'] if b['min']<=sample['pages']<=b['max']]
   if len(matching)!=1:checks.append((group['size'],group['paper'],group['cover'],sample['pages'],'expected exactly one spine band',len(matching)))
   elif sample['spine']!=matching[0]['spine']:checks.append((group['size'],group['paper'],group['cover'],sample['pages'],'spine'))
# Verify raw evidence rather than trusting the probe's verification metadata.
# Missing both sides of a boundary must fail even when every sampled width fits.
observed={(g['size'],g['paper'],g['cover'],r['pages']):r['spine']
          for g in result.get('blurb',[]) for r in g['samples']}
boundaries=[]
for paper in PAPERS:
 if paper not in bands:
  checks.append((paper,'missing spine table'))
  continue
 table=bands[paper]['bands']
 for n in range(20,maximum_pages(paper)+1,2):
  if sum(b['min']<=n<=b['max'] for b in table)!=1:checks.append((paper,n,'incomplete or overlapping table'))
 failures,coverage=validate_boundaries(paper,table,observed)
 checks.extend(failures)
 boundaries.extend(coverage)
result['blurbValidation']={'failures':checks,'bandsAvailable':sorted(bands),'boundaries':boundaries}
(ROOT/'analysis.json').write_text(json.dumps(result,indent=2)+'\n')
print('WhiteWall:',len(rows),'templates;',len(errors),'rule mismatches')
print('Blurb:',sum(len(g['samples']) for g in result.get('blurb',[])),'samples')

print("Blurb geometry and spine mismatches:",len(checks))
raise SystemExit(bool(errors or checks))
