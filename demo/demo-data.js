/*
 * Invented demo library for tests, the mock server and README screenshots.
 *
 * Everything here is fictional and generated deterministically: performer names are a first name plus a
 * made-up surname, studios, groups, galleries and tags are invented, and all images are generated
 * placeholders (see png.js). No data comes from a real Stash library.
 *
 * demoLibrary() returns the "data" part of the plugin's main GraphQL query (query PerformerNetwork).
 */
"use strict";

function rng(seed) {
  var s = seed >>> 0;
  return function () {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

var FIRST = ["Ada", "Bea", "Cleo", "Dana", "Elin", "Fay", "Gia", "Hana", "Iris", "Juno", "Kira", "Lena", "Mila", "Nora",
  "Opal", "Pia", "Rhea", "Sia", "Tess", "Uma", "Vera", "Wren", "Yara", "Zoe", "Ines", "Lux", "Maren", "Noa",
  "Arlo", "Bram", "Cyrus", "Dario", "Emil", "Finn", "Hugo", "Ivo", "Jonas", "Kai"];
var SUR_A = ["Quill", "Marrow", "Thistle", "Vane", "Brook", "Fen", "Ash", "Lark", "Moss", "Rowan", "Wilder", "Sorrel"];
var SUR_B = ["mere", "wick", "holt", "dale", "ford", "combe", "ley", "stow"];

var STUDIOS = [
  { id: "1", name: "Northwind Pictures", parent: null },
  { id: "2", name: "Northwind Blue", parent: "1" },
  { id: "3", name: "Northwind Red", parent: "1" },
  { id: "4", name: "Lantern Films", parent: null },
  { id: "5", name: "Harbor Home Video", parent: null },
  { id: "6", name: "Solo Studio", parent: null },
];
var TAGS = ["Outdoor", "Interview", "Behind the scenes", "Duo", "Trio", "Studio set", "Beach", "Night", "Vintage",
  "Dance", "Kitchen", "Rooftop"].map(function (name, i) {
  return { id: String(i + 1), name: name, aliases: i === 1 ? ["Q&A"] : i === 2 ? ["BTS", "Making of"] : [] };
});
var GENDERS = ["MALE", "FEMALE", "TRANSGENDER_MALE", "TRANSGENDER_FEMALE", "INTERSEX", "NON_BINARY"];

function demoLibrary() {
  var r = rng(20261001);
  function pick(a) {
    return a[Math.floor(r() * a.length)];
  }
  function sample(a, n) {
    var c = a.slice(), out = [];
    while (out.length < n && c.length) out.push(c.splice(Math.floor(r() * c.length), 1)[0]);
    return out;
  }

  // performers
  var performers = [];
  var used = {};
  FIRST.forEach(function (first, i) {
    var sur;
    do sur = pick(SUR_A) + pick(SUR_B);
    while (used[first + sur]);
    used[first + sur] = true;
    var gender = i >= 28 ? "MALE" : "FEMALE";
    if (i === 24 || i === 27) gender = "NON_BINARY";
    if (i === 25) gender = "TRANSGENDER_FEMALE";
    if (i === 26) gender = null;
    performers.push({
      id: String(i + 1),
      name: first + " " + sur,
      gender: gender,
      favorite: [2, 7, 13, 30].indexOf(i) >= 0,
      rating100: [1, 2, 7, 13, 21, 30].indexOf(i) >= 0 ? [60, 80, 100, 40, 80, 60][[1, 2, 7, 13, 21, 30].indexOf(i)] : null,
      o_counter: 0,
      image_path: "http://localhost/performer/" + (i + 1) + "/image?t=1790000000" + (i === 26 ? "&default=true" : ""),
      scene_count: 0,
      custom_fields: {},
    });
  });
  var byId = {};
  performers.forEach(function (p) {
    byId[p.id] = p;
  });

  // scenes: groups (multi-part productions), single scenes, one large compilation
  var scenes = [], groups = [], galleries = [], sceneId = 100, galleryId = 1;
  function addScene(title, cast, studio, date, group) {
    var id = String(++sceneId);
    var sc = {
      id: id,
      title: title,
      date: date,
      files: [{ basename: title.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".mp4" }],
      rating100: r() < 0.12 ? pick([40, 60, 80, 100]) : null,
      play_count: r() < 0.3 ? 1 + Math.floor(r() * 4) : 0,
      o_counter: r() < 0.08 ? 1 + Math.floor(r() * 2) : 0,
      performers: cast.map(function (pid) {
        return byId[pid];
      }),
      groups: group ? [{ group: group }] : [],
      paths: { screenshot: "http://localhost/scene/" + id + "/screenshot?t=1790000000" },
      galleries: [],
      tags: sample(TAGS, 1 + Math.floor(r() * 3)).map(function (t) {
        return { id: t.id, name: t.name };
      }),
      studio: studio ? { id: studio.id, name: studio.name, parent_studio: studio.parent ? { id: studio.parent, name: STUDIOS[Number(studio.parent) - 1].name } : null } : null,
    };
    scenes.push(sc);
    return sc;
  }
  function date(y, m, d) {
    return y + "-" + ("0" + m).slice(-2) + "-" + ("0" + d).slice(-2);
  }
  var ids = performers.map(function (p) {
    return p.id;
  });
  var women = ids.slice(0, 28), men = ids.slice(28);
  var core = ["3", "8", "14", "2", "5", "11"]; // a busy core so the network has clusters and strong edges

  // 12 multi-part productions (groups)
  var titles = ["Summer House", "City Lights", "Paper Moon", "Second Act", "Blue Hour", "Open Studio", "Weekend Away",
    "Late Rehearsal", "Coastline", "Glasshouse", "Old Town", "Night Shift"];
  titles.forEach(function (t, gi) {
    var studio = STUDIOS[[1, 2, 3, 4, 1, 2, 3, 4, 5, 1, 2, 3][gi]];
    var group = { id: String(gi + 1), name: t, front_image_path: "http://localhost/group/" + (gi + 1) + "/frontimage?t=1790000000" };
    groups.push(group);
    var cast = sample(gi < 6 ? core.concat(women.slice(6, 14)) : women.slice(10).concat(men), 2 + Math.floor(r() * 3));
    if (gi % 3 === 0) cast.push(pick(men));
    var parts = 2 + Math.floor(r() * 3), y = 2021 + (gi % 5), m = 1 + gi;
    var gal = { id: String(galleryId++), title: t + " (stills)", image_count: 20 + Math.floor(r() * 60), paths: { cover: "http://localhost/gallery/" + (galleryId - 1) + "/cover?t=1790000000" }, folder: null, files: [] };
    galleries.push(gal);
    for (var k = 0; k < parts; k++) {
      var partCast = k === 0 ? cast : sample(cast, Math.max(2, cast.length - (k % 2)));
      var sc = addScene(t + ": Part " + (k + 1), partCast, studio, date(y, m, 3 + k * 2), group);
      if (k === 0 || r() < 0.4) sc.galleries.push(gal);
    }
  });

  // 45 single scenes
  for (var i = 0; i < 45; i++) {
    var pool = i < 20 ? core.concat(women.slice(14, 22)) : women.concat(men);
    var cast = sample(pool, r() < 0.7 ? 2 : 3);
    var studio = r() < 0.15 ? null : STUDIOS[Math.floor(r() * STUDIOS.length)];
    addScene(pick(["Morning", "Evening", "Studio", "Garden", "Loft", "Balcony", "Harbor"]) + " Session " + (i + 1), cast, studio, date(2020 + (i % 6), 1 + (i % 12), 1 + (i % 27)));
  }
  // solo scenes
  for (var j = 0; j < 8; j++) addScene("Solo " + (j + 1), [women[20 + (j % 8)]], STUDIOS[5], date(2024, 1 + j, 10));
  // one compilation with 14 performers (above the default limit of 12)
  addScene("Anniversary Compilation", sample(ids.filter(function (id) { return id !== "27"; }), 14), STUDIOS[0], date(2025, 12, 20));

  scenes.forEach(function (sc) {
    sc.performers.forEach(function (p) {
      p.scene_count++;
      p.o_counter += sc.o_counter;
    });
  });

  return {
    findScenes: { count: scenes.length, scenes: scenes },
    findStudios: {
      studios: STUDIOS.map(function (s) {
        return { id: s.id, name: s.name, parent_studio: s.parent ? { id: s.parent } : null };
      }),
    },
    findTags: { tags: TAGS },
    genders: { enumValues: GENDERS.map(function (g) { return { name: g }; }) },
    configuration: { plugins: {} },
    // not part of the GraphQL answer; used by the mock server for image placeholders
    _performers: performers,
    _groups: groups,
    _galleries: galleries,
  };
}

module.exports = { demoLibrary: demoLibrary, FIRST: FIRST, SUR_A: SUR_A, SUR_B: SUR_B };
