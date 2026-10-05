#!/usr/bin/env node
/*
 * Mock Stash for the demo and the README screenshots: serves a small host page (index.html, harness.js)
 * that stands in for Stash's UI, the plugin files, generated placeholder images, and a /graphql endpoint
 * that answers exactly the plugin's own requests (main query, scene tags, scene details, settings read/write,
 * face-data writes).
 * No dependencies. Usage: node demo/server.js [port]   (default 8790)
 */
"use strict";
var http = require("http");
var fs = require("fs");
var path = require("path");
var demo = require("./demo-data.js");
var png = require("./png.js");

var ROOT = path.resolve(__dirname, "..");
var PLUGIN = path.join(ROOT, "plugin");
var PORT = Number(process.argv[2] || process.env.PORT || 8790);
var DATA = demo.demoLibrary();
var settings = {};
var faces = {};
var imageCache = {};

var TYPES = { ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".html": "text/html; charset=utf-8",
  ".wasm": "application/wasm", ".tflite": "application/octet-stream", ".png": "image/png" };

function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-cache" });
  res.end(body);
}
function file(res, p) {
  fs.readFile(p, function (err, buf) {
    if (err) return send(res, 404, "text/plain", "not found");
    send(res, 200, TYPES[path.extname(p)] || "application/octet-stream", buf);
  });
}
function image(res, key, make) {
  if (!imageCache[key]) imageCache[key] = make();
  send(res, 200, "image/png", imageCache[key]);
}

function performersWithFaces() {
  return DATA._performers.map(function (p) {
    return Object.assign({}, p, { custom_fields: faces[p.id] ? { spn_face: faces[p.id] } : {} });
  });
}

function networkScene(sc) {
  return { id: sc.id, date: sc.date, rating100: sc.rating100, play_count: sc.play_count, o_counter: sc.o_counter,
    performers: sc.performers.map(function (p) { return { id: p.id }; }),
    groups: sc.groups.map(function (g) { return { group: { id: g.group.id } }; }),
    studio: sc.studio ? { id: sc.studio.id } : null };
}

function answer(body) {
  var q = body.query || "";
  var scenes = DATA.findScenes.scenes;
  if (q.indexOf("query PerformerNetworkTags") >= 0) {
    var v = body.variables || {}, per = v.per || scenes.length, from = ((v.page || 1) - 1) * per;
    return { data: { findScenes: { scenes: scenes.slice(from, from + per).map(function (sc) {
      return { id: sc.id, tags: sc.tags.map(function (t) { return { id: t.id }; }) };
    }) } } };
  }
  if (q.indexOf("query PerformerNetworkScenePage") >= 0) {
    var pv = body.variables || {}, pper = pv.per || scenes.length, pfrom = ((pv.page || 1) - 1) * pper;
    return { data: { findScenes: { count: scenes.length, scenes: scenes.slice(pfrom, pfrom + pper).map(networkScene) } } };
  }
  if (q.indexOf("query PerformerNetworkOrgasms") >= 0)
    return { data: { findPerformers: { performers: DATA._performers.map(function (p) { return { id: p.id, o_counter: p.o_counter }; }) } } };
  if (q.indexOf("query PerformerNetworkScenes") >= 0) {
    var ids = (body.variables && body.variables.ids) || [];
    return { data: { findScenes: { scenes: scenes.filter(function (sc) { return ids.indexOf(sc.id) >= 0; }).map(function (sc) {
      return { id: sc.id, title: sc.title, date: sc.date, files: sc.files, paths: sc.paths, galleries: sc.galleries };
    }) } } };
  }
  if (q.indexOf("query PerformerNetwork") >= 0)
    return { data: {
      findPerformers: { performers: performersWithFaces().map(function (p) {
        var out = Object.assign({}, p); // scene_count and o_counter come from the scenes and QUERY_ORGASMS, as in Stash
        delete out.scene_count;
        delete out.o_counter;
        return out;
      }) },
      findGroups: { groups: DATA._groups.map(function (g) { return { id: g.id, name: g.name }; }) },
      findStudios: DATA.findStudios,
      findTags: DATA.findTags,
      genders: DATA.genders,
      configuration: { plugins: { "stash-performer-network": settings } },
    } };
  if (q.indexOf("configurePlugin") >= 0) {
    settings = (body.variables && body.variables.i) || {};
    return { data: { configurePlugin: settings } };
  }
  if (q.indexOf("configuration") >= 0 && q.indexOf("plugins") >= 0) return { data: { configuration: { plugins: { "stash-performer-network": settings } } } };
  if (q.indexOf("performerUpdate") >= 0) {
    var out = {};
    Object.keys(body.variables || {}).forEach(function (k, i) {
      var v = body.variables[k];
      faces[v.id] = v.custom_fields.partial.spn_face;
      out["u" + i] = { id: v.id };
    });
    return { data: out };
  }
  return { errors: [{ message: "mock server: unsupported query" }] };
}

var server = http.createServer(function (req, res) {
  var u = new URL(req.url, "http://localhost");
  var p = u.pathname, m;
  if (req.method === "POST" && p === "/graphql") {
    var chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () {
      var body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { /* empty */ }
      send(res, 200, "application/json", JSON.stringify(answer(body)));
    });
    return;
  }
  if (p === "/" || p === "/performer-network") return file(res, path.join(__dirname, "index.html"));
  if (p === "/harness.js" || p === "/harness.css") return file(res, path.join(__dirname, p.slice(1)));
  if ((m = p.match(/^\/plugin-files\/([\w.-]+\.(js|css))$/))) return file(res, path.join(PLUGIN, m[1]));
  if ((m = p.match(/^\/plugin\/stash-performer-network\/assets\/(vendor|locales)\/([\w./-]+)$/)) && m[2].indexOf("..") < 0) return file(res, path.join(PLUGIN, m[1], m[2]));
  if ((m = p.match(/^\/performer\/(\d+)\/image$/))) return image(res, "p" + m[1], function () { return png.avatar(Number(m[1])); });
  if ((m = p.match(/^\/scene\/(\d+)\/screenshot$/))) return image(res, "s" + m[1], function () { return png.cover(Number(m[1]), 320, 180); });
  if ((m = p.match(/^\/group\/(\d+)\/frontimage$/))) return image(res, "g" + m[1], function () { return png.cover(Number(m[1]) * 7, 200, 300); });
  if ((m = p.match(/^\/gallery\/(\d+)\/cover$/))) return image(res, "c" + m[1], function () { return png.cover(Number(m[1]) * 13, 300, 225); });
  send(res, 404, "text/plain", "not found");
});

server.listen(PORT, "127.0.0.1", function () {
  console.log("demo: http://127.0.0.1:" + PORT + "/  (mock Stash with invented data)");
});
