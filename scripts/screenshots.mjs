#!/usr/bin/env node
// Takes screenshots of the demo (demo/screenshots/*.png, not committed): starts the mock server
// (demo/server.js, invented data only), drives headless Chromium over the DevTools protocol (Node's
// built-in WebSocket, Node 22+), no npm dependencies.
// Usage: node scripts/screenshots.mjs      (CHROME=/path/to/chromium to override the browser)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "demo", "screenshots");
const PORT = 8790, CDP = 9339;
const CHROME = process.env.CHROME || "chromium";
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [path.join(ROOT, "demo", "server.js"), String(PORT)], { stdio: "ignore" });
const profile = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "spn-shots-"));
// detached: Chromium gets its own process group, so the browser and all its helper processes are ended together
const chrome = spawn(CHROME, ["--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
let chromeExited = false;
chrome.on("exit", () => { chromeExited = true; });

// End the browser in every case (done, error, Ctrl-C, kill): the process group gets SIGTERM, then SIGKILL
// if it is still there after 3 s; the profile is removed once the browser is gone.
function killChrome(signal) {
  if (chromeExited) return;
  try { process.kill(-chrome.pid, signal); } catch (e) { try { chrome.kill(signal); } catch (x) { /* gone */ } }
}
let cleaning = null;
function cleanup() {
  if (!cleaning)
    cleaning = (async () => {
      server.kill();
      killChrome("SIGTERM");
      for (let i = 0; i < 30 && !chromeExited; i++) await sleep(100);
      killChrome("SIGKILL");
      await sleep(200);
      fs.rmSync(profile, { recursive: true, force: true });
    })();
  return cleaning;
}
process.on("exit", () => { killChrome("SIGKILL"); server.kill(); }); // last resort, synchronous
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => cleanup().then(() => process.exit(130)));
process.on("uncaughtException", (e) => { console.error(e); cleanup().then(() => process.exit(1)); });
process.on("unhandledRejection", (e) => { console.error(e); cleanup().then(() => process.exit(1)); });

async function json(url, opts) {
  for (let i = 0; i < 50; i++) {
    try { return await (await fetch(url, opts)).json(); } catch (e) { await sleep(200); }
  }
  throw new Error("no answer from " + url);
}
setTimeout(() => { console.error("timeout after 5 minutes"); cleanup().then(() => process.exit(1)); }, 300000).unref();
await json(`http://127.0.0.1:${PORT}/graphql`, { method: "POST", body: "{}" });
const target = await json(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: "PUT" });
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  } else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
});
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expr, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await evaluate(expr)) return; } catch (e) { /* not yet */ } await sleep(200); }
  throw new Error("timeout: " + expr);
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64"));
  console.log("demo/screenshots/" + name);
};
const H = "window.performerNetwork";
const open = async (lang) => {
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/performer-network?lang=${lang}` });
  await waitFor(`!!document.querySelector('.spn-page[data-ready]')`);
  // every node drawn large enough for an image has its crop
  await waitFor(`(() => { const p = ${H}.faceProgress(); return p.busy === 0 && p.done === p.wanted; })()`, 120000);
  await sleep(600);
};
const pos = (id) => evaluate(`(() => { const v = ${H}; const d = v.network.canvasToDOM(v.network.getPositions([${JSON.stringify(id)}])[${JSON.stringify(id)}]); const r = v.canvas.getBoundingClientRect(); return { x: r.left + d.x, y: r.top + d.y }; })()`);
const hub = `(() => { const v = ${H}; let b = null, n = -1; v.graph.nodes.forEach(id => { const k = Object.keys(v.graph.neighbours[id] || {}).length; if (k > n) { n = k; b = id; } }); return b; })()`;

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

await open("en");
await shot("overview.png");

// edge detail with image sets opened
const edge = await evaluate(`(() => { const v = ${H}; const e = v.graph.edges.slice().sort((a, b) => b.weight - a.weight)[0]; v.showEdgeDetail(e.from + '-' + e.to); return e.from + '-' + e.to; })()`);
await waitFor(`!!document.querySelector('.spn-detail .spn-tiles')`); // scene details are loaded on opening
await evaluate(`(() => { const s = document.querySelector('.spn-detail details.spn-sets'); if (s) s.open = true; return true; })()`);
await sleep(800);
await shot("edge-detail.png");

// highlight + hover card
await evaluate(`${H}.clearMode(), true`);
const h = await evaluate(hub);
await evaluate(`${H}.focusPerformer(${JSON.stringify(h)}, false), true`);
const p = await pos(h);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x - 30, y: p.y - 30 });
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
await sleep(700);
await shot("highlight.png");
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1430, y: 890 });

// shortest path between the hub and the farthest reachable performer
await evaluate(`(() => { const v = ${H}, nb = v.graph.neighbours, h = ${JSON.stringify(h)}; const d = { [h]: 0 }, q = [h];
  while (q.length) { const u = q.shift(); Object.keys(nb[u] || {}).forEach(w => { if (d[w] == null) { d[w] = d[u] + 1; q.push(w); } }); }
  const far = Object.keys(d).sort((a, b) => d[b] - d[a])[0]; v.clearMode(); v.hideCard(); v.showPath(h, far); return true; })()`);
await sleep(900);
await shot("path.png");

// settings dialog (German UI)
await open("de");
await evaluate(`${H}.openSettings(), true`);
await sleep(400);
await shot("settings-de.png");

if (errors.length) { console.error("page errors:\n" + errors.join("\n")); process.exitCode = 1; }
await cleanup();
process.exit();
