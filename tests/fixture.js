// Small hand-made library for exact expectations (see core.test.js). All names are invented.
"use strict";
function p(id, extra) {
  return Object.assign({ id: String(id), name: "Person " + id, gender: "FEMALE", favorite: false, rating100: null, o_counter: 0, image_path: "", scene_count: 0, custom_fields: {} }, extra || {});
}
var P = { 1: p(1), 2: p(2, { gender: "MALE" }), 3: p(3, { favorite: true, rating100: 80, o_counter: 1 }), 4: p(4, { gender: null }), 5: p(5), 6: p(6, { gender: "NON_BINARY" }) };
var A = { id: "10", name: "Studio A", parent_studio: null };
var B = { id: "11", name: "Studio B", parent_studio: { id: "10", name: "Studio A" } };
var G1 = { id: "1", name: "Group One", front_image_path: "http://h/group/1/frontimage" };
function scene(id, cast, opts) {
  opts = opts || {};
  return {
    id: String(id), title: "Scene " + id, date: opts.date || "2024-01-0" + id, files: [],
    rating100: opts.rating == null ? null : opts.rating, play_count: opts.plays || 0, o_counter: opts.o || 0,
    performers: cast.map(function (i) { return P[i]; }),
    groups: opts.group ? [{ group: opts.group }] : [],
    paths: { screenshot: "http://h/scene/" + id + "/screenshot" }, galleries: [],
    tags: (opts.tags || []).map(function (t) { return { id: t, name: "Tag " + t }; }),
    studio: opts.studio || null,
  };
}
function data() {
  return {
    findScenes: { scenes: [
      scene(1, [1, 2], { group: G1, studio: A, tags: ["t1"] }),
      scene(2, [1, 2, 3], { group: G1, studio: A, plays: 2 }),
      scene(3, [1, 2], { studio: A, tags: ["t1", "t2"], rating: 80, o: 1 }),
      scene(4, [3, 4], { studio: B, tags: ["t2"] }),
      scene(5, [1, 2, 5, 6], {}),
    ] },
    findStudios: { studios: [{ id: "10", name: "Studio A", parent_studio: null }, { id: "11", name: "Studio B", parent_studio: { id: "10" } }] },
    findTags: { tags: [{ id: "t1", name: "Tag t1", aliases: [] }, { id: "t2", name: "Tag t2", aliases: ["second"] }] },
    genders: { enumValues: ["MALE", "FEMALE", "NON_BINARY"].map(function (n) { return { name: n }; }) },
    configuration: { plugins: { "stash-performer-network": { labelZoom: 5 } } },
  };
}
function filters(over) {
  return Object.assign({ studio: "", tags: [], tagMode: "any", minStrength: 1, maxCast: 12, countBy: "scenes", favOn: false, favMode: "partners",
    showIsolated: false, genders: { MALE: true, FEMALE: true, NON_BINARY: true, UNKNOWN: true }, sceneStars: 0, watchedOnly: false, orgasmOnly: false,
    perfStars: 0, perfStarsPartners: true, perfOrgasm: false, perfOrgasmPartners: true }, over || {});
}
module.exports = { data: data, filters: filters };
