// Google Sheets에서 충동서버 RPG 데이터를 가져와 크루 목록과 병합
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1v3MgOlW6UGvoYMGbOvWTTrp6TQ5Z5VywIXBDZYQRKA0/gviz/tq?tqx=out:csv&gid=296314716";

// 시트 길드명 → crew-list.js 크루명
const CREW_ALIAS = {
  "버컴": "버컴퍼니",
  "흥신소": "홍신소",
};

// 시트 스트리머명 → crew-list.js 멤버명
const NAME_ALIAS = {
  "마늘빵": "습늘빵",
  "아늉": "아눙",
  "몽씨": "묭씨",
  "예묘예묘": "예요예요",
};

function parseLine(line) {
  const result = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { result.push(cur.trim()); cur = ""; }
      else { cur += ch; }
    }
  }
  result.push(cur.trim());
  return result;
}

// 캐시 (5분)
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

function toInt(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }

async function fetchSheetData() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) return cache;

  const resp = await fetch(SHEET_CSV_URL);
  if (!resp.ok) throw new Error("Sheet fetch failed: " + resp.status);
  const text = await resp.text();
  const lines = text.trim().split("\n");

  // 인덱스 기반 파싱 (헤더가 불규칙하므로)
  // 0:←, 1:길드, 2:직업, 3:스트리머, 4:스킬, 5:Lv, 6:무기, 7:잠재, 8:투구, 9:상의, 10:하의, 11:신발
  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const crew = (cols[1] || "").trim();
    const streamer = (cols[3] || "").trim();
    if (!crew || !streamer || crew === "평균") continue;

    const crewName = CREW_ALIAS[crew] || crew;
    const memberName = NAME_ALIAS[streamer] || streamer;

    map[crewName + ":" + memberName] = {
      job: cols[2]?.trim() || null,
      skill: cols[4]?.trim() || null,
      level: toInt(cols[5]),
      weapon: toInt(cols[6]),
      potential: cols[7]?.trim() || null,
      helmet: toInt(cols[8]),
      armor: toInt(cols[9]),
      pants: toInt(cols[10]),
      boots: toInt(cols[11]),
    };
  }

  cache = map;
  cacheTime = now;
  return map;
}

// CREW_LIST와 시트 데이터를 병합
async function getCrewWithSheet(CREW_LIST) {
  let sheetMap;
  try {
    sheetMap = await fetchSheetData();
  } catch (e) {
    console.error("Sheet fetch error:", e.message);
    return CREW_LIST;
  }

  return CREW_LIST.map(crew => ({
    ...crew,
    members: crew.members.map(m => {
      const key = crew.name + ":" + m.name;
      const data = sheetMap[key];
      return data ? { ...m, ...data } : m;
    }),
  }));
}

module.exports = { fetchSheetData, getCrewWithSheet };
