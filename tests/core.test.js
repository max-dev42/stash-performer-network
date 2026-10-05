"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../plugin/stash-performer-network-core.js");
const fx = require("./fixture.js");

const base = () => C.prepareData(fx.data());
const graph = (f) => C.computeGraph(base(), fx.filters(f));
const weights = (g) => Object.fromEntries(g.edges.map((e) => [e.from + "-" + e.to, e.weight]));

test("prepareData: studios with child counts, tags, genders, settings", () => {
  const b = base();
  assert.equal(b.scenes.length, 5);
  assert.equal(b.studios["10"].scenes, 4); // own 3 + child's 1
  assert.equal(b.studios["11"].scenes, 1);
  assert.deepEqual(b.tags.t2.aliases, ["second"]);
  assert.deepEqual(b.genders, ["MALE", "FEMALE", "NON_BINARY", "UNKNOWN"]);
  assert.equal(b.settings.labelZoom, 5);
  assert.equal(b.scenes[0].group.id, "1");
  assert.equal(b.scenes[0].screenshot, "scene/1/screenshot");
});

test("counting by scenes: every shared scene counts 1", () => {
  const g = graph({});
  assert.deepEqual(weights(g), { "1-2": 4, "1-3": 1, "2-3": 1, "3-4": 1, "1-5": 1, "1-6": 1, "2-5": 1, "2-6": 1, "5-6": 1 });
  assert.equal(g.tooBig, 0);
  const e = g.edges.find((x) => x.from === "1" && x.to === "2");
  assert.equal(e.scenes.length, 4);
  assert.equal(e.units.length, 3); // group 1, scene 3, scene 5
});

test("counting by productions: scenes of one group count once", () => {
  const w = weights(graph({ countBy: "productions" }));
  assert.equal(w["1-2"], 3);
  assert.equal(w["1-3"], 1);
  assert.equal(w["2-3"], 1);
});

test("productions mode lists only the scenes both performers are in", () => {
  const g = graph({ countBy: "productions" });
  const e = g.edges.find((x) => x.from === "1" && x.to === "3");
  assert.deepEqual(e.scenes.map((s) => s.id), ["2"]);
});

test("max performers: larger scenes/productions are not paired", () => {
  const g = graph({ maxCast: 3 });
  assert.equal(g.tooBig, 1);
  assert.equal(weights(g)["1-2"], 3);
  assert.equal(weights(g)["5-6"], undefined);
  const gp = graph({ maxCast: 2, countBy: "productions" });
  assert.equal(gp.tooBig, 2); // group 1 (3 performers) and scene 5
});

test("filters: studio subtree, tags any/all, minimum strength", () => {
  assert.equal(graph({ studio: "10" }).sceneCount, 4);
  assert.equal(graph({ studio: "11" }).sceneCount, 1);
  assert.equal(graph({ tags: ["t1", "t2"] }).sceneCount, 3);
  assert.equal(graph({ tags: ["t1", "t2"], tagMode: "all" }).sceneCount, 1);
  assert.deepEqual(Object.keys(weights(graph({ minStrength: 2 }))), ["1-2"]);
});

test("filters: favorites only / with partners, gender", () => {
  assert.deepEqual(Object.keys(weights(graph({ favOn: true, favMode: "partners" }))).sort(), ["1-3", "2-3", "3-4"]);
  assert.deepEqual(graph({ favOn: true, favMode: "only" }).edges, []);
  const noMale = graph({ genders: { MALE: false, FEMALE: true, NON_BINARY: true, UNKNOWN: true } });
  assert.ok(!noMale.nodes.includes("2"));
});

test("filters: ratings, watched, orgasm count", () => {
  assert.equal(graph({ sceneStars: 4 }).sceneCount, 1);
  assert.equal(graph({ watchedOnly: true }).sceneCount, 1);
  assert.equal(graph({ orgasmOnly: true }).sceneCount, 1);
  assert.deepEqual(Object.keys(weights(graph({ perfStars: 4, perfStarsPartners: false }))), []);
  assert.deepEqual(Object.keys(weights(graph({ perfOrgasm: true }))).sort(), ["1-3", "2-3", "3-4"]);
});

