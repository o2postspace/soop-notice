require("dotenv").config({ path: ".env.local" });
const http = require("http");
const fs = require("fs");
const path = require("path");
const { supabase } = require("./lib/supabase");
const { BJ_LIST } = require("./lib/bj-list");

const PORT = 3000;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/notices")) {
    try {
      const validIds = Object.keys(BJ_LIST);
      const { data, error } = await supabase
        .from("notices")
        .select("*")
        .in("bj_id", validIds)
        .order("reg_date", { ascending: false })
        .limit(1000);

      if (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url.startsWith("/api/updates")) {
    try {
      const { data, error } = await supabase
        .from("updates")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url.startsWith("/api/admin")) {
    try {
      const handler = require("./api/admin");
      const url = new URL(req.url, "http://localhost");
      const query = Object.fromEntries(url.searchParams);
      await handler({ query }, { status: (c) => ({ json: (d) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); } }) });
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url.startsWith("/api/feedback")) {
    try {
      const handler = require("./api/feedback");
      const url = new URL(req.url, "http://localhost");
      const query = Object.fromEntries(url.searchParams);
      await handler({ query }, { status: (c) => ({ json: (d) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); } }) });
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  let filePath = path.join(__dirname, "public", req.url === "/" ? "index.html" : req.url);
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log("http://localhost:" + PORT);
});
