(function () {
  'use strict';

  const STORAGE_KEY = 'soopnotice:samguk:v2';
  const STORAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const REFRESH_INTERVAL_MS = 60 * 1000;
  const REQUEST_TIMEOUT_MS = 8000;
  const WIKI_URL = 'https://threekingdoms.notion.site/';
  const FMKOREA_RULES_URL = 'https://www.fmkorea.com/10143176987';
  const FMKOREA_SLIDES_URL = 'https://www.fmkorea.com/10143088032';
  const OWNER_COLORS = {
    '위': '#4169a8',
    '촉': '#3f8b58',
    '오': '#b94d4d',
    '미점령': '#a7abb3',
  };
  const BLOCKED_COORDS = [
    [2, 4], [3, 7], [4, 8], [5, 3], [6, 6], [7, 5],
  ];
  const LOCAL_RULES = [
    {
      category: '서버 개요',
      title: '10일간 진행되는 RPG 영토전',
      description: '2026년 8월 1일 21시부터 8월 10일 21시까지 진행됩니다. 요괴 사냥 RPG와 영토 전쟁이 결합되며, 종료 시 가장 많은 영토를 가진 나라가 우승합니다.',
      sourceUrl: WIKI_URL,
    },
    {
      category: '기량',
      title: '무력 · 기민 · 기력 · 지모',
      description: '무력은 공격력, 기민은 이동속도, 기력은 체력, 지모는 절기 가속을 높입니다. 직업마다 기량 구슬 효율이 다르며 직업 변경 시 사용한 절기·기량 구슬의 80%만 반환됩니다.',
      sourceUrl: WIKI_URL,
    },
    {
      category: '장비',
      title: '무기와 두갑 · 흉갑 · 각갑',
      description: '무기는 공격력·힘·공격속도에 영향을 줍니다. 방어구는 두갑·흉갑·각갑으로 나뉘며 두갑은 군주만 보유합니다.',
      sourceUrl: FMKOREA_SLIDES_URL,
    },
    {
      category: '강화',
      title: '강화 재료와 보조권',
      description: '무기는 강화석·석재·금화, 방어구는 강화석·목재·금화를 사용합니다. 단계 하락 방지권과 확률 2·3·5·10배 증가권이 있습니다. 공개 자료에 정확한 단계별 성공률·상한은 없어 임의로 추정하지 않습니다.',
      sourceUrl: FMKOREA_RULES_URL,
    },
    {
      category: '각인',
      title: '장비별 각인석 최대 3개',
      description: '각 장비에는 각인석을 최대 3개까지 적용할 수 있고, 동일 효과는 합연산됩니다.',
      sourceUrl: WIKI_URL,
    },
    {
      category: '영토',
      title: '60개 영토와 인접 구매',
      description: '총 60개 영토가 있으며 초기 구매는 상하좌우로 인접한 영토만 가능합니다. 구매비는 50만 금화입니다.',
      sourceUrl: WIKI_URL,
    },
    {
      category: '영토',
      title: '수도 · 시설 · 특수 영토',
      description: '초기 수도는 위 8번, 촉 42번, 오 47번입니다. 시설은 병영·성채·장원이 있고 장원은 국가당 최대 10개입니다. 27번 특수 영토는 보유국 인원의 공격력을 5% 높입니다.',
      sourceUrl: WIKI_URL,
    },
    {
      category: '점령전',
      title: '점령률 변화',
      description: '자국 인원만 있으면 점령률이 상승하고 양국 인원이 함께 있으면 유지되며 상대국 인원만 있으면 하락합니다. 진행 중 수치는 방송 확인 또는 수기 입력이 필요합니다.',
      sourceUrl: WIKI_URL,
    },
  ];

  let payload = null;
  let loadPromise = null;
  let lastRequestAt = 0;

  function hasValue(value) {
    return value !== null && value !== undefined && value !== '';
  }

  function cleanValue(value) {
    return hasValue(value) ? value : null;
  }

  function pick(row, names) {
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(row || {}, name) && hasValue(row[name])) {
        return row[name];
      }
    }
    return null;
  }

  function safeText(value) {
    return escapeHtml(String(hasValue(value) ? value : ''));
  }

  function safeUrl(value) {
    if (typeof value !== 'string') return '';
    try {
      const url = new URL(value, location.origin);
      return url.protocol === 'https:' ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatTime(value) {
    const date = parseDate(value);
    if (!date) return '시각 미확인';
    return date.toLocaleString('ko-KR', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function normalizeMember(row) {
    return {
      name: pick(row, ['name', 'nickname', '닉네임']),
      soopId: pick(row, ['soopId', 'soop_id', 'SOOP_ID']),
      nation: pick(row, ['nation', '국가']),
      crew: pick(row, ['crew', 'crewName', '세력/길드', '크루']),
      job: pick(row, ['job', '장수/직업', '직업']),
      level: cleanValue(pick(row, ['level', '레벨'])),
      horse: cleanValue(pick(row, ['horse', '말'])),
      horseLevel: cleanValue(pick(row, ['horseLevel', 'horse_level', '말강화'])),
      weapon: cleanValue(pick(row, ['weapon', '무기강화', '무기'])),
      helmet: cleanValue(pick(row, ['helmet', '두갑강화', '두갑'])),
      armor: cleanValue(pick(row, ['armor', '흉갑강화', '흉갑'])),
      shoes: cleanValue(pick(row, ['shoes', '각갑강화', '각갑'])),
      strength: cleanValue(pick(row, ['strength', 'stat_strength', '무력'])),
      agility: cleanValue(pick(row, ['agility', 'stat_agility', '기민'])),
      vitality: cleanValue(pick(row, ['vitality', 'stat_vitality', '기력'])),
      intelligence: cleanValue(pick(row, ['intelligence', 'stat_intelligence', '지모'])),
      reviewStatus: pick(row, ['reviewStatus', 'review_status', '검수상태']),
      observedAt: pick(row, ['observedAt', 'observed_at', '최종확인', '확인시각']),
      evidence: pick(row, ['evidence', '최근근거', '근거URL']),
    };
  }

  function mergeMembers(rows) {
    const normalized = (Array.isArray(rows) ? rows : []).map(normalizeMember);
    const bySoopId = new Map(normalized.filter(row => row.soopId).map(row => [String(row.soopId), row]));
    const byName = new Map(normalized.filter(row => row.name).map(row => [String(row.name), row]));
    const valueFields = [
      'level', 'horse', 'horseLevel', 'weapon', 'helmet', 'armor', 'shoes',
      'strength', 'agility', 'vitality', 'intelligence', 'reviewStatus', 'observedAt', 'evidence',
    ];

    SAMGUK_MEMBERS.forEach(function (member) {
      const row = bySoopId.get(member.soopId) || byName.get(member.name);
      if (!row) return;
      if (row.nation && SAMGUK_NATIONS[row.nation]) member.nation = row.nation;
      if (row.crew) member.crew = row.crew;
      if (row.job) member.job = row.job;
      valueFields.forEach(function (field) {
        member[field] = row[field];
      });
    });
  }

  function normalizeTerritory(row) {
    const number = Number(pick(row, ['number', 'name', '번호', '영토번호']));
    const owner = pick(row, ['owner', '소유국']) || '미점령';
    const rawX = pick(row, ['x', '지도X', 'X']);
    const rawY = pick(row, ['y', '지도Y', 'Y']);
    const rawCapital = pick(row, ['capital', 'isCapital', '수도여부', '수도']);
    const capitalText = String(rawCapital).trim().toUpperCase();
    return {
      id: pick(row, ['id', 'castleKey', 'castle_key', '영토ID']) || (number ? '영토-' + number : ''),
      number: Number.isFinite(number) ? number : null,
      x: hasValue(rawX) ? Number(rawX) : NaN,
      y: hasValue(rawY) ? Number(rawY) : NaN,
      owner: Object.prototype.hasOwnProperty.call(OWNER_COLORS, owner) ? owner : '미점령',
      capital: rawCapital === true || ['Y', 'TRUE', '1', '수도'].includes(capitalText),
      facility: pick(row, ['facility', 'facilityType', '시설', '거점유형']) || '없음',
      level: cleanValue(pick(row, ['level', '영토레벨', '성레벨'])),
      reviewStatus: pick(row, ['reviewStatus', '검수상태']),
      observedAt: pick(row, ['observedAt', '확인시각', '최종확인']),
      evidence: pick(row, ['evidence', '근거URL', '근거']),
    };
  }

  function normalizeRule(row) {
    return {
      category: pick(row, ['category', '분류']) || '게임정보',
      title: pick(row, ['title', '제목']),
      description: pick(row, ['description', '내용', '설명']),
      sourceUrl: pick(row, ['sourceUrl', 'source_url', '출처URL', '근거URL']),
      sourceDate: pick(row, ['sourceDate', 'source_date', '기준일']),
      reviewStatus: pick(row, ['reviewStatus', '검수상태']),
    };
  }

  function sourceNote(data) {
    const isSheet = data && String(data.source || '').indexOf('google-sheet') === 0;
    const updatedAt = data && data.updatedAt;
    const memberReviewRows = SAMGUK_MEMBERS.filter(member => member.reviewStatus && member.reviewStatus !== '확정').length;
    const territoryReviewRows = data && Array.isArray(data.territories)
      ? data.territories.filter(row => row.reviewStatus && row.reviewStatus !== '확정').length
      : 0;
    const sourceLabel = data && data.source === 'google-sheet-last-good'
      ? 'Google 관리 시트 마지막 정상값'
      : isSheet ? 'Google 관리 시트' : '초기 공개자료 스냅샷';
    const reviewParts = [];
    if (memberReviewRows) reviewParts.push('참가자 ' + memberReviewRows + '명');
    if (territoryReviewRows) reviewParts.push('영토 ' + territoryReviewRows + '개');
    const reviewText = reviewParts.length ? ' · 검수대기/미확인 ' + reviewParts.join(' · ') : '';
    return '<div class="samguk-source-note"><strong>' + safeText(sourceLabel) + '</strong> · '
      + safeText(formatTime(updatedAt)) + reviewText
      + '<br>강화·기량은 방송 화면과 제보를 확인해 정리한 값이라 실제 서버와 차이가 날 수 있습니다. '
      + '영토는 표시된 마지막 갱신 시각 기준이며 점령 진행 중에는 반영이 늦을 수 있습니다.</div>';
  }

  function setBadge(data, mode) {
    const badge = document.getElementById('samgukSyncBadge');
    if (!badge) return;
    badge.classList.remove('is-live', 'is-fallback', 'is-error');
    const warnings = Array.isArray(data && data.warnings) ? data.warnings.join('\n') : '';
    badge.title = warnings;
    if (mode === 'error') {
      badge.classList.add('is-error');
      badge.textContent = '연결 실패';
      return;
    }
    if (mode === 'stored') {
      badge.classList.add('is-fallback');
      badge.textContent = '브라우저 저장 자료';
      return;
    }
    if (mode === 'network-error') {
      badge.classList.add('is-fallback');
      badge.textContent = '갱신 지연 · 기존 자료';
      return;
    }
    if (data && data.source === 'google-sheet' && !data.stale) {
      badge.classList.add('is-live');
      badge.textContent = '시트 동기화 · ' + formatTime(data.updatedAt);
    } else if (data && String(data.source || '').indexOf('google-sheet') === 0) {
      badge.classList.add('is-fallback');
      badge.textContent = '마지막 정상 시트 · ' + formatTime(data.updatedAt);
    } else {
      badge.classList.add('is-fallback');
      badge.textContent = '초기 스냅샷 · ' + formatTime(data && data.updatedAt);
    }
  }

  function applyPayload(data, mode) {
    if (!data || !Array.isArray(data.members)) throw new Error('삼국지 데이터 형식 오류');
    payload = data;
    mergeMembers(data.members);
    payload.territories = (Array.isArray(data.territories) ? data.territories : [])
      .map(normalizeTerritory)
      .filter(row => row.number && row.number >= 1 && row.number <= 60)
      .sort((a, b) => a.number - b.number);
    payload.rules = (Array.isArray(data.rules) && data.rules.length ? data.rules : LOCAL_RULES)
      .map(normalizeRule)
      .filter(row => row.title && row.description);

    window.samgukDataNote = data.source === 'google-sheet' && !data.stale
      ? 'Google 관리 시트의 입력값을 집계합니다. 검수 상태는 각 행에 표시됩니다.'
      : String(data.source || '').indexOf('google-sheet') === 0
        ? '마지막으로 정상 확인된 관리 시트 값을 집계합니다. 갱신 시각과 검수 상태를 확인하세요.'
        : '초기 공개자료의 검수대기 값이 포함된 참고 순위입니다. 방송 화면 확인 후 확정됩니다.';
    window.samgukSourceNoteHtml = sourceNote(data);
    setBadge(data, mode);

    if (currentSamgukTab === 'ranking') renderSamgukPowerRanking();
    else if (currentSamgukTab === 'territory') renderSamgukTerritory();
    else if (currentSamgukTab === 'info') renderSamgukInfo();
    else renderSamguk();
  }

  function savePayload(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), payload: data }));
    } catch (_) {}
  }

  function restorePayload() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!stored || !stored.payload || Date.now() - Number(stored.savedAt) > STORAGE_MAX_AGE_MS) return false;
      applyPayload(stored.payload, 'stored');
      return true;
    } catch (_) {
      return false;
    }
  }

  async function requestPayload() {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(API_BASE + '/api/samguk', {
        headers: { Accept: 'application/json' },
        cache: 'no-cache',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('삼국지 API ' + response.status);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  window.loadSamgukData = function loadSamgukData(force) {
    const now = Date.now();
    if (!force && payload && now - lastRequestAt < REFRESH_INTERVAL_MS) return Promise.resolve(payload);
    if (loadPromise) return loadPromise;
    lastRequestAt = now;
    loadPromise = requestPayload()
      .then(function (data) {
        applyPayload(data, 'network');
        savePayload(data);
        return data;
      })
      .catch(function (error) {
        if (payload) {
          setBadge(payload, 'network-error');
          const badge = document.getElementById('samgukSyncBadge');
          if (badge) badge.title = error.message;
        } else if (!restorePayload()) {
          setBadge(null, 'error');
        }
        if (window.console) console.warn('삼국지 데이터 로드 실패:', error.message);
        return payload;
      })
      .finally(function () { loadPromise = null; });
    return loadPromise;
  };

  function ownerBadge(owner) {
    return '<span class="samguk-owner-badge" style="background:' + OWNER_COLORS[owner] + '">' + safeText(owner) + '</span>';
  }

  function renderTerritorySvg(territories) {
    const blocked = BLOCKED_COORDS.map(function (position) {
      const x = 310 + 54 * position[1];
      const y = 115 + 54 * position[0];
      return '<g opacity="0.25"><path d="M' + (x - 9) + ' ' + (y - 9) + ' L' + (x + 9) + ' ' + (y + 9)
        + ' M' + (x + 9) + ' ' + (y - 9) + ' L' + (x - 9) + ' ' + (y + 9)
        + '" stroke="#777" stroke-width="4" stroke-linecap="round"/></g>';
    }).join('');
    const nodes = territories.map(function (territory) {
      const x = Number.isFinite(territory.x) ? territory.x : 310 + ((territory.number - 1) % 10) * 54;
      const y = Number.isFinite(territory.y) ? territory.y : 115 + Math.floor((territory.number - 1) / 10) * 54;
      const classNames = ['samguk-map-node'];
      if (territory.number === 27) classNames.push('is-special');
      const label = territory.capital ? '★' : territory.number;
      const tooltip = territory.number + '번 · ' + territory.owner
        + (territory.capital ? ' · 수도' : '')
        + (territory.facility && territory.facility !== '없음' ? ' · ' + territory.facility : '')
        + (territory.number === 27 ? ' · 공격력 5% 특수 영토' : '');
      return '<g class="' + classNames.join(' ') + '" tabindex="0" role="img" aria-label="' + safeText(tooltip) + '">'
        + '<title>' + safeText(tooltip) + '</title>'
        + '<circle cx="' + x + '" cy="' + y + '" r="19" fill="' + OWNER_COLORS[territory.owner] + '"></circle>'
        + '<text class="' + (territory.capital ? 'samguk-map-capital' : '') + '" x="' + x + '" y="' + y + '">' + label + '</text>'
        + '</g>';
    }).join('');
    return '<svg class="samguk-territory-svg" viewBox="275 75 625 525" role="img" aria-label="삼국지 ' + territories.length + '개 영토 현황">'
      + blocked + nodes + '</svg>';
  }

  window.renderSamgukTerritory = function renderSamgukTerritory() {
    const root = document.getElementById('samgukTerritoryMap');
    if (!root) return;
    const territories = payload && Array.isArray(payload.territories) ? payload.territories : [];
    if (!territories.length) {
      root.innerHTML = (window.samgukSourceNoteHtml || '') + '<div class="samguk-data-empty">영토 데이터가 아직 없습니다.</div>';
      return;
    }
    const counts = { '위': 0, '촉': 0, '오': 0, '미점령': 0 };
    territories.forEach(function (territory) { counts[territory.owner] = (counts[territory.owner] || 0) + 1; });
    const occupied = territories.filter(territory => territory.owner !== '미점령');
    const territoryReviewRows = territories.filter(territory => territory.reviewStatus && territory.reviewStatus !== '확정').length;
    const rows = occupied.map(function (territory) {
      return '<tr><td><b>' + territory.number + '번</b>' + (territory.number === 27 ? ' · 특수' : '') + '</td>'
        + '<td>' + ownerBadge(territory.owner) + '</td>'
        + '<td>' + (territory.capital ? '수도' : '—') + '</td>'
        + '<td>' + safeText(territory.facility || '없음') + '</td>'
        + '<td>' + safeText(hasValue(territory.level) ? territory.level : '—') + '</td>'
        + '<td>' + samgukReviewBadge(territory) + '</td>'
        + '<td>' + safeText(formatTime(territory.observedAt || (payload && payload.updatedAt))) + '</td></tr>';
    }).join('');
    root.innerHTML = '<div class="samguk-territory-dashboard">'
      + (window.samgukSourceNoteHtml || '')
      + '<div class="samguk-territory-summary">'
      + '<div class="samguk-territory-kpi is-wei"><span class="samguk-territory-kpi-label">魏 위</span><b class="samguk-territory-kpi-value">' + counts['위'] + '</b></div>'
      + '<div class="samguk-territory-kpi is-shu"><span class="samguk-territory-kpi-label">蜀 촉</span><b class="samguk-territory-kpi-value">' + counts['촉'] + '</b></div>'
      + '<div class="samguk-territory-kpi is-wu"><span class="samguk-territory-kpi-label">吳 오</span><b class="samguk-territory-kpi-value">' + counts['오'] + '</b></div>'
      + '<div class="samguk-territory-kpi is-empty"><span class="samguk-territory-kpi-label">미점령</span><b class="samguk-territory-kpi-value">' + counts['미점령'] + '</b></div>'
      + '</div>'
      + (territoryReviewRows ? '<div class="samguk-territory-review-note">검수대기/미확인 영토 ' + territoryReviewRows + '개가 포함된 참고 현황입니다.</div>' : '')
      + '<section class="samguk-map-panel"><div class="samguk-map-head"><h3 class="samguk-map-title">' + territories.length + '개 영토 현황</h3>'
      + '<div class="samguk-map-legend"><span><i style="background:#4169a8"></i>위</span><span><i style="background:#3f8b58"></i>촉</span>'
      + '<span><i style="background:#b94d4d"></i>오</span><span><i style="background:#a7abb3"></i>미점령</span><span>★ 수도</span><span>금색 테두리 27번 특수지</span></div></div>'
      + renderTerritorySvg(territories) + '</section>'
      + '<section class="samguk-territory-table-panel"><div class="samguk-ranking-header">점령 영토 ' + occupied.length + '개</div>'
      + '<div class="samguk-territory-table-wrap"><table class="samguk-territory-table"><thead><tr><th>영토</th><th>소유국</th><th>수도</th><th>시설</th><th>레벨</th><th>검수</th><th>기준 시각</th></tr></thead><tbody>'
      + (rows || '<tr><td colspan="7">아직 점령된 영토가 없습니다.</td></tr>')
      + '</tbody></table></div></section></div>';
  };

  window.renderSamgukInfo = function renderSamgukInfo() {
    const root = document.getElementById('samgukGameInfo');
    if (!root) return;
    const rules = payload && Array.isArray(payload.rules) && payload.rules.length ? payload.rules : LOCAL_RULES;
    const cards = rules.map(function (rule) {
      const url = safeUrl(rule.sourceUrl);
      return '<article class="samguk-info-card"><span class="samguk-info-category">' + safeText(rule.category) + '</span>'
        + '<h3 class="samguk-info-title">' + safeText(rule.title) + '</h3>'
        + '<p class="samguk-info-description">' + safeText(rule.description) + '</p>'
        + (url ? '<a class="samguk-info-source" href="' + url + '" target="_blank" rel="noopener">근거 보기</a>' : '')
        + '</article>';
    }).join('');
    root.innerHTML = '<div class="samguk-info-dashboard">'
      + (window.samgukSourceNoteHtml || '')
      + '<div class="samguk-info-grid">' + cards + '</div></div>';
  };

  setInterval(function () {
    if (!document.hidden && currentTab === 'samguk') window.loadSamgukData(true);
  }, REFRESH_INTERVAL_MS);
  window.addEventListener('online', function () {
    if (currentTab === 'samguk') window.loadSamgukData(true);
  });
})();
