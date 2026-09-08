#!/usr/bin/env python3
"""
勝どき安全サイネージ用データ生成スクリプト

- 気象データ: Open-Meteo
- 警報・注意報: 気象庁 130010.json（東京都）

【重要な修正】
旧版は JMA JSON を「文字列に '波浪' が含まれるか」で判定していたが、
JMA の警報 JSON は数字コード（例 07=波浪警報）しか持たず日本語名を含まないため、
実際には JMA 由来の警報が一切検知できていなかった。
本版はコード番号で判定し、対象を中央区（1310200）に限定する。
"""

import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

LAT = 35.654369
LON = 139.774947
OUT = Path(__file__).resolve().parents[1] / 'data' / 'current.json'

# 中央区の市区町村コード（見つからなければ東京地方 130010 にフォールバック）
TARGET_AREA_CODES = ('1310200', '130010')

WEATHER = (
    'https://api.open-meteo.com/v1/forecast'
    f'?latitude={LAT}&longitude={LON}'
    '&current=temperature_2m,precipitation,weather_code,wind_speed_10m'
    '&hourly=precipitation_probability'
    '&daily=temperature_2m_min,sunset'
    '&timezone=Asia%2FTokyo&forecast_days=2'
)
JMA = 'https://www.jma.go.jp/bosai/warning/data/warning/130000.json'

# 警報・注意報コード → サイネージのフラグ名
# （警報・特別警報は上位扱い。L4危険警報は L3警報コードで実質カバーされる）
WARNING_CODE_MAP = {
    '05': 'storm',                 # 暴風警報
    '35': 'storm',                 # 暴風特別警報
    '07': 'wave',                  # 波浪警報
    '37': 'wave',                  # 波浪特別警報
    '08': 'stormSurge',            # 高潮警報
    '38': 'stormSurge',            # 高潮特別警報
    '19': 'stormSurgeAdvisory',    # 高潮注意報
    '03': 'heavyRain',             # 大雨警報
    '33': 'heavyRain',             # 大雨特別警報
    '14': 'thunder',               # 雷注意報
    '21': 'dry',                   # 乾燥注意報
}

# app.js が参照するフラグ一式（初期値は全て False）
DEFAULT_WARNINGS = {
    'dry': False,
    'thunder': False,
    'heavyRain': False,
    'landslide': False,   # 中央区は土砂災害リスクほぼ無し。r8のコード未確定のため常時False
    'wave': False,
    'storm': False,
    'stormSurge': False,
    'stormSurgeAdvisory': False,
}

# 「無効」とみなす status（この警報コードは採用しない）
INACTIVE_STATUS = ('解除', '発表警報・注意報はなし', '')


def get(url):
    req = urllib.request.Request(
        url,
        headers={
            'User-Agent': 'kachidoki-safety-signage/2.0',
            'Accept': 'application/json',
        },
    )
    with urllib.request.urlopen(req, timeout=20) as res:
        return json.load(res)


def collect_active_codes(jma_json):
    """対象エリアの、解除されていない警報コードの集合を返す。"""
    for target in TARGET_AREA_CODES:
        for area_type in jma_json.get('areaTypes', []):
            for area in area_type.get('areas', []):
                if area.get('code') != target:
                    continue
                codes = set()
                for w in area.get('warnings', []):
                    code = w.get('code')
                    status = w.get('status', '')
                    if code and status not in INACTIVE_STATUS:
                        codes.add(code)
                return codes  # 対象エリアが見つかった時点で確定
    return set()


def parse_warnings(jma_json):
    warnings = dict(DEFAULT_WARNINGS)
    for code in collect_active_codes(jma_json):
        flag = WARNING_CODE_MAP.get(code)
        if flag:
            warnings[flag] = True
    return warnings


def main():
    w = get(WEATHER)
    c = w['current']
    h = w['hourly']
    dy = w['daily']
    t = c['time']

    key = t[:13] + ':00'
    i = h['time'].index(key) if key in h['time'] else 0

    warnings = dict(DEFAULT_WARNINGS)
    err = None
    try:
        warnings = parse_warnings(get(JMA))
    except Exception as e:
        err = type(e).__name__

    payload = {
        'schemaVersion': 1,
        'generatedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'location': {'name': '勝どき', 'latitude': LAT, 'longitude': LON},
        'weather': {
            'observedAt': t,
            'temperature': c['temperature_2m'],
            'precipitation': c['precipitation'],
            'weatherCode': c['weather_code'],
            'windSpeed': c['wind_speed_10m'],
            'rainProbability': h['precipitation_probability'][i] or 0,
            'minTemperature': dy['temperature_2m_min'][0],
            'sunset': dy['sunset'][0],
        },
        'warnings': warnings,
        'warningFetchError': err,
    }

    OUT.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n',
        encoding='utf-8',
    )
    print('updated', OUT, '/ warnings:', warnings, '/ error:', err)


if __name__ == '__main__':
    main()
