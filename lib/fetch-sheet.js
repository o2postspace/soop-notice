// Google Sheets에서 충동서버 RPG 데이터를 가져와 크루 목록과 병합
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1v3MgOlW6UGvoYMGbOvWTTrp6TQ5Z5VywIXBDZYQRKA0/gviz/tq?tqx=out:csv&gid=1194201508";

// 시트 길드명 → crew-list.js 크루명
const CREW_ALIAS = {
  "버컴": "버컴퍼니",
  "흥신소": "홍신소",
};

// 시트 스트리머명 → crew-list.js 멤버명
const NAME_ALIAS = {
  "마늘빵": "습늘빵",
  "팸도은": "쨈도은",
  "아늉": "아눙",
  "몽씨": "묭씨",
  "예묘예묘": "예요예요",
  "용형": "에망",
};

// 간단 CSV 파서 (따옴표 처리)
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = parseLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ""; });
    return obj;
  });
}

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

async function fetchSheetData() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) return cache;

  const resp = await fetch(SHEET_CSV_URL);
  if (!resp.ok) throw new Error("Sheet fetch failed: " + resp.status);
  const text = await resp.text();
  const rows = parseCSV(text);

  // name → { job, skill, level, weapon }
  const map = {};
  for (const row of rows) {
    const crewName = CREW_ALIAS[row["길드"]] || row["길드"];
    const memberName = NAME_ALIAS[row["스트리머"]] || row["스트리머"];
    const level = parseInt(row["Lv"], 10);
    const weapon = row["무기"] ? parseInt(row["무기"], 10) : null;
    map[crewName + ":" + memberName] = {
      job: row["직업"] || null,
      skill: row["스킬"] || null,
      level: isNaN(level) ? null : level,
      weapon: weapon,
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
    // 시트 접근 실패 시 기존 데이터 그대로 반환
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
