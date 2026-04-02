import { CREW_LIST } from "../_shared/crew-list.js";

const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/1v3MgOlW6UGvoYMGbOvWTTrp6TQ5Z5VywIXBDZYQRKA0/gviz/tq?tqx=out:csv&gid=0";

const CREW_ALIAS = { "버컴": "버컴퍼니", "흥신소": "홍신소" };
const NAME_ALIAS = { "마늘빵": "습늘빵", "팸도은": "쨈도은", "아늉": "아눙", "몽씨": "묭씨", "예묘예묘": "예요예요", "용형": "에망" };

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

async function getCrewWithSheet() {
  const resp = await fetch(SHEET_CSV_URL);
  if (!resp.ok) throw new Error("Sheet fetch failed");
  const text = await resp.text();
  const rows = parseCSV(text);

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
      weapon,
    };
  }

  return CREW_LIST
    .map(crew => ({
      ...crew,
      members: crew.members
        .map(m => {
          const data = map[crew.name + ":" + m.name];
          return data ? { ...m, ...data } : null;
        })
        .filter(Boolean),
    }))
    .filter(crew => crew.members.length > 0);
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
