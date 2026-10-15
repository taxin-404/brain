/** Inspector UI (design §8 phase 6): a single self-contained read-only page.
 *  The shell is unauthenticated **by design and contains zero brain data** —
 *  no facts, no tokens. The operator pastes a read token which lives only in
 *  `sessionStorage` and rides every data call as a bearer header, so the same
 *  page works against any deployment. No build step, no CDN, no tracking. */

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>brain · inspector</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: #0d1117; color: #c9d1d9; }
  header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 16px; background: #161b22; border-bottom: 1px solid #30363d; position: sticky; top: 0; }
  h1 { font-size: 15px; margin: 0 12px 0 0; color: #58a6ff; }
  main { padding: 16px; display: grid; gap: 16px; max-width: 1100px; }
  section { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 14px; }
  h2 { font-size: 13px; margin: 0 0 8px; color: #8b949e; text-transform: uppercase; letter-spacing: .08em; }
  input, button { font: inherit; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 4px 8px; }
  button { cursor: pointer; color: #58a6ff; }
  button:hover { border-color: #58a6ff; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; color: #7ee787; }
  #results { white-space: pre-wrap; margin-top: 8px; color: #d2a8ff; }
  ul { list-style: none; margin: 8px 0 0; padding: 0; }
  li a { color: #58a6ff; text-decoration: none; }
  #proc-detail { margin-top: 8px; color: #79c0ff; }
  #ts { color: #8b949e; }
</style>
</head>
<body>
<header>
  <h1>brain inspector</h1>
  <input id="token" type="password" size="30" placeholder="read token (sessionStorage only)">
  <button id="save">use</button>
  <span id="ts"></span>
</header>
<main>
  <section><h2>health</h2><pre id="health-body">enter a token to load</pre></section>
  <section><h2>search</h2><input id="q" size="40" placeholder="query">
    <button id="go">search</button><div id="results"></div></section>
  <section><h2>procedures</h2><button id="refresh-procs">refresh</button>
    <ul id="proc-list"></ul><pre id="proc-detail"></pre></section>
  <section><h2>latest reflection</h2><pre id="refl-body">–</pre></section>
</main>
<script>
var $ = function (id) { return document.getElementById(id); };
function token() { return sessionStorage.getItem("brain_token") || ""; }
async function api(path) {
  var res = await fetch(path, { headers: { authorization: "Bearer " + token() } });
  if (!res.ok) throw new Error(path + " -> " + res.status);
  return res.json();
}
async function loadHealth() {
  try { $("health-body").textContent = JSON.stringify(await api("/v1/health-report"), null, 2); }
  catch (e) { $("health-body").textContent = String(e); }
}
async function doSearch() {
  var q = $("q").value.trim();
  if (!q) return;
  try {
    var d = await api("/v1/search?q=" + encodeURIComponent(q));
    var out = [];
    (d.facts || []).forEach(function (f) { out.push("fact  " + (f.object_text || f.id) + "  [" + (f.fact_kind || "?") + " · " + (f.status || "?") + "]"); });
    (d.results || []).forEach(function (r) { out.push("event " + (r.excerpt || r.id)); });
    if (d.degraded) out.push("(vector search degraded — keyword only)");
    $("results").textContent = out.join("\\n") || "(no matches)";
  } catch (e) { $("results").textContent = String(e); }
}
async function loadProcs() {
  try {
    var d = await api("/v1/procedures");
    var ul = $("proc-list");
    ul.innerHTML = "";
    (d.procedures || []).forEach(function (p) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = "#";
      a.textContent = p.name + " · " + p.status + " · v" + p.current_version;
      a.onclick = function () { loadProc(p.id); return false; };
      li.appendChild(a);
      ul.appendChild(li);
    });
  } catch (e) { $("proc-list").textContent = String(e); }
}
async function loadProc(id) {
  try { $("proc-detail").textContent = JSON.stringify(await api("/v1/procedures/" + encodeURIComponent(id)), null, 2); }
  catch (e) { $("proc-detail").textContent = String(e); }
}
async function loadRefl() {
  try { $("refl-body").textContent = JSON.stringify(await api("/v1/reflections/latest"), null, 2); }
  catch (e) { $("refl-body").textContent = String(e); }
}
function boot() {
  if (token()) { $("token").value = "••••"; $("ts").textContent = "token set"; loadHealth(); loadProcs(); loadRefl(); }
}
$("save").onclick = function () {
  sessionStorage.setItem("brain_token", $("token").value.trim());
  $("token").value = "••••";
  $("ts").textContent = "token set";
  loadHealth(); loadProcs(); loadRefl();
};
$("go").onclick = doSearch;
$("q").addEventListener("keydown", function (e) { if (e.key === "Enter") doSearch(); });
$("refresh-procs").onclick = loadProcs;
boot();
</script>
</body>
</html>
`;

export function handleInspector(): Response {
  return new Response(PAGE, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      "cache-control": "no-store",
    },
  });
}