test("shortest path: fewest steps, ties go to the stronger edges", () => {
  const nb = { a: { b: 1, c: 3 }, b: { a: 1, d: 1 }, c: { a: 3, d: 3 }, d: { b: 1, c: 3, e: 1 }, e: { d: 1 }, x: { y: 1 }, y: { x: 1 } };
  assert.deepEqual(C.shortestPath({ neighbours: nb }, "a", "d"), ["a", "c", "d"]);
  assert.deepEqual(C.shortestPath({ neighbours: nb }, "a", "e"), ["a", "c", "d", "e"]);
  assert.equal(C.shortestPath({ neighbours: nb }, "a", "x"), null);
  // a longer path is never preferred, however strong
  const nb2 = { a: { b: 1, c: 9 }, b: { a: 1, z: 1 }, c: { a: 9, d: 9 }, d: { c: 9, z: 9 }, z: { b: 1, d: 9 } };
  assert.deepEqual(C.shortestPath({ neighbours: nb2 }, "a", "z"), ["a", "b", "z"]);
});

test("settings: parsing, defaults, invalid values", () => {
  const s = C.readSettings({ labelZoom: "99", nodeSizeBy: "nonsense", defaultMaxCast: 0, genderColors: "{bad json", defaultFilters: '{"studio":"3"}', disableFaceCrops: "true" });
  assert.equal(s.labelZoom, 24); // clamped
  assert.equal(s.nodeSizeBy, "scenes"); // unknown option -> default
  assert.equal(s.defaultMaxCast, 12); // 0 = unset in Stash's UI
  assert.deepEqual(s.genderColors, {});
  assert.deepEqual(s.defaultFilters, { studio: "3" });
  assert.equal(s.disableFaceCrops, true);
  const d = C.readSettings(null);
  C.SETTINGS.forEach((x) => { if (x.key !== "storeFaces") assert.deepEqual(d[x.key], x.def); });
});

test("settings: storing face positions is off by default, no silent change for existing face data", () => {
  assert.deepEqual(C.effectiveStoreFaces({}, false), { value: false, source: "default" });
  assert.deepEqual(C.effectiveStoreFaces({}, true), { value: true, source: "existingData" });
  assert.deepEqual(C.effectiveStoreFaces({ storeFaces: false }, true), { value: false, source: "setting" });
  assert.deepEqual(C.effectiveStoreFaces({ storeFaces: true }, false), { value: true, source: "setting" });
  assert.deepEqual(C.effectiveStoreFaces({ disableFaceWriteback: true }, true), { value: false, source: "legacy" });
  assert.deepEqual(C.effectiveStoreFaces({ disableFaceWriteback: false }, false), { value: true, source: "legacy" });
  // saving always writes storeFaces explicitly (so "off" survives), defaults of other keys are left out
  const input = C.settingsInput(Object.assign(C.readSettings({}), { storeFaces: false, labelZoom: 4, genderColors: { FEMALE: "#ff8800" } }));
  assert.deepEqual(input, { storeFaces: false, labelZoom: 4, genderColors: '{"FEMALE":"#ff8800"}' });
});

test("settings: renamed keys and values fall back to the old names", () => {
  // stored by earlier versions: nodeSizeBy "o", defaultFilters.oOnly
  const old = C.readSettings({ nodeSizeBy: "o", defaultFilters: '{"studio":"3","oOnly":true}' });
  assert.equal(old.nodeSizeBy, "orgasms");
  assert.deepEqual(old.defaultFilters, { studio: "3", orgasmOnly: true });
  // the new key wins when both are stored
  const both = C.readSettings({ defaultFilters: '{"orgasmOnly":false,"oOnly":true}' });
  assert.deepEqual(both.defaultFilters, { orgasmOnly: false });
  assert.equal(C.readSettings({ nodeSizeBy: "orgasms" }).nodeSizeBy, "orgasms");
  // saving writes only the new names
  assert.deepEqual(C.settingsInput(old), { storeFaces: false, nodeSizeBy: "orgasms", defaultFilters: '{"studio":"3","orgasmOnly":true}' });
});

test("URL parameters: renamed names and values are still accepted", () => {
  const q = (s) => new URLSearchParams(s);
  assert.equal(C.queryParam(q("orgasms=1"), "orgasms"), "1");
  assert.equal(C.queryParam(q("o=1"), "orgasms"), "1");
  assert.equal(C.queryParam(q("orgasms=0&o=1"), "orgasms"), "0");
  assert.equal(C.queryParam(q(""), "orgasms"), null);
  assert.equal(C.queryParam(q("size=o"), "size"), "orgasms");
  assert.equal(C.queryParam(q("size=scenes"), "size"), "scenes");
});

