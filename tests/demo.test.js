"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../plugin/stash-performer-network-core.js");
const demo = require("../demo/demo-data.js");
const fx = require("./fixture.js");

test("demo library is deterministic and builds a network", () => {
  const a = demo.demoLibrary(), b = demo.demoLibrary();
  assert.deepEqual(JSON.stringify(a), JSON.stringify(b));
  const g = C.computeGraph(C.prepareData(a), fx.filters({ genders: { MALE: true, FEMALE: true, NON_BINARY: true, TRANSGENDER_FEMALE: true, TRANSGENDER_MALE: true, INTERSEX: true, UNKNOWN: true } }));
  assert.ok(g.nodes.length > 20 && g.edges.length > 50);
  assert.equal(g.tooBig, 1); // the 14-performer compilation
});

test("demo performers are fictional: first name + generated surname", () => {
  const sur = new Set();
  demo.SUR_A.forEach((a) => demo.SUR_B.forEach((b) => sur.add(a + b)));
  for (const p of demo.demoLibrary()._performers) {
    const [first, last] = p.name.split(" ");
    assert.ok(demo.FIRST.includes(first) && sur.has(last), p.name);
  }
});
