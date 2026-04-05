const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1v3MgOlW6UGvoYMGbOvWTTrp6TQ5Z5VywIXBDZYQRKA0/gviz/tq?tqx=out:csv&gid=296314716';

module.exports = async function handler(req, res) {
  try {
    const resp = await fetch(SHEET_CSV_URL);
    const text = await resp.text();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