test("i18n: placeholders, plurals, numbers, fallback to English", () => {
  const en = { a: "Hello {name}", n_one: "{count} item", n_other: "{count} items", only: "English only" };
  const de = { a: "Hallo {name}", n_one: "{count} Eintrag", n_other: "{count} Einträge" };
  const i = new C.I18n("de-DE", de, en);
  assert.equal(i.t("a", { name: "Ada" }), "Hallo Ada");
  assert.equal(i.t("n", { count: 1 }), "1 Eintrag");
  assert.equal(i.t("n", { count: 1234 }), "1.234 Einträge");
  assert.equal(i.t("only"), "English only");
  assert.equal(i.t("missing.key"), "missing.key");
  assert.equal(i.t("a"), "Hallo {name}");
  assert.equal(i.date("2024-03-05"), "05.03.2024");
});

test("face data: field parsing, checksum, box conversion, local URLs", () => {
  const ok = { custom_fields: { spn_face: JSON.stringify({ v: C.FACE_VERSION, h: "x:1", b: [0.1, 0.2, 0.3, 0.4] }) } };
  assert.deepEqual(C.readFaceField(ok).b, [0.1, 0.2, 0.3, 0.4]);
  assert.equal(C.readFaceField({ custom_fields: { spn_face: '{"v":"old","h":"x"}' } }), null);
  assert.equal(C.readFaceField({ custom_fields: { spn_face: "{broken" } }), null);
  assert.equal(C.readFaceField({ custom_fields: {} }), null);
  assert.equal(C.bytesHash(new TextEncoder().encode("abc").buffer), "1a47e90b:3"); // FNV-1a 32
  const img = { width: 200, height: 400 };
  const px = C.boxToPixels(img, [0.25, 0.5, 0.1, 0.05]);
  assert.deepEqual(px, { originX: 50, originY: 200, width: 20, height: 20 });
  assert.deepEqual(C.boxToNormal(img, px), [0.25, 0.5, 0.1, 0.05]);
  assert.equal(C.localUrl("http://example.invalid:9999/performer/1/image?t=5"), "performer/1/image?t=5");
  assert.equal(C.localUrl(null), null);
});

test("request guard: refuses only foreign requests made by the bundled MediaPipe code", () => {
  const origin = "http://stash.local:9999";
  const mp = "Error\n    at blocked (http://stash.local:9999/plugin/stash-performer-network/assets/stash-performer-network.js:1:1)\n" +
    "    at Ah.send (http://stash.local:9999/plugin/stash-performer-network/assets/vendor/mediapipe/vision_bundle.js:7:2)";
  const other = "Error\n    at loadStuff (http://stash.local:9999/assets/index.js:1:1)";
  assert.equal(C.blockedRequest("https://odml.pa.googleapis.com/v1/log", origin, mp), "odml.pa.googleapis.com");
  assert.equal(C.blockedRequest("https://example.invalid/x", origin, other), null); // not from MediaPipe
  assert.equal(C.blockedRequest("plugin/stash-performer-network/assets/vendor/mediapipe/model.tflite", origin, mp), null); // same origin, relative
  assert.equal(C.blockedRequest("http://stash.local:9999/graphql", origin, mp), null);
  assert.equal(C.blockedRequest("http://stash.local:8080/x", origin, mp), "stash.local:8080"); // other port = other origin
  assert.equal(C.blockedRequest("data:application/octet-stream;base64,AA==", origin, mp), null);
  assert.equal(C.blockedRequest("https://odml.pa.googleapis.com/v1/log", origin, ""), null);
});

