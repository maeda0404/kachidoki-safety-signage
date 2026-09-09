'use strict';

(() => {
  const C = window.SIGNAGE_CONFIG;
  const $ = (id) => document.getElementById(id);

  // 直近データのキャッシュ保存先（A案）
  const CACHE_KEY = 'kachidoki_safety_last';

  function saveCache(d) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(d));
    } catch (e) {
      console.warn('キャッシュ保存に失敗', e);
    }
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  const IMAGES = {
    dry: ['./images/dry-warning.png', '乾燥注意報'],
    rainProbability: ['./images/rain-probability.png', '降水確率が高い'],
    lowTemperature: ['./images/low-temperature.png', '低温・凍結注意'],
    heavyRain: ['./images/heavy-rain.png', '大雨・浸水注意'],
    landslide: ['./images/landslide.png', '土砂災害警戒'],
    wave: ['./images/wave-warning.png', '波浪警報'],
    stormSurge: ['./images/storm-surge.png', '高潮警報'],
    stormSurgeAdvisory: ['./images/storm-surge-advisory.png', '高潮注意報'],
    storm: ['./images/storm.png', '暴風警報'],
    sunset: ['./images/sunset.png', '日没注意'],
    strongWind: ['./images/strong-wind.png', '強風注意'],
    thunder: ['./images/thunder.png', '雷注意報']
  };

  // 即時表示（警報級・日没）に該当するルール
  const IMMEDIATE_KEYS = [
    'landslide',
    'heavyRain',
    'stormSurge',
    'wave',
    'storm',
    'sunset'
  ];
  // 総合判定を「注意情報あり(danger)」にするルール
  const DANGER_KEYS = [
    'landslide',
    'heavyRain',
    'stormSurge',
    'wave',
    'storm',
    'thunder'
  ];

  let data = null;
  let imageIndex = 0;
  let lastRotationTime = 0;

  // ▼▼▼ 追加(A案)：警報取得ステータス表示 ▼▼▼
  // #network の隣に動的生成するので index.html の編集は不要
  function getWarnStatusEl() {
    let el = document.getElementById('warnStatus');
    if (!el) {
      const network = $('network');
      if (!network || !network.parentNode) return null;
      el = document.createElement('span');
      el.id = 'warnStatus';
      // #network と同系統の見た目を流用
      el.style.padding = '5px 12px';
      el.style.fontSize = '34px';
      el.style.whiteSpace = 'nowrap';
      el.style.border = '4px solid';
      el.style.borderRadius = '12px';
      el.hidden = true;
      network.parentNode.insertBefore(el, network.nextSibling);
    }
    return el;
  }

  // warningFetchError があるとき「警報情報を取得できていません」を表示。
  // これにより warnings が全て false でも、それが「本当に警報なし」なのか
  // 「取得失敗で false なだけ」なのかを現場が区別できる。
  function updateWarnStatus() {
    const el = getWarnStatusEl();
    if (!el) return;

    if (data && data.warningFetchError) {
      el.textContent = '⚠ 警報情報を取得できていません';
      el.className = 'warn';
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }
  // ▲▲▲ 追加ここまで ▲▲▲

  const formatDateTime = (value) =>
    new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date(value));

  const getJapanTimeParts = (value) =>
    Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      })
        .formatToParts(value)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value])
    );

  const getWeatherName = (code) =>
    ({
      0: '快晴',
      1: '晴れ',
      2: '一部曇り',
      3: '曇り',
      45: '霧',
      61: '弱い雨',
      63: '雨',
      65: '強い雨',
      80: 'にわか雨',
      95: '雷雨',
      96: '雷雨',
      99: '激しい雷雨'
    })[code] || '気象情報';

  /*
   * 時刻に関係なく、現在成立している注意・警報をすべて返します。
   * 総合判定と「発表・判定中の情報」に使用します。
   */
  function getMatchedRules() {
    if (!data) return [];

    const weather = data.weather;
    const warnings = data.warnings || {};
    const immediate = [];
    const scheduled = [];

    // 警報級（即時）
    if (warnings.landslide) immediate.push('landslide');
    if (
      warnings.heavyRain ||
      weather.precipitation >= C.thresholds.heavyRainPerHour
    ) {
      immediate.push('heavyRain');
    }
    if (warnings.stormSurge) immediate.push('stormSurge');
    if (warnings.wave) immediate.push('wave');

    // 暴風警報：警報フラグ、または風速が暴風しきい値以上で発火
    if (
      warnings.storm ||
      weather.windSpeed >= C.thresholds.stormWind
    ) {
      immediate.push('storm');
    }

    if (warnings.thunder) immediate.push('thunder');

    // 日没（即時・時間帯限定）
    const now = new Date();
    const sunset = new Date(weather.sunset);
    const msUntilSunset = sunset.getTime() - now.getTime();
    if (
      Number.isFinite(msUntilSunset) &&
      msUntilSunset <= 30 * 60 * 1000 &&
      msUntilSunset >= -10 * 60 * 1000
    ) {
      immediate.push('sunset');
    }

    // 注意情報
    // 強風注意報：暴風警報が出ていないときだけ表示（上位が出たら引っ込む）
    const stormActive =
      warnings.storm || weather.windSpeed >= C.thresholds.stormWind;
    if (!stormActive && weather.windSpeed >= C.thresholds.strongWind) {
      scheduled.push('strongWind');
    }

    // 高潮注意報：高潮警報が出ていないときだけ表示
    if (!warnings.stormSurge && warnings.stormSurgeAdvisory) {
      scheduled.push('stormSurgeAdvisory');
    }

    if (weather.minTemperature <= C.thresholds.lowTemperature) {
      scheduled.push('lowTemperature');
    }
    if (warnings.dry) scheduled.push('dry');
    if (weather.rainProbability >= C.thresholds.rainProbability) {
      scheduled.push('rainProbability');
    }

    return immediate.concat(scheduled);
  }

  /*
   * 全画面の警告画像に表示するルールを返します。
   * 警報級・日没は常時、注意情報は毎時00〜10分のみ。
   */
  function getOverlayRules() {
    const matched = getMatchedRules();
    const immediate = matched.filter((k) => IMMEDIATE_KEYS.includes(k));
    if (immediate.length > 0) {
      return immediate;
    }

    const minute = Number(getJapanTimeParts(new Date()).minute);
    if (
      minute >= C.scheduledStartMinute &&
      minute < C.scheduledEndMinute
    ) {
      return matched.filter((k) => !IMMEDIATE_KEYS.includes(k));
    }

    return [];
  }

  function render() {
    if (!data) return;

    const weather = data.weather;
    const matched = getMatchedRules();

    $('temperature').textContent = Number(weather.temperature).toFixed(1);
    $('weatherLabel').textContent = getWeatherName(weather.weatherCode);
    $('rainProbability').textContent =
      `${Math.round(weather.rainProbability)}%`;
    $('precipitation').textContent =
      `${Number(weather.precipitation).toFixed(1)} mm/h`;
    $('windSpeed').textContent =
      `${Number(weather.windSpeed).toFixed(1)} m/s`;
    $('minTemperature').textContent =
      `${Number(weather.minTemperature).toFixed(1)}℃`;
    $('sunsetTime').textContent =
      new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(weather.sunset));
    $('generatedAt').textContent = formatDateTime(data.generatedAt);

    // 総合判定・発表中情報は時刻に関係なく常時反映
    $('activeAlerts').textContent = matched.length
      ? matched.map((key) => IMAGES[key][1]).join(' ／ ')
      : '現在、サイネージ表示対象の注意情報はありません';

    const hasDanger = matched.some((key) => DANGER_KEYS.includes(key));

    $('statusCard').className = hasDanger
      ? 'danger'
      : matched.length
        ? 'caution'
        : '';

    $('statusText').textContent = matched.length
      ? '注意情報あり'
      : '通常';

    // 警報取得ステータス（取得失敗を隠さない）
    updateWarnStatus();
  }

  function renderOverlay() {
    const queue = getOverlayRules();
    const overlay = $('alertOverlay');

    if (queue.length === 0) {
      overlay.hidden = true;
      return;
    }

    if (Date.now() - lastRotationTime >= C.rotationMs) {
      imageIndex = (imageIndex + 1) % queue.length;
      lastRotationTime = Date.now();
    }

    const key = queue[imageIndex % queue.length];
    $('alertImage').src = IMAGES[key][0];
    $('alertImage').alt = IMAGES[key][1];
    $('overlayTitle').textContent = IMAGES[key][1];
    $('overlayCounter').textContent =
      queue.length > 1
        ? `${(imageIndex % queue.length) + 1}/${queue.length}`
        : '';

    overlay.hidden = false;
  }

  async function refreshData() {
    try {
      const response = await fetch(`${C.dataUrl}?t=${Date.now()}`, {
        cache: 'no-store'
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const nextData = await response.json();
      const dataAge =
        Date.now() - new Date(nextData.generatedAt).getTime();

      if (!Number.isFinite(dataAge) || dataAge > C.staleMs) {
        throw new Error('データが1時間以上更新されていません');
      }

      data = nextData;
      saveCache(nextData);
      $('network').textContent = '● 通信正常';
      $('network').className = 'ok';
      $('stale').hidden = true;
      render();
    } catch (error) {
      console.error(error);

      // 失敗時は直近データを残して表示する（A案）
      const cached = data || loadCache();

      if (cached) {
        data = cached;
        render();

        const genTime = new Intl.DateTimeFormat('ja-JP', {
          timeZone: 'Asia/Tokyo',
          hour: '2-digit',
          minute: '2-digit'
        }).format(new Date(cached.generatedAt));

        $('network').textContent = '● 更新遅延';
        $('network').className = 'warn';
        $('stale').hidden = false;
        $('stale').textContent = `直近データを表示中（${genTime} 時点）`;
      } else {
        // 一度も取得できていない初回のみ、従来どおり通信失敗を表示
        $('network').textContent = '● 通信失敗';
        $('network').className = 'ng';
        $('stale').hidden = false;
        $('stale').textContent = '最新情報を取得できていません';
      }
    }
  }

  function fitToScreen() {
    const signage = $('signage');
    const scale = Math.min(
      window.innerWidth / 1920,
      window.innerHeight / 1080
    );

    signage.style.transform = `scale(${scale})`;
    signage.style.position = 'absolute';
    signage.style.left =
      `${Math.max(0, (window.innerWidth - 1920 * scale) / 2)}px`;
    signage.style.top =
      `${Math.max(0, (window.innerHeight - 1080 * scale) / 2)}px`;
  }

  function tick() {
    $('clock').textContent = formatDateTime(new Date());
    render();
    renderOverlay();
  }

  window.addEventListener('resize', fitToScreen);

  fitToScreen();

  // 起動直後にキャッシュを描画（初回から確認中/「--」を回避）
  data = loadCache();
  if (data) render();

  refreshData();
  tick();

  window.setInterval(tick, 1000);
  window.setInterval(refreshData, C.refreshMs);
})();
