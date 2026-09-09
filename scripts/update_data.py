#!/usr/bin/env python3
"""勝どき安全サイネージ用。VPWS50から強風・波浪注意報も取得する。"""
import gzip, json, re, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

LAT, LON = 35.654369, 139.774947
OUT = Path(__file__).resolve().parents[1] / 'data' / 'current.json'
WEATHER = ('https://api.open-meteo.com/v1/forecast'
 f'?latitude={LAT}&longitude={LON}'
 '&current=temperature_2m,precipitation,weather_code,wind_speed_10m'
 '&hourly=precipitation_probability&daily=temperature_2m_min,sunset'
 '&timezone=Asia%2FTokyo&forecast_days=2')
FORECAST = 'https://www.jma.go.jp/bosai/forecast/data/forecast/130000.json'
REGULAR_FEED = 'https://www.data.jma.go.jp/developer/xml/feed/regular.xml'
EXTRA_FEED = 'https://www.data.jma.go.jp/developer/xml/feed/extra.xml'
TARGET_CODES = {'130010'}
TARGET_NAMES = {'東京地方'}
FORECAST_AREA_CODE = '130010'

DEFAULT_WARNINGS = {
 'dry': False, 'thunder': False, 'thunderForecast': False,
 'heavyRain': False, 'strongWindAdvisory': False,
 'wave': False, 'waveAdvisory': False, 'storm': False,
 'stormSurge': False, 'stormSurgeAdvisory': False,
}
INDIVIDUAL_TYPES = {
 'VPWW55': ('heavyRain',),
 'VPWW57': ('stormSurge', 'stormSurgeAdvisory'),
 'VPWW58': ('storm', 'strongWindAdvisory'),
 'VPWW59': ('wave', 'waveAdvisory'),
 'VPWW61': ('thunder', 'dry'),
}
ALL_OFFICIAL_FLAGS = tuple(k for k in DEFAULT_WARNINGS if k != 'thunderForecast')
URL_RE = re.compile(r'https://www\.data\.jma\.go\.jp/developer/xml/data/(\d{14})_\d+_([A-Z0-9]+)_(\d{6})\.xml')


def request_bytes(url):
 sep = '&' if '?' in url else '?'
 req = urllib.request.Request(url + f'{sep}_={int(datetime.now(timezone.utc).timestamp())}',
  headers={'User-Agent':'kachidoki-safety-signage/4.1','Accept':'application/xml,application/json,*/*','Cache-Control':'no-cache','Pragma':'no-cache'})
 with urllib.request.urlopen(req, timeout=30) as res: raw=res.read()
 return gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw


def get_json(url): return json.loads(request_bytes(url).decode('utf-8'))
def lname(el): return el.tag.rsplit('}',1)[-1]
def child_text(el,name):
 for c in el:
  if lname(c)==name: return (c.text or '').strip()
 return ''


def latest_url(feed, typ, area):
 found=[(ts,f'https://www.data.jma.go.jp/developer/xml/data/{ts}_0_{t}_{a}.xml') for ts,t,a in URL_RE.findall(feed.decode('utf-8','replace')) if t==typ and a==area]
 return max(found,key=lambda x:x[0]) if found else None


def latest_individual(feed):
 latest={}
 for ts,t,a in URL_RE.findall(feed.decode('utf-8','replace')):
  if a=='130000' and t in INDIVIDUAL_TYPES and (t not in latest or ts>latest[t][0]):
   latest[t]=(ts,f'https://www.data.jma.go.jp/developer/xml/data/{ts}_0_{t}_{a}.xml')
 return latest


def area_matches(item):
 for el in item.iter():
  if lname(el)=='Area':
   if child_text(el,'Code') in TARGET_CODES or child_text(el,'Name') in TARGET_NAMES: return True
 return False


def name_to_flags(name):
 flags=set()
 if '雷' in name: flags.add('thunder')
 if '乾燥' in name: flags.add('dry')
 if '大雨' in name and '警報' in name: flags.add('heavyRain')
 if '強風注意報' in name: flags.add('strongWindAdvisory')
 if '暴風' in name and '警報' in name: flags.add('storm')
 if '波浪' in name:
  if '注意報' in name and '警報' not in name: flags.add('waveAdvisory')
  elif '警報' in name: flags.add('wave')
 if '高潮' in name:
  if '注意報' in name and '警報' not in name: flags.add('stormSurgeAdvisory')
  elif '警報' in name: flags.add('stormSurge')
 return flags