test("request guard: only while installed, same origin passes untouched, originals restored", async () => {
  const calls = [];
  const fetch0 = async (u) => (calls.push(["fetch", u]), "ok");
  const beacon0 = (u) => (calls.push(["beacon", u]), true);
  function XHR() {}
  const open0 = function (m, u) { calls.push(["open", u]); };
  const send0 = function () { calls.push(["send"]); };
  XHR.prototype.open = open0;
  XHR.prototype.send = send0;
  const win = { location: { origin: "http://stash.local:9999" }, fetch: fetch0, navigator: { sendBeacon: beacon0 }, XMLHttpRequest: XHR };
  let stack = "", stacksTaken = 0;
  const refused = [];
  const g = C.createRequestGuard(win, (h) => refused.push(h), () => (stacksTaken++, stack));
  const mp = "at send (http://stash.local:9999/plugin/stash-performer-network/assets/vendor/mediapipe/vision_bundle.js:7:2)";

  g.install();
  assert.notEqual(win.fetch, fetch0);
  // same origin, also from MediaPipe: passes, and the call stack is not even looked at
  stack = mp;
  assert.equal(await win.fetch("graphql"), "ok");
  assert.equal(await win.fetch("http://stash.local:9999/performer/1/image"), "ok");
  assert.equal(stacksTaken, 0);
  // foreign host from MediaPipe: refused (fetch, beacon, XHR)
  await assert.rejects(win.fetch("https://odml.pa.googleapis.com/v1/log"));
  assert.equal(win.navigator.sendBeacon("https://odml.pa.googleapis.com/v1/log"), false);
  assert.deepEqual(refused, ["odml.pa.googleapis.com", "odml.pa.googleapis.com"]);
  // foreign host from other code: passes
  stack = "at loadStuff (http://stash.local:9999/assets/index.js:1:1)";
  assert.equal(await win.fetch("https://example.invalid/x"), "ok");
  assert.deepEqual(calls, [["fetch", "graphql"], ["fetch", "http://stash.local:9999/performer/1/image"], ["fetch", "https://example.invalid/x"]]);

  // after the detector is gone: the original functions again
  g.uninstall();
  assert.equal(win.fetch, fetch0);
  assert.equal(win.navigator.sendBeacon, beacon0);
  assert.equal(XHR.prototype.open, open0);
  assert.equal(XHR.prototype.send, send0);
  assert.equal(g.active(), false);

  // wrapped again by someone else meanwhile: ours stays underneath and passes everything through
  g.install();
  const ours = win.fetch;
  win.fetch = function () { return ours.apply(this, arguments); };
  g.uninstall();
  stack = mp;
  assert.equal(await win.fetch("https://odml.pa.googleapis.com/v1/log"), "ok");
  g.install(); // and refuses again once installed again
  await assert.rejects(win.fetch("https://odml.pa.googleapis.com/v1/log"));
});

test("images with many nodes on screen: the largest get one, at most max", () => {
  assert.equal(C.imageMinRadius([3, 9, 20, 8], 800, 8), 8); // few nodes: everyone from 8 px
  const radii = Array.from({ length: 1000 }, (_, i) => 4 + i * 0.02); // 4 .. 23.98 px
  const min = C.imageMinRadius(radii, 300, 8);
  const taken = radii.filter((r) => r >= min).length;
  assert.equal(taken, 300);
  assert.ok(radii.filter((r) => r >= 8).length > 300);
  // equal sizes at the cut: none of them rather than a random part
  const same = C.imageMinRadius([10, 10, 10, 12], 2, 8);
  assert.deepEqual([10, 10, 10, 12].filter((r) => r >= same), [12]);
});

// The plugin's main query: ids per scene, performers and groups once, tags and scene details later.
function slimData() {
  const d = fx.data();
  const performers = {};
  d.findScenes.scenes.forEach((sc) => sc.performers.forEach((p) => (performers[p.id] = p)));
  return {
    full: d,
    slim: Object.assign({}, d, {
      findScenes: { scenes: d.findScenes.scenes.map((sc) => ({
        id: sc.id, rating100: sc.rating100, play_count: sc.play_count, o_counter: sc.o_counter,
        performers: sc.performers.map((p) => ({ id: p.id })), groups: sc.groups.map((g) => ({ group: { id: g.group.id } })),
        studio: sc.studio ? { id: sc.studio.id } : null,
      })) },
      findPerformers: { performers: Object.values(performers) },
      findGroups: { groups: [{ id: "1", name: "Group One" }] },
    }),
  };
}

test("slim data: same network as the full data once tags are attached", () => {
  const { full, slim } = slimData();
  const b = C.prepareData(slim);
  assert.equal(b.tagsLoaded, false);
  assert.equal(b.performers["3"].name, "Person 3");
  assert.equal(b.scenes[0].group.name, "Group One");
  assert.equal(b.scenes[0].detail, false);
  assert.deepEqual(weights(C.computeGraph(b, fx.filters({}))), weights(graph({})));
  assert.deepEqual(weights(C.computeGraph(b, fx.filters({ countBy: "productions", studio: "10" }))), weights(graph({ countBy: "productions", studio: "10" })));
  // a tag filter before the tags are there is marked as not final instead of silently empty
  const pending = C.computeGraph(b, fx.filters({ tags: ["t1"] }));
  assert.equal(pending.tagsPending, true);
  const tagged = full.findScenes.scenes.map((sc) => ({ id: sc.id, tags: sc.tags.map((t) => ({ id: t.id })) }));
  C.attachTags(b, tagged.slice(0, 3), false); // first page
  assert.equal(b.tagsLoaded, false);
  C.attachTags(b, tagged.slice(2, 3), false); // a scene sent twice is counted once
  C.attachTags(b, tagged.slice(3), true); // last page
  assert.equal(b.tagsLoaded, true);
  assert.equal(b.tags.t2.scenes, 2);
  assert.deepEqual(b.tags.t2.aliases, ["second"]);
  const g = C.computeGraph(b, fx.filters({ tags: ["t1", "t2"], tagMode: "all" }));
  assert.equal(g.tagsPending, false);
  assert.equal(g.sceneCount, 1);
  assert.equal(C.computeGraph(base(), fx.filters({ tags: ["t1"] })).tagsPending, false);
});

