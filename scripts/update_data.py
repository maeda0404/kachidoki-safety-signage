#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
勝どき 安全・気象サイネージ用データ生成スクリプト

取得内容:
- Open-Meteo
  - 現在気温
  - 現在降水量
  - 天気コード
  - 風速
  - 降水確率
  - 最低気温
  - 日没時刻

- 気象庁
  - 大雨警報
  - 土砂災害
  - 暴風警報
  - 強風注意報
  - 波浪警報
  - 波浪注意報
  - 高潮警報
  - 高潮注意報
  - 雷注意報
  - 乾燥注意報
  - 雷予報

出力先:
data/current.json
"""

import gzip
import json
import re
import tempfile
import urllib.request
import xml.etree.ElementTree as ET

from datetime import datetime, timezone
from pathlib import Path


# =========================================================
# 基本設定
# =========================================================

LOCATION_NAME = "勝どき"

LATITUDE = 35.654369
LONGITUDE = 139.774947

OUTPUT_FILE = (
    Path(__file__).resolve().parents[1]
    / "data"
    / "current.json"
)

REQUEST_TIMEOUT_SECONDS = 30

USER_AGENT = "kachidoki-safety-signage/5.0"


# =========================================================
# Open-Meteo
# =========================================================

OPEN_METEO_URL = (
    "https://api.open-meteo.com/v1/forecast"
    f"?latitude={LATITUDE}"
    f"&longitude={LONGITUDE}"
    "&current="
    "temperature_2m,"
    "precipitation,"
    "weather_code,"
    "wind_speed_10m"
    "&hourly=precipitation_probability"
    "&daily=temperature_2m_min,sunset"
    "&timezone=Asia%2FTokyo"
    "&forecast_days=2"
)


# =========================================================
# 気象庁
# =========================================================

JMA_FORECAST_URL = (
    "https://www.jma.go.jp/"
    "bosai/forecast/data/forecast/130000.json"
)

JMA_REGULAR_FEED_URL = (
    "https://www.data.jma.go.jp/"
    "developer/xml/feed/regular.xml"
)

# 東京地方
TARGET_AREA_CODES = {
    "130010",
}

TARGET_AREA_NAMES = {
    "東京地方",
}

FORECAST_AREA_CODE = "130010"

# VPWS50取得時の配信エリアコード
VPWS50_FEED_AREA_CODE = "010000"


# =========================================================
# 警報・注意報の初期値
# =========================================================

DEFAULT_WARNINGS = {
    "dry": False,
    "thunder": False,
    "thunderForecast": False,
    "heavyRain": False,
    "landslide": False,
    "strongWind": False,
    "wave": False,
    "waveAdvisory": False,
    "storm": False,
    "stormSurge": False,
    "stormSurgeAdvisory": False,
}

OFFICIAL_WARNING_KEYS = tuple(
    key
    for key in DEFAULT_WARNINGS
    if key != "thunderForecast"
)


# =========================================================
# 気象庁XML URL抽出
# =========================================================

JMA_DATA_URL_PATTERN = re.compile(
    r"https://www\.data\.jma\.go\.jp/"
    r"developer/xml/data/"
    r"(\d{14})_\d+_([A-Z0-9]+)_(\d{6})\.xml"
)


# =========================================================
# 共通通信処理
# =========================================================

def request_bytes(url):
    """
    URLからバイトデータを取得する。
    キャッシュ回避用クエリを追加する。
    gzipレスポンスにも対応する。
    """

    separator = "&" if "?" in url else "?"

    timestamp = int(
        datetime.now(timezone.utc).timestamp()
    )

    request_url = (
        f"{url}{separator}_={timestamp}"
    )

    request = urllib.request.Request(
        request_url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": (
                "application/xml,"
                "application/json,"
                "text/xml,"
                "*/*"
            ),
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        },
    )

    with urllib.request.urlopen(
        request,
        timeout=REQUEST_TIMEOUT_SECONDS,
    ) as response:
        raw_data = response.read()

    if raw_data[:2] == b"\x1f\x8b":
        return gzip.decompress(raw_data)

    return raw_data


def get_json(url):
    """
    URLからJSONを取得する。
    """

    raw_data = request_bytes(url)

    return json.loads(
        raw_data.decode("utf-8")
    )


# =========================================================
# XML処理
# =========================================================

def local_name(element):
    """
    XML名前空間を除いたタグ名を返す。
    """

    return element.tag.rsplit("}", 1)[-1]


def child_text(element, child_name):
    """
    直下の指定タグの文字列を取得する。
    """

    for child in element:
        if local_name(child) == child_name:
            return (child.text or "").strip()

    return ""


def find_latest_report_url(
    feed_raw,
    report_type,
    area_code,
):
    """
    気象庁フィードから指定種別・エリアの
    最新XML URLを取得する。
    """

    feed_text = feed_raw.decode(
        "utf-8",
        "replace",
    )

    candidates = []

    for timestamp, item_type, item_area in (
        JMA_DATA_URL_PATTERN.findall(feed_text)
    ):
        if item_type != report_type:
            continue

        if item_area != area_code:
            continue

        report_url = (
            "https://www.data.jma.go.jp/"
            "developer/xml/data/"
            f"{timestamp}_0_"
            f"{item_type}_"
            f"{item_area}.xml"
        )

        candidates.append(
            (
                timestamp,
                report_url,
            )
        )

    if not candidates:
        return None

    return max(
        candidates,
        key=lambda item: item[0],
    )


def area_matches(item):
    """
    Item内のAreaが東京地方に該当するか確認する。
    """

    for element in item.iter():
        if local_name(element) != "Area":
            continue

        area_code = child_text(
            element,
            "Code",
        )

        area_name = child_text(
            element,
            "Name",
        )

        if area_code in TARGET_AREA_CODES:
            return True

        if area_name in TARGET_AREA_NAMES:
            return True

    return False


# =========================================================
# 警報名称から内部フラグへ変換
# =========================================================

def warning_name_to_flags(name):
    """
    気象庁XML内の警報・注意報名称を、
    サイネージ用フラグに変換する。
    """

    flags = set()

    normalized_name = (
        name.replace("　", "")
        .replace(" ", "")
    )

    # 雷注意報
    if "雷" in normalized_name:
        flags.add("thunder")

    # 乾燥注意報
    if "乾燥" in normalized_name:
        flags.add("dry")

    # 土砂災害
    if "土砂災害" in normalized_name:
        flags.add("landslide")

    # 大雨警報
    if (
        "大雨" in normalized_name
        and (
            "警報" in normalized_name
            or "特別警報" in normalized_name
        )
    ):
        flags.add("heavyRain")

    # 暴風警報・暴風特別警報
    if (
        "暴風" in normalized_name
        and (
            "警報" in normalized_name
            or "特別警報" in normalized_name
        )
    ):
        flags.add("storm")

    # 強風注意報
    if (
        "強風" in normalized_name
        and "注意報" in normalized_name
    ):
        flags.add("strongWind")

    # 波浪
    if "波浪" in normalized_name:
        if (
            "注意報" in normalized_name
            and "警報" not in normalized_name
        ):
            flags.add("waveAdvisory")

        elif (
            "警報" in normalized_name
            or "特別警報" in normalized_name
        ):
            flags.add("wave")

    # 高潮
    if "高潮" in normalized_name:
        if (
            "注意報" in normalized_name
            and "警報" not in normalized_name
        ):
            flags.add(
                "stormSurgeAdvisory"
            )

        elif (
            "警報" in normalized_name
            or "特別警報" in normalized_name
        ):
            flags.add("stormSurge")

    return flags


# =========================================================
# VPWS50解析
# =========================================================

def parse_vpws50(raw_xml):
    """
    VPWS50 XMLを解析し、
    東京地方で有効な警報・注意報を取得する。
    """

    root = ET.fromstring(raw_xml)

    active_flags = set()
    active_names = []

    report_datetime = ""

    for element in root.iter():
        if (
            local_name(element)
            == "ReportDateTime"
            and element.text
        ):
            report_datetime = (
                element.text.strip()
            )
            break

    inactive_statuses = {
        "解除",
        "なし",
        "発表警報・注意報はなし",
        "警報・注意報はなし",
    }

    for item in root.iter():
        if local_name(item) != "Item":
            continue

        if not area_matches(item):
            continue

        for kind in item.iter():
            if local_name(kind) != "Kind":
                continue

            warning_name = child_text(
                kind,
                "Name",
            )

            warning_status = child_text(
                kind,
                "Status",
            )

            if not warning_name:
                continue

            if warning_status in inactive_statuses:
                continue

            flags = warning_name_to_flags(
                warning_name
            )

            official_flags = (
                flags
                & set(OFFICIAL_WARNING_KEYS)
            )

            if not official_flags:
                continue

            active_flags.update(
                official_flags
            )

            active_names.append(
                warning_name
            )

    active_names = list(
        dict.fromkeys(active_names)
    )

    return {
        "flags": active_flags,
        "names": active_names,
        "reportDateTime": report_datetime,
    }


# =========================================================
# 気象庁警報・注意報取得
# =========================================================

def fetch_official_warnings():
    """
    気象庁VPWS50から東京地方の
    警報・注意報を取得する。

    取得失敗時は例外を送出する。
    古い警報を新しいgeneratedAtで保存しない。
    """

    regular_feed = request_bytes(
        JMA_REGULAR_FEED_URL
    )

    latest_report = find_latest_report_url(
        regular_feed,
        "VPWS50",
        VPWS50_FEED_AREA_CODE,
    )

    if latest_report is None:
        raise RuntimeError(
            "VPWS50の最新XMLが"
            "regular.xmlから見つかりません"
        )

    report_timestamp, report_url = (
        latest_report
    )

    report_raw = request_bytes(
        report_url
    )

    parsed = parse_vpws50(
        report_raw
    )

    warnings = dict(
        DEFAULT_WARNINGS
    )

    for warning_key in OFFICIAL_WARNING_KEYS:
        warnings[warning_key] = (
            warning_key
            in parsed["flags"]
        )

    debug = {
        "aggregate": {
            "type": "VPWS50",
            "feedTimestamp": report_timestamp,
            "reportDateTime": (
                parsed["reportDateTime"]
            ),
            "activeNames": (
                parsed["names"]
            ),
            "activeFlags": sorted(
                parsed["flags"]
            ),
            "sourceFile": (
                report_url.rsplit("/", 1)[-1]
            ),
            "sourceUrl": report_url,
            "targetAreaCodes": sorted(
                TARGET_AREA_CODES
            ),
            "targetAreaNames": sorted(
                TARGET_AREA_NAMES
            ),
        },
        "error": None,
    }

    return warnings, debug


# =========================================================
# 雷予報
# =========================================================

def forecast_contains_thunder(
    forecast_data,
):
    """
    気象庁府県天気予報に「雷」が含まれるか確認する。
    """

    for forecast_block in forecast_data:
        for time_series in (
            forecast_block.get(
                "timeSeries",
                [],
            )
        ):
            for area_data in (
                time_series.get(
                    "areas",
                    [],
                )
            ):
                area = area_data.get(
                    "area",
                    {},
                )

                if (
                    area.get("code")
                    != FORECAST_AREA_CODE
                ):
                    continue

                weather_texts = (
                    area_data.get(
                        "weathers",
                        [],
                    )
                    or []
                )

                if any(
                    "雷" in weather_text
                    for weather_text
                    in weather_texts
                ):
                    return True

    return False


def load_previous_payload():
    """
    既存current.jsonを読み込む。
    """

    try:
        return json.loads(
            OUTPUT_FILE.read_text(
                encoding="utf-8"
            )
        )

    except (
        FileNotFoundError,
        json.JSONDecodeError,
        OSError,
    ):
        return {}


def fetch_thunder_forecast(
    previous_payload,
):
    """
    雷予報を取得する。

    正式な雷注意報ではなく補助情報なので、
    雷予報だけ取得失敗した場合は
    前回値を利用する。
    """

    try:
        forecast_data = get_json(
            JMA_FORECAST_URL
        )

        thunder_forecast = (
            forecast_contains_thunder(
                forecast_data
            )
        )

        return (
            thunder_forecast,
            None,
        )

    except Exception as error:
        previous_warnings = (
            previous_payload.get(
                "warnings",
                {},
            )
        )

        previous_value = bool(
            previous_warnings.get(
                "thunderForecast",
                False,
            )
        )

        return (
            previous_value,
            type(error).__name__,
        )


# =========================================================
# Open-Meteo解析
# =========================================================

def find_hourly_index(
    hourly_times,
    observed_time,
):
    """
    current.timeに対応するhourlyインデックスを取得する。
    完全一致しない場合は直近の過去時刻を使用する。
    """

    if not hourly_times:
        return 0

    hour_key = (
        observed_time[:13]
        + ":00"
    )

    if hour_key in hourly_times:
        return hourly_times.index(
            hour_key
        )

    past_indexes = [
        index
        for index, item_time
        in enumerate(hourly_times)
        if item_time <= hour_key
    ]

    if past_indexes:
        return past_indexes[-1]

    return 0


def parse_open_meteo(
    weather_data,
):
    """
    Open-Meteoレスポンスから
    サイネージ用気象データを作成する。
    """

    current = weather_data.get(
        "current"
    )

    hourly = weather_data.get(
        "hourly"
    )

    daily = weather_data.get(
        "daily"
    )

    if not current:
        raise ValueError(
            "Open-Meteo currentがありません"
        )

    if not hourly:
        raise ValueError(
            "Open-Meteo hourlyがありません"
        )

    if not daily:
        raise ValueError(
            "Open-Meteo dailyがありません"
        )

    observed_time = current.get(
        "time"
    )

    if not observed_time:
        raise ValueError(
            "Open-Meteo current.timeがありません"
        )

    hourly_times = hourly.get(
        "time",
        [],
    )

    hourly_index = find_hourly_index(
        hourly_times,
        observed_time,
    )

    rain_probability_values = (
        hourly.get(
            "precipitation_probability",
            [],
        )
    )

    rain_probability = 0

    if (
        rain_probability_values
        and hourly_index
        < len(rain_probability_values)
    ):
        rain_probability = (
            rain_probability_values[
                hourly_index
            ]
        )

    if rain_probability is None:
        rain_probability = 0

    minimum_temperatures = daily.get(
        "temperature_2m_min",
        [],
    )

    sunset_values = daily.get(
        "sunset",
        [],
    )

    if not minimum_temperatures:
        raise ValueError(
            "最低気温データがありません"
        )

    if not sunset_values:
        raise ValueError(
            "日没時刻データがありません"
        )

    required_current_keys = (
        "temperature_2m",
        "precipitation",
        "weather_code",
        "wind_speed_10m",
    )

    for key in required_current_keys:
        if current.get(key) is None:
            raise ValueError(
                f"Open-Meteo {key}がありません"
            )

    return {
        "observedAt": observed_time,
        "temperature": (
            current["temperature_2m"]
        ),
        "precipitation": (
            current["precipitation"]
        ),
        "weatherCode": (
            current["weather_code"]
        ),
        "windSpeed": (
            current["wind_speed_10m"]
        ),
        "rainProbability": (
            rain_probability
        ),
        "minTemperature": (
            minimum_temperatures[0]
        ),
        "sunset": (
            sunset_values[0]
        ),
    }


# =========================================================
# JSON安全保存
# =========================================================

def write_json_atomically(
    output_file,
    payload,
):
    """
    一時ファイルへ書き込み後、
    current.jsonへ置き換える。

    書き込み途中の壊れたJSONが
    読み込まれることを防止する。
    """

    output_file.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    json_text = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ) + "\n"

    temporary_file = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=output_file.parent,
            prefix="current-",
            suffix=".tmp",
            delete=False,
        ) as temp:
            temp.write(json_text)
            temp.flush()

            temporary_file = Path(
                temp.name
            )

        temporary_file.replace(
            output_file
        )

    finally:
        if (
            temporary_file is not None
            and temporary_file.exists()
        ):
            temporary_file.unlink()


# =========================================================
# メイン処理
# =========================================================

def main():
    """
    気象・警報データを取得し、
    current.jsonを生成する。
    """

    previous_payload = (
        load_previous_payload()
    )

    # Open-Meteo取得
    open_meteo_data = get_json(
        OPEN_METEO_URL
    )

    weather = parse_open_meteo(
        open_meteo_data
    )

    # 気象庁の公式警報・注意報取得
    #
    # ここで失敗した場合は例外終了する。
    # 古い警報情報を、新しいgeneratedAtで
    # current.jsonへ書き込まない。
    warnings, warning_debug = (
        fetch_official_warnings()
    )

    # 雷注意報が出ている場合は、
    # 補助情報の雷予報は重複表示しない。
    if warnings["thunder"]:
        warnings["thunderForecast"] = False
        warning_debug[
            "thunderForecast"
        ] = {
            "active": False,
            "suppressedByThunderAdvisory": True,
            "error": None,
        }

    else:
        (
            thunder_forecast,
            thunder_forecast_error,
        ) = fetch_thunder_forecast(
            previous_payload
        )

        warnings[
            "thunderForecast"
        ] = thunder_forecast

        warning_debug[
            "thunderForecast"
        ] = {
            "active": thunder_forecast,
            "suppressedByThunderAdvisory": False,
            "error": thunder_forecast_error,
        }

    generated_at = (
        datetime.now(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )

    payload = {
        "schemaVersion": 2,
        "generatedAt": generated_at,
        "location": {
            "name": LOCATION_NAME,
            "latitude": LATITUDE,
            "longitude": LONGITUDE,
        },
        "weather": weather,
        "warnings": warnings,
        "warningSource": (
            "jma-vpws50-primary"
        ),
        "warningDebug": warning_debug,
    }

    write_json_atomically(
        OUTPUT_FILE,
        payload,
    )

    print(
        "updated:",
        OUTPUT_FILE,
    )

    print(
        "generatedAt:",
        generated_at,
    )

    print(
        "weather:",
        weather,
    )

    print(
        "warnings:",
        warnings,
    )

    print(
        "activeNames:",
        warning_debug
        .get("aggregate", {})
        .get("activeNames", []),
    )


if __name__ == "__main__":
    main()