def parse_warning_xml(raw, allowed, allow_empty_status=False):
 root=ET.fromstring(raw); active=set(); names=[]; report=''
 for el in root.iter():
  if lname(el)=='ReportDateTime' and el.text: report=el.text.strip(); break
 inactive={'解除','なし','発表警報・注意報はなし','警報・注意報はなし'}
 for item in (e for e in root.iter() if lname(e)=='Item'):
  if not area_matches(item): continue
  for kind in (e for e in item.iter() if lname(e)=='Kind'):
   name,status=child_text(kind,'Name'),child_text(kind,'Status')
   if not name or status in inactive or (not status and not allow_empty_status): continue
   flags=name_to_flags(name)&set(allowed)
   if flags: active|=flags; names.append(name)
 return active,list(dict.fromkeys(names)),report


def load_previous():
 try: return json.loads(OUT.read_text(encoding='utf-8')).get('warnings',{})
 except Exception: return {}


def fetch_warnings(previous):
 result=dict(DEFAULT_WARNINGS)
 for k in result:
  if k in previous: result[k]=bool(previous[k])
 debug={'aggregate':None,'reports':[],'error':None}
 agg=latest_url(request_bytes(REGULAR_FEED),'VPWS50','010000')
 if agg:
  _,url=agg; flags,names,dt=parse_warning_xml(request_bytes(url),ALL_OFFICIAL_FLAGS,True)
  for k in ALL_OFFICIAL_FLAGS: result[k]=k in flags
  debug['aggregate']={'type':'VPWS50','reportDateTime':dt,'activeNames':names,'sourceFile':url.rsplit('/',1)[-1],'emptyStatusAccepted':True,'resultLocked':True}
  return result,debug
 debug['aggregate']={'error':'VPWS50_NOT_FOUND'}
 for typ,(_,url) in sorted(latest_individual(request_bytes(EXTRA_FEED)).items()):
  allowed=INDIVIDUAL_TYPES[typ]; flags,names,dt=parse_warning_xml(request_bytes(url),allowed,False)
  for k in allowed: result[k]=k in flags
  debug['reports'].append({'type':typ,'reportDateTime':dt,'activeNames':names})
 return result,debug


def forecast_thunder(data):
 for block in data:
  for series in block.get('timeSeries',[]):
   for area in series.get('areas',[]):
    if area.get('area',{}).get('code')==FORECAST_AREA_CODE and any('雷' in x for x in area.get('weathers',[]) or []): return True
 return False


def main():
 w=get_json(WEATHER); c=w['current']; h=w['hourly']; d=w['daily']; t=c['time']; key=t[:13]+':00'; i=h['time'].index(key) if key in h['time'] else 0
 previous=load_previous()
 try: warnings,debug=fetch_warnings(previous)
 except Exception as e:
  warnings=dict(DEFAULT_WARNINGS); warnings.update({k:bool(previous[k]) for k in warnings if k in previous}); debug={'aggregate':None,'reports':[],'error':type(e).__name__}
 if warnings['thunder']: warnings['thunderForecast']=False
 else:
  try: warnings['thunderForecast']=forecast_thunder(get_json(FORECAST))
  except Exception: warnings['thunderForecast']=bool(previous.get('thunderForecast',False))
 payload={'schemaVersion':1,'generatedAt':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),'location':{'name':'勝どき','latitude':LAT,'longitude':LON},'weather':{'observedAt':t,'temperature':c['temperature_2m'],'precipitation':c['precipitation'],'weatherCode':c['weather_code'],'windSpeed':c['wind_speed_10m'],'rainProbability':h['precipitation_probability'][i] or 0,'minTemperature':d['temperature_2m_min'][0],'sunset':d['sunset'][0]},'warnings':warnings,'warningSource':'jma-vpws50-primary','warningDebug':debug}
 OUT.parent.mkdir(parents=True,exist_ok=True); OUT.write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8'); print('updated',OUT,'/ warnings:',warnings)

if __name__=='__main__': main()