test("slim data: scene details are attached on demand", () => {
  const { full, slim } = slimData();
  const b = C.prepareData(slim);
  C.attachSceneDetails(b, [{ id: "1", title: "", date: "2024-01-01", files: [{ basename: "one.mp4" }], paths: { screenshot: "http://h/scene/1/screenshot" },
    galleries: [{ id: "7", title: null, image_count: 3, paths: { cover: "http://h/gallery/7/cover" }, folder: { path: "/x/Set A" }, files: [] }] }]);
  const sc = b.sceneById["1"];
  assert.equal(sc.detail, true);
  assert.equal(sc.title, "one.mp4");
  assert.equal(sc.screenshot, "scene/1/screenshot");
  assert.deepEqual(sc.galleries, [{ id: "7", title: "Set A", images: 3, cover: "gallery/7/cover" }]);
  assert.equal(b.sceneById["2"].detail, false);
  assert.equal(C.prepareData(full).sceneById["2"].detail, true); // full shape: details right away
});

test("start limit: favorites with their strongest partners, else the most connected", () => {
  const b = base();
  const g = C.computeGraph(b, fx.filters({}));
  assert.equal(C.limitGraph(g, b, 6), g); // small enough: unchanged
  assert.equal(C.limitGraph(g, b, 0), g);
  const lf = C.limitGraph(g, b, 3); // favorite 3, then partners 1, 2, 4 tie at 1 -> most connected first
  assert.deepEqual(lf.nodes.slice().sort(), ["1", "2", "3"]);
  assert.deepEqual(Object.keys(weights(lf)).sort(), ["1-2", "1-3", "2-3"]);
  assert.deepEqual(lf.limited, { shown: 3, total: 6, by: "favorites" });
  assert.deepEqual(Object.keys(lf.neighbours["3"]).sort(), ["1", "2"]);
  assert.equal(g.nodes.length, 6); // the full graph is not changed
  // every favorite brings its strongest partner first, even if others have stronger ties to favorites
  const star = { nodes: ["1", "2", "3", "4", "5"], edges: [{ from: "1", to: "3", weight: 5 }, { from: "1", to: "4", weight: 4 }, { from: "2", to: "5", weight: 1 }],
    neighbours: { 1: { 3: 5, 4: 4 }, 2: { 5: 1 }, 3: { 1: 5 }, 4: { 1: 4 }, 5: { 2: 1 } } };
  const ls = C.limitGraph(star, { performers: { 1: { favorite: true }, 2: { favorite: true }, 3: {}, 4: {}, 5: {} } }, 4);
  assert.deepEqual(ls.nodes, ["1", "2", "3", "5"]);
  b.performers["3"].favorite = false;
  const lc = C.limitGraph(g, b, 3); // 1 and 2 have 4 partners; 3, 5, 6 have 3 with equal strength -> lowest id
  assert.deepEqual(lc.nodes.slice().sort(), ["1", "2", "3"]);
  assert.equal(lc.limited.by, "connected");
  // a chosen performer whose partners are all outside the view is left out
  const E = (a, b) => ({ from: a, to: b, weight: 1 });
  const edges = [E("1", "2"), E("1", "5"), E("2", "5"), E("3", "4")];
  const nbh = {};
  edges.forEach((e) => { (nbh[e.from] = nbh[e.from] || {})[e.to] = 1; (nbh[e.to] = nbh[e.to] || {})[e.from] = 1; });
  const people = { 1: {}, 2: {}, 3: {}, 4: {}, 5: {}, 6: {} };
  // limit 4 picks 1, 2, 5 and then 3 (tie with 4, lower id); 3 has no partner in the view -> left out;
  // 6 was isolated in the full graph already (shown because of "performers without edges") -> not chosen
  const lone = C.limitGraph({ nodes: ["1", "2", "3", "4", "5", "6"], edges, neighbours: nbh }, { performers: people }, 4);
  assert.deepEqual(lone.nodes, ["1", "2", "5"]);
  assert.deepEqual(lone.limited, { shown: 3, total: 6, by: "connected" });
});

test("settings: start limit", () => {
  assert.equal(C.readSettings({}).startLimit, 400);
  assert.equal(C.readSettings({ startLimit: 0 }).startLimit, 400); // Stash shows an unset NUMBER as 0
  assert.equal(C.readSettings({ startLimit: 20 }).startLimit, 50);
  assert.equal(C.readSettings({ startLimit: "1200" }).startLimit, 1200);
});

