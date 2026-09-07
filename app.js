'use strict';

(() => {
  const C = window.SIGNAGE_CONFIG;
  const $ = (id) => document.getElementById(id);

  // ▼▼▼ 追加：直近データのキャッシュ保存先（A案） ▼▼▼
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
  // ▲▲▲ 追加ここまで ▲▲▲

  const IMAGES = {
    dry: ['./images/dry-warning.png', '乾燥注意報'],
    rainProbability: ['./images/rain-probability.png', '降水確率が高い'],
    lowTemperature: ['./images/low-temperature.png', '低温・凍結注意'],
    heavyRain: ['./images/heavy-rain.png', '大雨・浸水注意'],
    landslide: ['./images/landslide.png', '土砂災害警戒'],
    wave: ['./images/wave-warning.png', '波浪警報'],
    sunset: ['./images/sunset.png', '日没注意'],
    strongWind: ['./images/strong-wind.png', '強風注意'],
    thunder: ['./images/thunder.png', '雷注意報']
  };

  // 即時表示（警報級・日没）に該当するルール
  const IMMEDIATE_KEYS = ['landslide', 'heavyRain', 'wave', 'thunder', 'sunset'];
  // 総合判定を「注意情報あり(danger)」にするルール
  const DANGER_KEYS = ['landslide', 'heavyRain', 'wave', 'thunder'];

  let data = null;
  let imageIndex = 0;
  let lastRotationTime = 0;

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
    if (warnings.wave) immediate.push('wave');
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
    if (weather.windSpeed >= C.thresholds.strongWind) scheduled.push('strongWind');
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
      saveCache(nextData); // ▼追加：取得成功したデータを保存
      $('network').textContent = '● 通信正常';
      $('network').className = 'ok';
      $('stale').hidden = true;
      render();
    } catch (error) {
      console.error(error);

      // ▼▼▼ 変更：失敗時は直近データを残して表示する（A案） ▼▼▼
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
        $('network').className = 'ng';
        $('stale').hidden = false;
        $('stale').textContent = `直近データを表示中（${genTime} 時点）`;
      } else {
        // 一度も取得できていない初回のみ、従来どおり通信失敗を表示
        $('network').textContent = '● 通信失敗';
        $('network').className = 'ng';
        $('stale').hidden = false;
        $('stale').textContent = '最新情報を取得できていません';
      }
      // ▲▲▲ 変更ここまで ▲▲▲
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

  // ▼追加：起動直後にキャッシュを描画（初回から確認中/「--」を回避）
  data = loadCache();
  if (data) render();

  refreshData();
  tick();

  window.setInterval(tick, 1000);
  window.setInterval(refreshData, C.refreshMs);
})();
