import { CREW_LIST } from "../_shared/crew-list.js";

const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1v3MgOlW6UGvoYMGbOvWTTrp6TQ5Z5VywIXBDZYQRKA0/gviz/tq?tqx=out:csv&gid=296314716";
const RANKING_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1v3MgOlW6UGvoYMGbOvWTTrp6TQ5Z5VywIXBDZYQRKA0/gviz/tq?tqx=out:csv&gid=722671070";

const CREW_ALIAS = { "버컴": "버컴퍼니", "흥신소": "홍신소" };
const NAME_ALIAS = { "마늘빵": "습늘빵", "아늉": "아눙", "몽씨": "묭씨", "예묘예묘": "예요예요" };

function parseLine(line) {
  const result = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ',') { result.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

function toInt(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }

async function getCrewWithSheet() {
  const [sheetResp, rankResp] = await Promise.all([fetch(SHEET_CSV_URL), fetch(RANKING_CSV_URL)]);
  if (!sheetResp.ok) throw new Error("Sheet fetch failed");

  const text = await sheetResp.text();
  const lines = text.trim().split("\n");

  // 인덱스 기반 파싱
  // 0:←, 1:길드, 2:직업, 3:스트리머, 4:스킬, 5:Lv, 6:무기, 7:투구옵션, 8:방어구투구, 9:상의, 10:하의, 11:신발
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
      armor: toInt(cols[9]),
      pants: toInt(cols[10]),
      boots: toInt(cols[11]),
    };
  }

  // 무력 랭킹 시트: 16:순위, 17:소속, 18:직업, 19:이름, 20:점수
  const rankMap = {};
  if (rankResp.ok) {
    const rankText = await rankResp.text();
    const rankLines = rankText.trim().split("\n");
    for (let i = 1; i < rankLines.length; i++) {
      const cols = parseLine(rankLines[i]);
      const crew = (cols[17] || "").trim();
      const name = (cols[19] || "").trim();
      const scoreStr = (cols[20] || "").replace(/,/g, "").trim();
      const score = toInt(scoreStr);
      if (!crew || !name || score == null) continue;
      const crewName = CREW_ALIAS[crew] || crew;
      const memberName = NAME_ALIAS[name] || name;
      rankMap[crewName + ":" + memberName] = score;
    }
  }

  return CREW_LIST.map(crew => ({
    ...crew,
    members: crew.members.map(m => {
      const key = crew.name + ":" + m.name;
      const data = map[key];
      const power = rankMap[key];
      const merged = data ? { ...m, ...data } : m;
      if (power != null) merged.power = power;
      return merged;
    }),
  }));
}

export async function onRequestGet() {
  try {
    const data = await getCrewWithSheet();
    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "s-maxage=60, stale-while-revalidate=120",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify(CREW_LIST), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}