test("layout for large networks: deterministic, finite, connected performers end up closer", () => {
  // two groups of 20 (rings with chords to the next three), joined by one edge
  const edges = [];
  for (let g = 0; g < 2; g++) for (let i = 0; i < 20; i++) for (let d = 1; d <= 3; d++) edges.push(g * 20 + i, g * 20 + ((i + d) % 20));
  edges.push(0, 20);
  const input = () => ({ n: 40, edges: Int32Array.from(edges), radius: new Float64Array(40).fill(12), params: C.LAYOUT_PARAMS });
  const reports = [];
  const a = C.runLayout(input(), (x, y, it, done) => reports.push(done));
  const b = C.runLayout(input());
  assert.deepEqual(Array.from(a.x), Array.from(b.x)); // same seed, same layout
  assert.ok(a.iterations >= 1 && a.iterations <= C.LAYOUT_PARAMS.iterations);
  assert.equal(reports[reports.length - 1], true); // the last report is the final one
  assert.ok(Array.from(a.x).concat(Array.from(a.y)).every(Number.isFinite));
  const centre = (g) => { let x = 0, y = 0; for (let i = g * 20; i < g * 20 + 20; i++) { x += a.x[i]; y += a.y[i]; } return [x / 20, y / 20]; };
  const spread = (g) => { const [cx, cy] = centre(g); let s = 0; for (let i = g * 20; i < g * 20 + 20; i++) s += Math.hypot(a.x[i] - cx, a.y[i] - cy); return s / 20; };
  const [ax, ay] = centre(0), [bx, by] = centre(1);
  assert.ok(Math.hypot(ax - bx, ay - by) > Math.max(spread(0), spread(1)), "the two groups are laid out apart");
  // the worker gets the function as source text: it must not depend on anything outside its body
  const standalone = new Function("return " + C.runLayout.toString())();
  assert.deepEqual(Array.from(standalone(input()).y), Array.from(a.y));
});

test("fallback crop: tall images from the top, others from the upper third", () => {
  // 1:2, as in full-body photos: the upper third would start at h/6 and cut off the head
  assert.equal(C.isTall(500, 1000), true);
  assert.equal(C.isTall(500, 750), false); // exactly 1.5 is not tall
  assert.deepEqual(C.fallbackSquare(500, 1000, "auto"), { x: 0, y: 20, side: 500 });
  assert.deepEqual(C.fallbackSquare(500, 1000, "upperThird"), { x: 0, y: 1000 / 3 - 250, side: 500 });
  assert.deepEqual(C.fallbackSquare(500, 1000, "center"), { x: 0, y: 250, side: 500 });
  assert.deepEqual(C.fallbackSquare(400, 1000, "top"), { x: 0, y: 20, side: 400 }); // 1:2.5
  // 3:4 portrait: auto stays the upper third
  assert.deepEqual(C.fallbackSquare(600, 800, "auto"), C.fallbackSquare(600, 800, "upperThird"));
  assert.deepEqual(C.fallbackSquare(600, 800, "upperThird"), { x: 0, y: 0, side: 600 }); // clamped at the top
  // wide image: full height, centred horizontally, whatever the mode
  for (const m of ["auto", "top", "upperThird", "center"]) assert.deepEqual(C.fallbackSquare(1000, 500, m), { x: 250, y: 0, side: 500 });
  // unknown mode = auto
  assert.deepEqual(C.fallbackSquare(500, 1000, "nonsense"), C.fallbackSquare(500, 1000, "auto"));
});

test("settings: fallbackCrop", () => {
  assert.equal(C.readSettings(null).fallbackCrop, "auto");
  assert.equal(C.readSettings({ fallbackCrop: "top" }).fallbackCrop, "top");
  assert.equal(C.readSettings({ fallbackCrop: "bottom" }).fallbackCrop, "auto");
  assert.deepEqual(C.settingsInput(C.readSettings({ fallbackCrop: "auto" })).fallbackCrop, undefined); // default is left out
  assert.equal(C.settingsInput(C.readSettings({ fallbackCrop: "center" })).fallbackCrop, "center");
});

