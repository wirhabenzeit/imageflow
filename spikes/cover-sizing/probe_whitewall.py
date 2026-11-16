"""Extract exact cover dimensions and guides from WhiteWall's public IDML templates."""
import urllib.request,json,zipfile,io,xml.etree.ElementTree as E,pathlib,concurrent.futures
ROOT=pathlib.Path(__file__).parent
req=urllib.request.Request('https://whitewall-pbx2.getprintbox.com/api/editor/product-families/21/',headers={'X-Version':'v6','X-Pbx-Store-Name':'store_DE'})
family=json.load(urllib.request.urlopen(req)); attrs={a['id']:a for a in family['attributes']}
configs=[v for v in attrs['Product_config']['values'] if v['id'].startswith(('A3square_','A3portrait_','A3landscape_'))]
(ROOT/'whitewall-options.json').write_text(json.dumps(configs,indent=2)+'\n')
urls={f['value'] for v in attrs['pagesUrls']['values'] if v['id'].split('_',1)[1].startswith(('A3square_','A3portrait_','A3landscape_')) for f in v['additionalFields'] if f['id']=='coverURL'}
# All available page counts, six papers, three sizes; cover finishes share template URLs.
path=ROOT/'whitewall-samples.json';rows=json.loads(path.read_text()) if path.exists() else []
def get(url):
 z=zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(url,timeout=30).read()));r=E.fromstring(z.read('Resources/Preferences.xml'));p=r.find('DocumentPreference').attrib
 mm=lambda x:round(float(x)*25.4/72,6)
 result={'url':url,'trimWidth':mm(p['PageWidth']),'trimHeight':mm(p['PageHeight']),'bleed':{k:mm(p['DocumentBleed'+k+'Offset']) for k in ['Top','Bottom','InsideOrLeft','OutsideOrRight']}}
 result['guides']=sorted(set(mm(e.attrib['Location']) for f in z.namelist() if f.startswith('Spreads/') for e in E.fromstring(z.read(f)).iter('Guide') if e.attrib['Orientation']=='Vertical'))
 return result
pending=sorted(urls-{r['url'] for r in rows});print('templates',len(urls),'pending',len(pending),flush=True)
with concurrent.futures.ThreadPoolExecutor(3) as pool:
 for row in pool.map(get,pending):
  rows.append(row);path.write_text(json.dumps(rows,indent=2)+'\n');print(row['url'].split('/')[-1],flush=True)
