"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..", "plugin", "locales");
const index = JSON.parse(fs.readFileSync(path.join(DIR, "index.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(DIR, "en.json"), "utf8"));
const base = (k) => k.replace(/_(zero|one|two|few|many|other)$/, "");

test("index.json lists exactly the locale files", () => {
  const files = fs.readdirSync(DIR).filter((f) => f !== "index.json" && f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(index.slice().sort(), files);
  assert.ok(index.includes("en"));
});

// Plural keys ("<key>_one", "_other", ...) must have exactly the categories Intl.PluralRules knows for
// the language (fr/es/it also "many", e.g. for 1,000,000); all other keys are the same as in en.json.
const PLURAL = /_(zero|one|two|few|many|other)$/;
const pluralBases = new Set(Object.keys(en).filter((k) => PLURAL.test(k)).map(base));
function expectedKeys(code) {
  const cats = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
  const keys = Object.keys(en).filter((k) => !PLURAL.test(k));
  for (const b of pluralBases) for (const c of cats) keys.push(b + "_" + c);
  return keys.sort();
}

test("every translation has the keys of en.json, the plural forms of its language and the same placeholders", () => {
  const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort();
  for (const code of index) {
    const m = JSON.parse(fs.readFileSync(path.join(DIR, code + ".json"), "utf8"));
    assert.deepEqual(Object.keys(m).sort(), expectedKeys(code), code);
    for (const k of Object.keys(m)) {
      const ref = Object.prototype.hasOwnProperty.call(en, k) ? en[k] : en[base(k) + "_other"];
      assert.deepEqual(ph(m[k]), ph(ref), code + ": " + k);
      assert.ok(String(m[k]).trim(), code + ": " + k + " is empty");
    }
  }
});

test("plural forms: each language picks its own form through I18n", () => {
  const C = require("../plugin/stash-performer-network-core.js");
  const load = (code) => JSON.parse(fs.readFileSync(path.join(DIR, code + ".json"), "utf8"));
  const fr = new C.I18n("fr", load("fr"), en);
  assert.equal(fr.t("scenes", { count: 0 }), "0 scène"); // French: 0 and 1 are singular
  assert.equal(fr.t("scenes", { count: 2 }), "2 scènes");
  assert.equal(fr.t("scenes", { count: 1000000 }), "1\u202f000\u202f000 de scènes");
  const es = new C.I18n("es", load("es"), en);
  assert.equal(es.t("scenes", { count: 0 }), "0 escenas");
  const it = new C.I18n("it", load("it"), en);
  assert.equal(it.t("scenes", { count: 1 }), "1 scena");
});

test("every text key used in the plugin exists in en.json", () => {
  const js = fs.readFileSync(path.join(__dirname, "..", "plugin", "stash-performer-network.js"), "utf8");
  const core = fs.readFileSync(path.join(__dirname, "..", "plugin", "stash-performer-network-core.js"), "utf8");
  const keys = new Set(Object.keys(en).map(base));
  const used = new Set([...js.matchAll(/\bt\("([A-Za-z]\w*)"/g)].map((m) => m[1]));
  for (const m of core.matchAll(/(?:label|help): "(\w+)"/g)) used.add(m[1]);
  for (const m of core.matchAll(/: "(\w+)"[,}]/g)) if (/^(size|count|fav)[A-Z]/.test(m[1])) used.add(m[1]);
  // dynamic keys: t("gender_" + g) for every gender the plugin knows
  used.delete("gender_");
  Object.keys(require("../plugin/stash-performer-network-core.js").GENDER_COLORS).forEach((g) => used.add("gender_" + g));
  const missing = [...used].filter((k) => !keys.has(k));
  assert.deepEqual(missing, []);
});

test("no emoji in texts, plugin code or CSS (icons are inline SVG; gender signs are allowed)", () => {
  const allowed = new Set([0x2640, 0x2642, 0x26a7, 0x26a5, 0x26b2]);
  const emoji = (cp) => cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf && !allowed.has(cp));
  // besides the character itself (e.g. U+2665), escaped code points count too: "\u{1F4A6}" (JS), "\2665" (CSS)
  const decode = (s) => s.replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\([0-9a-f]{4,6})(?![0-9a-f])/gi, (m, a, b, c) => String.fromCharCode(...(() => {
    const cp = parseInt(a || b || c, 16);
    return cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
  })()));
  const PLUGIN = path.join(__dirname, "..", "plugin");
  const files = fs.readdirSync(PLUGIN).filter((f) => /\.(js|css|yml)$/.test(f)).map((f) => path.join(PLUGIN, f))
    .concat(index.map((c) => path.join(DIR, c + ".json")));
  for (const file of files) {
    const found = [...decode(fs.readFileSync(file, "utf8"))].filter((ch) => emoji(ch.codePointAt(0)));
    assert.deepEqual(found, [], path.basename(file));
  }
});

test("no dashes U+2012 to U+2015 in texts, code and docs (colon, comma, brackets or a full stop instead)", () => {
  const dash = (cp) => cp >= 0x2012 && cp <= 0x2015;
  // besides the character itself, escaped code points count too: "\u2013" (JS), "\2014" (CSS)
  const decode = (s) => s.replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\([0-9a-f]{4,6})(?![0-9a-f])/gi, (m, a, b, c) => {
    const cp = parseInt(a || b || c, 16);
    return cp > 0xffff ? m : String.fromCharCode(cp);
  });
  const ROOT = path.join(__dirname, "..");
  const walk = (dir, re) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === "vendor" ? [] : walk(p, re); // bundled third-party code stays as published
    return re.test(d.name) ? [p] : [];
  });
  const files = walk(path.join(ROOT, "plugin"), /\.(js|css|yml|json)$/)
    .concat(walk(path.join(ROOT, "docs"), /\.md$/), walk(path.join(ROOT, "demo"), /\.(js|html|css)$/))
    .concat(["README.md", "CHANGELOG.md", "CONTRIBUTING.md"].map((f) => path.join(ROOT, f)));
  // tests and scripts: only the characters themselves (escapes there are examples, as in this test)
  const literal = walk(path.join(ROOT, "tests"), /\.js$/).concat(walk(path.join(ROOT, "scripts"), /\.(m?js|sh)$/));
  for (const file of files.concat(literal)) {
    const text = fs.readFileSync(file, "utf8");
    const lines = (literal.includes(file) ? text : decode(text)).split("\n");
    const found = lines.map((l, i) => ([...l].some((ch) => dash(ch.codePointAt(0))) ? path.relative(ROOT, file) + ":" + (i + 1) : null)).filter(Boolean);
    assert.deepEqual(found, []);
  }
});