test("second detection on tall images: top square, box back in image pixels", () => {
  assert.equal(C.tallRegion(600, 800), null);
  assert.deepEqual(C.tallRegion(500, 1000), { x: 0, y: 0, side: 500 }); // 1:2: the upper half
  assert.deepEqual(C.tallRegion(400, 1000), { x: 0, y: 0, side: 400 }); // 1:2.5: the top 40 %
  // a box found at 128 px on the top square of a 500 x 1000 image
  const r = C.tallRegion(500, 1000);
  assert.deepEqual(C.regionBoxToImage({ originX: 32, originY: 16, width: 32, height: 40 }, r, 128), { originX: 125, originY: 62.5, width: 125, height: 156.25 });
  // with an offset region the offset is added
  assert.deepEqual(C.regionBoxToImage({ originX: 0, originY: 0, width: 64, height: 64 }, { x: 10, y: 20, side: 256 }, 128), { originX: 10, originY: 20, width: 128, height: 128 });
  // normalised as stored in spn_face
  const img = { width: 500, height: 1000 };
  assert.deepEqual(C.boxToNormal(img, C.regionBoxToImage({ originX: 32, originY: 16, width: 32, height: 40 }, r, 128)), [0.25, 0.0625, 0.25, 0.1563]);
});

test("face data of the earlier detector version: faces stand, no face is checked again on tall images", () => {
  const field = (v, b) => ({ custom_fields: { spn_face: JSON.stringify({ v, h: "1a2b3c4d:2048", b }) } });
  const old = "mp-tv1.0.1-bfsr1";
  assert.notEqual(C.FACE_VERSION, old);
  assert.equal(C.readFaceField(field("mp-tv0-unknown", null)), null);
  const none = C.readFaceField(field(old, null)), face = C.readFaceField(field(old, [0.3, 0.05, 0.2, 0.1]));
  assert.equal(none.v, old); // still read
  assert.equal(C.faceStillValid(face, 500, 1000), true);
  assert.equal(C.faceStillValid(none, 600, 800), true); // not tall: the first attempt is all there is
  assert.equal(C.faceStillValid(none, 500, 1000), false); // tall: detect again
  assert.equal(C.faceStillValid(C.readFaceField(field(C.FACE_VERSION, null)), 500, 1000), true);
  assert.equal(C.faceStillValid({ b: null }, 500, 1000), false); // local cache entry of 0.1.0 (no version)
  assert.equal(C.faceStillValid(null, 600, 800), false);
});

test("withChild appends the child and keeps all other arguments", () => {
  const toArray = (c) => (c == null ? [] : [].concat(c));
  const props = { children: ["a", "b"], other: 1 };
  const ctx = {};
  const [p, second] = C.withChild([props, ctx], "item", toArray);
  assert.deepEqual(p, { children: ["a", "b", "item"], other: 1 });
  assert.equal(second, ctx);
  assert.deepEqual(props.children, ["a", "b"]); // the original props are not changed
  assert.deepEqual(C.withChild([{}], "item", toArray)[0].children, ["item"]);
});

test("withChild returns the original arguments when something is off", () => {
  const boom = () => {
    throw new Error("boom");
  };
  const props = { children: ["a"] };
  assert.deepEqual(C.withChild([props], "item", boom), [props]);
  assert.deepEqual(C.withChild([null], "item", (c) => c), [null]);
  assert.deepEqual(C.withChild([], "item", (c) => c), []);
  assert.deepEqual(C.withChild(undefined, "item", (c) => c), []);
});

test("readView and writeView: the copied link opens the same view", () => {
  const b = base();
  const st = C.readSettings({}, {});
  const q = (s) => new URLSearchParams(s);
  const studio = Object.keys(b.studios)[0], tag = Object.keys(b.tags)[0];
  const [a, z] = Object.keys(b.performers);
  const v = C.readView(q(""), st, b);
  Object.assign(v, { countBy: "productions", maxCast: 5, favOn: true, favMode: "only", minStrength: 3, studio, tags: [tag], tagMode: "all", sceneStars: 2, watchedOnly: true, yearFrom: 2020, yearTo: 2024 });
  v.genders[b.genders[0]] = false;
  const link = C.writeView(v, st, b, { focus: a });
  const back = C.readView(q(link), st, b);
  for (const k of ["countBy", "maxCast", "favOn", "favMode", "minStrength", "studio", "tags", "tagMode", "sceneStars", "watchedOnly", "genders", "yearFrom", "yearTo"]) assert.deepEqual(back[k], v[k], k);
  assert.equal(back.focus, a);
  assert.deepEqual(C.readView(q(C.writeView(v, st, b, { path: [a, z], focus: a })), st, b).path, [a, z]);
  const e = C.readView(q(C.writeView(v, st, b, { edge: [a, z], focus: a })), st, b);
  assert.deepEqual([e.edge, e.focus], [[a, z], null]);
});

