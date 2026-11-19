'use strict';

(() => {

  const C = window.SIGNAGE_CONFIG;

  const $ = (id) => document.getElementById(id);

  const CACHE_KEY = 'kachidoki_safety_last';

  function saveCache(value) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(value));
    } catch (error) {
      console.warn('キャッシュ保存に失敗', error);
    }
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn('キャッシュ読込に失敗', error);
      return null;
    }
  }

  const IMAGES = {
    dry: ['./images/dry-warning.png', '乾燥注意報'],
    rainProbability: ['./images/rain-probability.png', '降水確率が高い'],
    lowTemperature: ['./images/low-temperature.png', '低温・凍結注意'],
    heavyRain: ['./images/heavy-rain.png', '大雨・浸水注意'],
    wave: ['./images/wave-warning.png', '波浪警報'],
    waveAdvisory: ['./images/wave-advisory.png', '波浪注意報'],
    stormSurge: ['./images/storm-surge.png', '高潮警報'],
    stormSurgeAdvisory: ['./images/storm-surge-advisory.png', '高潮注意報'],
    storm: ['./images/storm.png', '暴風警報'],
    sunset: ['./images/sunset.png', '日没注意'],
    strongWind: ['./images/strong-wind.png', '強風注意'],
    thunder: ['./images/thunder.png', '雷注意報'],
    thunderForecast: ['./images/thunder-forecast.png', '雷予報 発表中']
  };

  // 警報級＋日没は時間に関係なく即時全画面表示
  const IMMEDIATE_KEYS = [
    'heavyRain',
    'stormSurge',
    'wave',
    'storm',
    'sunset'
  ];

  // 総合判定を danger にする項目
  // 雷注意報は総合判定 danger だが、
  // 全画面表示は毎時00～10分のみ
  const DANGER_KEYS = [
    'heavyRain',
    'stormSurge',
    'wave',
    'storm',
    'thunder'
  ];

  let data = null;
  let imageIndex = 0;
  let lastRotationTime = 0;
  let lastQueueSignature = '';

  function getWarnStatusEl() {

    let el = $('warnStatus');

    if (!el) {

      const network = $('network');

      if (!network || !network.parentNode) {
        return null;
      }

      el = document.createElement('span');
      el.id = 'warnStatus';
      el.style.padding = '5px 12px';
      el.style.fontSize = '34px';
      el.style.whiteSpace = 'nowrap';
      el.style.border = '4px solid';
      el.style.borderRadius = '12px';
      el.hidden = true;

      network.parentNode.insertBefore(
        el,
        network.nextSibling
      );
    }

    return el;
  }

  function hasWarningFetchError() {

    if (!data) {
      return false;
    }

    if (data.warningFetchError) {
      return true;
    }

    const debug = data.warningDebug;

    if (!debug) {
      return false;
    }

    if (debug.error) {
      return true;
    }

    return Boolean(
      debug.aggregate &&
      debug.aggregate.error
    );
  }

  function updateWarnStatus() {

    const el = getWarnStatusEl();

    if (!el) {
      return;
    }

    if (hasWarningFetchError()) {

      el.textContent =
        '⚠ 警報情報を取得できていません';

      el.className = 'warn';
      el.hidden = false;

    } else {

      el.hidden = true;
      el.textContent = '';
      el.className = '';
    }
  }

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
        .map((part) => [
          part.type,
          part.value
        ])
    );

  const getWeatherName = (code) =>
    ({
      0: '快晴',
      1: '晴れ',
      2: '一部曇り',
      3: '曇り',
      45: '霧',
      51: '弱い霧雨',
      53: '霧雨',
      55: '強い霧雨',
      61: '弱い雨',
      63: '雨',
      65: '強い雨',
      80: 'にわか雨',
      95: '雷雨',
      96: '雷雨',
      99: '激しい雷雨'
    })[code] || '気象情報';

  function getMatchedRules() {

    if (!data || !data.weather) {
      return [];
    }

    const weather = data.weather;
    const warnings = data.warnings || {};

    const immediate = [];
    const scheduled = [];

    // =====================================================
    // 大雨
    //
    // 気象庁の大雨警報
    // OR
    // 現在降水量 10mm/h以上
    // =====================================================

    if (
      Boolean(warnings.heavyRain) ||
      Number(weather.precipitation) >=
        C.thresholds.heavyRainPerHour
    ) {
      immediate.push('heavyRain');
    }

    // =====================================================
    // 高潮警報
    // =====================================================

    if (Boolean(warnings.stormSurge)) {
      immediate.push('stormSurge');
    }

    // =====================================================
    // 波浪警報
    // =====================================================

    if (Boolean(warnings.wave)) {
      immediate.push('wave');
    }

    // =====================================================
    // 暴風
    //
    // 気象庁の暴風警報
    // OR
    // 実測風速20m/s以上
    // =====================================================

    const stormActive =
      Boolean(warnings.storm) ||
      Number(weather.windSpeed) >=
        C.thresholds.stormWind;

    if (stormActive) {
      immediate.push('storm');
    }

    // =====================================================
    // 雷
    //
    // 正式な雷注意報を優先。
    // 雷注意報がない場合だけ雷予報を表示。
    // =====================================================

    if (Boolean(warnings.thunder)) {

      scheduled.push('thunder');

    } else if (
      Boolean(warnings.thunderForecast)
    ) {

      scheduled.push('thunderForecast');
    }

    // =====================================================
    // 日没
    //
    // 日没30分前 ～ 日没10分後
    // =====================================================

    const now = new Date();
    const sunset = new Date(weather.sunset);

    const msUntilSunset =
      sunset.getTime() -
      now.getTime();

    if (
      Number.isFinite(msUntilSunset) &&
      msUntilSunset <=
        30 * 60 * 1000 &&
      msUntilSunset >=
        -10 * 60 * 1000
    ) {
      immediate.push('sunset');
    }

    // =====================================================
    // 強風
    //
    // 気象庁の強風注意報
    // OR
    // 実測風速10m/s以上
    //
    // 暴風判定中は重複表示しない
    // =====================================================

    const strongWindActive =
      Boolean(warnings.strongWind) ||
      Number(weather.windSpeed) >=
        C.thresholds.strongWind;

    if (
      !stormActive &&
      strongWindActive
    ) {
      scheduled.push('strongWind');
    }

    // =====================================================
    // 波浪注意報
    //
    // 波浪警報発表中は重複表示しない
    // =====================================================

    if (
      !Boolean(warnings.wave) &&
      Boolean(warnings.waveAdvisory)
    ) {
      scheduled.push('waveAdvisory');
    }

    // =====================================================
    // 高潮注意報
    //
    // 高潮警報発表中は重複表示しない
    // =====================================================

    if (
      !Boolean(warnings.stormSurge) &&
      Boolean(warnings.stormSurgeAdvisory)
    ) {
      scheduled.push(
        'stormSurgeAdvisory'
      );
    }

    // =====================================================
    // 低温・凍結
    //
    // 最低気温5℃以下
    // =====================================================

    if (
      Number(weather.minTemperature) <=
        C.thresholds.lowTemperature
    ) {
      scheduled.push('lowTemperature');
    }

    // =====================================================
    // 乾燥注意報
    // =====================================================

    if (Boolean(warnings.dry)) {
      scheduled.push('dry');
    }

    // =====================================================
    // 降水確率
    //
    // 60%以上
    // =====================================================

    if (
      Number(weather.rainProbability) >=
        C.thresholds.rainProbability
    ) {
      scheduled.push(
        'rainProbability'
      );
    }

    // 万一同一ルールが重複しても1回だけ表示
    return [
      ...new Set(
        immediate.concat(scheduled)
      )
    ];
  }

  function getOverlayRules() {

    const matched =
      getMatchedRules();

    // 警報級と日没は即時表示
    const immediate =
      matched.filter((key) =>
        IMMEDIATE_KEYS.includes(key)
      );

    if (immediate.length) {
      return immediate;
    }

    // 注意情報は毎時指定時間内のみ表示
    const minute = Number(
      getJapanTimeParts(
        new Date()
      ).minute
    );

    if (
      minute >=
        C.scheduledStartMinute &&
      minute <
        C.scheduledEndMinute
    ) {
      return matched.filter(
        (key) =>
          !IMMEDIATE_KEYS.includes(key)
      );
    }

    return [];
  }

  function render() {

    if (!data || !data.weather) {
      return;
    }

    const weather =
      data.weather;

    const matched =
      getMatchedRules();

    $('temperature').textContent =
      Number(
        weather.temperature
      ).toFixed(1);

    $('weatherLabel').textContent =
      getWeatherName(
        weather.weatherCode
      );

    $('rainProbability').textContent =
      `${Math.round(
        Number(
          weather.rainProbability
        )
      )}%`;

    $('precipitation').textContent =
      `${Number(
        weather.precipitation
      ).toFixed(1)} mm/h`;

    $('windSpeed').textContent =
      `${Number(
        weather.windSpeed
      ).toFixed(1)} m/s`;

    $('minTemperature').textContent =
      `${Number(
        weather.minTemperature
      ).toFixed(1)}℃`;

    $('sunsetTime').textContent =
      new Intl.DateTimeFormat(
        'ja-JP',
        {
          timeZone: 'Asia/Tokyo',
          hour: '2-digit',
          minute: '2-digit'
        }
      ).format(
        new Date(
          weather.sunset
        )
      );

    $('generatedAt').textContent =
      formatDateTime(
        data.generatedAt
      );

    $('activeAlerts').textContent =
      matched.length
        ? matched
            .filter((key) =>
              IMAGES[key]
            )
            .map(
              (key) =>
                IMAGES[key][1]
            )
            .join(' ／ ')
        : '現在、サイネージ表示対象の注意情報はありません';

    const hasDanger =
      matched.some((key) =>
        DANGER_KEYS.includes(key)
      );

    // 現在の勝どき版CSSに合わせて維持
    $('statusCard').className =
      hasDanger
        ? 'danger'
        : matched.length
          ? 'caution'
          : '';

    $('statusText').textContent =
      matched.length
        ? '注意情報あり'
        : '通常';

    updateWarnStatus();
  }

  function renderOverlay() {

    const queue =
      getOverlayRules().filter(
        (key) => IMAGES[key]
      );

    const overlay =
      $('alertOverlay');

    const signature =
      queue.join('|');

    if (!queue.length) {

      overlay.hidden = true;

      imageIndex = 0;
      lastQueueSignature = '';

      return;
    }

    // 表示対象が変わった場合は
    // 1枚目から表示し直す
    if (
      signature !==
      lastQueueSignature
    ) {

      imageIndex = 0;

      lastRotationTime =
        Date.now();

      lastQueueSignature =
        signature;

    } else if (
      Date.now() -
        lastRotationTime >=
      C.rotationMs
    ) {

      imageIndex =
        (imageIndex + 1) %
        queue.length;

      lastRotationTime =
        Date.now();
    }

    imageIndex %=
      queue.length;

    const key =
      queue[imageIndex];

    $('alertImage').src =
      IMAGES[key][0];

    $('alertImage').alt =
      IMAGES[key][1];

    $('overlayTitle').textContent =
      IMAGES[key][1];

    $('overlayCounter').textContent =
      queue.length > 1
        ? `${imageIndex + 1}/${queue.length}`
        : '';

    overlay.hidden = false;
  }

  function isUsableData(candidate) {

    if (
      !candidate ||
      !candidate.weather ||
      !candidate.generatedAt
    ) {
      return false;
    }

    const generatedTime =
      new Date(
        candidate.generatedAt
      ).getTime();

    return Number.isFinite(
      generatedTime
    );
  }

  async function refreshData() {

    try {

      const response =
        await fetch(
          `${C.dataUrl}?t=${Date.now()}`,
          {
            cache: 'no-store'
          }
        );

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}`
        );
      }

      const nextData =
        await response.json();

      if (
        !isUsableData(nextData)
      ) {
        throw new Error(
          '取得データの内容が不正です'
        );
      }

      const generatedTime =
        new Date(
          nextData.generatedAt
        ).getTime();

      const dataAge =
        Math.max(
          0,
          Date.now() -
            generatedTime
        );

      if (
        dataAge >
        C.staleMs
      ) {
        throw new Error(
          'データが1時間以上更新されていません'
        );
      }

      data = nextData;

      saveCache(nextData);

      $('network').textContent =
        '● 通信正常';

      $('network').className =
        'ok';

      $('stale').hidden =
        true;

      $('stale').textContent =
        '';

      render();

    } catch (error) {

      console.error(error);

      const cached =
        isUsableData(data)
          ? data
          : loadCache();

      if (
        isUsableData(cached)
      ) {

        data = cached;

        render();

        const genTime =
          new Intl.DateTimeFormat(
            'ja-JP',
            {
              timeZone:
                'Asia/Tokyo',
              hour: '2-digit',
              minute: '2-digit'
            }
          ).format(
            new Date(
              cached.generatedAt
            )
          );

        $('network').textContent =
          '● 更新遅延';

        $('network').className =
          'warn';

        $('stale').hidden =
          false;

        $('stale').textContent =
          `直近データを表示中（${genTime} 時点）`;

      } else {

        $('network').textContent =
          '● 通信失敗';

        $('network').className =
          'ng';

        $('stale').hidden =
          false;

        $('stale').textContent =
          '最新情報を取得できていません';
      }
    }
  }

  function fitToScreen() {

    const signage =
      $('signage');

    const BASE_WIDTH = 1920;
    const BASE_HEIGHT = 1080;

    const scale =
      Math.min(
        window.innerWidth /
          BASE_WIDTH,
        window.innerHeight /
          BASE_HEIGHT
      );

    signage.style.transform =
      `scale(${scale})`;

    signage.style.position =
      'absolute';

    signage.style.left =
      `${Math.max(
        0,
        (
          window.innerWidth -
          BASE_WIDTH * scale
        ) / 2
      )}px`;

    signage.style.top =
      `${Math.max(
        0,
        (
          window.innerHeight -
          BASE_HEIGHT * scale
        ) / 2
      )}px`;
  }

  function tick() {

    $('clock').textContent =
      formatDateTime(
        new Date()
      );

    render();

    renderOverlay();
  }

  window.addEventListener(
    'resize',
    fitToScreen
  );

  fitToScreen();

  // 起動直後はキャッシュがあれば表示
  const cachedData =
    loadCache();

  if (
    isUsableData(cachedData)
  ) {
    data = cachedData;
    render();
  }

  // 最新データ取得
  refreshData();

  // 時計・判定・オーバーレイは1秒更新
  tick();

  window.setInterval(
    tick,
    1000
  );

  // 気象データはconfig.jsの設定間隔で取得
  window.setInterval(
    refreshData,
    C.refreshMs
  );

})();
