#!/usr/bin/env python3
import json,urllib.request
from datetime import datetime,timezone
from pathlib import Path
LAT=35.654369;LON=139.774947
OUT=Path(__file__).resolve().parents[1]/'data'/'current.json'
WEATHER=f'https://api.open-meteo.com/v1/forecast?latitude={LAT}&longitude={LON}&current=temperature_2m,precipitation,weather_code,wind_speed_10m&hourly=precipitation_probability&daily=temperature_2m_min,sunset&timezone=Asia%2FTokyo&forecast_days=2'
JMA='https://www.jma.go.jp/bosai/warning/data/r8/130010.json'
def get(u):
 r=urllib.request.Request(u,headers={'User-Agent':'kachidoki-safety-signage/1.0','Accept':'application/json'})
 with urllib.request.urlopen(r,timeout=20) as x:return json.load(x)
def main():
 w=get(WEATHER);c=w['current'];h=w['hourly'];dy=w['daily'];t=c['time'];i=h['time'].index(t[:13]+':00') if t[:13]+':00' in h['time'] else 0;a={'dry':False,'thunder':False,'heavyRain':False,'landslide':False};err=None
 try:
  j=get(JMA);s=json.dumps(j,ensure_ascii=False);active=any(x in s for x in ('発表','継続','警報','注意報','危険')) and '解除' not in s;a={'dry':active and '乾燥' in s,'thunder':active and '雷' in s,'heavyRain':active and '大雨' in s,'landslide':active and '土砂' in s}
 except Exception as e:err=type(e).__name__
 p={'schemaVersion':1,'generatedAt':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),'location':{'name':'勝どき','latitude':LAT,'longitude':LON},'weather':{'observedAt':t,'temperature':c['temperature_2m'],'precipitation':c['precipitation'],'weatherCode':c['weather_code'],'windSpeed':c['wind_speed_10m'],'rainProbability':h['precipitation_probability'][i] or 0,'minTemperature':dy['temperature_2m_min'][0],'sunset':dy['sunset'][0]},'warnings':a,'warningFetchError':err};OUT.write_text(json.dumps(p,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8');print('updated',OUT)
if __name__=='__main__':main()