test("writeView leaves out what the page opens with anyway; readView ignores unknown ids", () => {
  const b = base();
  const st = C.readSettings({}, {});
  const v = C.readView(new URLSearchParams(""), st, b);
  v.countBy = "scenes";
  assert.equal(C.writeView(v, st, b), "count=scenes");
  const bad = C.readView(new URLSearchParams("focus=999999&path=1,1&studio=999999&genders=NOPE"), st, b);
  assert.equal(bad.focus, null);
  assert.equal(bad.path, null);
  assert.equal(bad.studio, "");
  assert.ok(Object.values(bad.genders).every((on) => !on));
});

test("rankings: strongest pairs and most partners, ties by name", () => {
  const performers = { 1: { name: "Cleo" }, 2: { name: "Abe" }, 3: { name: "Bo" }, 4: { name: "Dee" } };
  const graph = {
    nodes: ["1", "2", "3", "4"],
    edges: [
      { from: "1", to: "2", weight: 2 },
      { from: "2", to: "3", weight: 5 },
      { from: "1", to: "3", weight: 2 },
    ],
    neighbours: { 1: { 2: 2, 3: 2 }, 2: { 1: 2, 3: 5 }, 3: { 2: 5, 1: 2 }, 4: {} },
  };
  const r = C.rankings(graph, performers, 2, (a, b) => a.localeCompare(b));
  assert.deepEqual(r.pairs.map((p) => p.id), ["2-3", "1-2"]); // 1-2 and 1-3 tie: Cleo & Abe before Cleo & Bo
  assert.deepEqual(r.partners.map((p) => p.id), ["2", "3"]); // all have 2 partners: Abe, Bo, Cleo; Dee (0) is left out
  assert.equal(C.rankings(graph, performers, 10, (a, b) => a.localeCompare(b)).partners.length, 3);
});

test("scenesUrl: Stash's criterion format, braces only outside strings", () => {
  const url = C.scenesUrl([{ id: 1, name: "Ann {the} \"Best\"" }, { id: "2", name: "Bo" }]);
  assert.ok(url.startsWith("/scenes?c="));
  const c = decodeURIComponent(url.slice("/scenes?c=".length));
  assert.equal(c, '("type":"performers","modifier":"INCLUDES_ALL","value":("items":[("id":"1","label":"Ann {the} \\"Best\\""),("id":"2","label":"Bo")],"excluded":[]))');
  assert.match(decodeURIComponent(C.scenesUrl([{ id: 3, name: "Cy" }])), /"modifier":"INCLUDES"/);
});

test("years: scene dates, the year range filter and the first and last date of a pair", () => {
  const data = fx.data();
  data.findScenes.scenes[0].date = "2019-05-01";
  data.findScenes.scenes[1].date = null;
  const b = C.prepareData(data);
  assert.equal(b.scenes[0].year, 2019);
  assert.equal(b.years.undated, 1);
  assert.equal(b.years.min, 2019);
  const all = C.selectScenes(b, fx.filters({})).length;
  const from2020 = C.selectScenes(b, fx.filters({ yearFrom: 2020 }));
  assert.equal(from2020.length, all - 2); // the 2019 scene and the undated one are left out
  assert.ok(from2020.every((sc) => sc.year >= 2020));
  assert.equal(C.selectScenes(b, fx.filters({ yearTo: 2019 })).length, 1);
  assert.deepEqual(C.dateSpan([{ date: "2021-03-02" }, { date: null }, { date: "2019-01-01" }, { date: "2024-12-31" }]), { first: "2019-01-01", last: "2024-12-31" });
  assert.equal(C.dateSpan([{ date: null }]), null);
});

test("scene_count from the scenes when Stash does not send it; orgasm counts attached later", () => {
  const data = fx.data();
  const seen = new Map();
  for (const sc of data.findScenes.scenes)
    for (const p of sc.performers) {
      const copy = { ...p };
      delete copy.scene_count;
      delete copy.o_counter;
      seen.set(p.id, copy);
    }
  data.findPerformers = { performers: [...seen.values()] };
  data.findScenes.scenes = data.findScenes.scenes.map((sc) => ({ ...sc, performers: sc.performers.map((p) => ({ id: p.id })) }));
  const b = C.prepareData(data);
  const id = b.scenes[0].performers[0];
  assert.equal(b.performers[id].scene_count, b.scenes.filter((sc) => sc.performers.includes(id)).length);
  assert.equal(b.orgasmsLoaded, false);
  C.attachOrgasms(b, [{ id, o_counter: 4 }]);
  assert.equal(b.orgasmsLoaded, true);
  assert.equal(b.performers[id].o_counter, 4);
  assert.equal(C.prepareData(fx.data()).orgasmsLoaded, true); // data that already has them
});
