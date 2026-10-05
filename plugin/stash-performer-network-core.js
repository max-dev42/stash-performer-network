/*
 * stash-performer-network -- core logic without DOM, network or Stash UI dependencies.
 *
 * Loaded before stash-performer-network.js (see the .yml) and exposed as window.SPNCore; the same file
 * is require()d by the tests (tests/*.test.js, run with `node --test`). Keep it free of document/window
 * access so both work without a build step.
 */
(function (root) {
  "use strict";

  var PLUGIN_ID = "stash-performer-network"; // must match the .yml file name and plugin folder

  // ------------------------------------------------------------------ genders
  // The list itself comes from GraphQL introspection (GenderEnum); colours for known values, a spare
  // palette for values a future Stash version might add.
  var GENDER_COLORS = {
    FEMALE: "#e0559a",
    MALE: "#3d8fe0",
    TRANSGENDER_FEMALE: "#a565dc",
    TRANSGENDER_MALE: "#2fb3a3",
    INTERSEX: "#e3a32b",
    NON_BINARY: "#8fa83a",
    UNKNOWN: "#8a8f98",
  };
  var SPARE_COLORS = ["#d9653b", "#5c6bc0", "#26a69a", "#c0ca33"];
  var UNKNOWN = "UNKNOWN";

  // ------------------------------------------------------------------ icons
  // Own simple SVG paths in a 16x16 box (no emoji, no third-party icon set). The UI draws them as inline
  // SVG with fill="currentColor" and on the canvas via Path2D. "gear" has a hole: fill-rule evenodd.
  var ICON_BOX = 16;
  var ICONS = {
    heart: "M8 14.5C7 13 0 8.5 0 5C0 1.5 4.5 0.5 8 4C11.5 0.5 16 1.5 16 5C16 8.5 9 13 8 14.5Z",
    star: "M8 0.9 9.82 5.99 15.23 6.15 10.95 9.46 12.47 14.65 8 11.6 3.53 14.65 5.05 9.46 0.77 6.15 6.18 5.99Z",
    gear:
      "M13.46 6.74 15.53 6.94 15.53 9.06 13.46 9.26 12.75 10.97 14.07 12.57 12.57 14.07 10.97 12.75 9.26 13.46 9.06 15.53 " +
      "6.94 15.53 6.74 13.46 5.03 12.75 3.43 14.07 1.93 12.57 3.25 10.97 2.54 9.26 0.47 9.06 0.47 6.94 2.54 6.74 3.25 5.03 " +
      "1.93 3.43 3.43 1.93 5.03 3.25 6.74 2.54 6.94 0.47 9.06 0.47 9.26 2.54 10.97 3.25 12.57 1.93 14.07 3.43 12.75 5.03Z" +
      "M10.4 8A2.4 2.4 0 1 0 5.6 8A2.4 2.4 0 1 0 10.4 8Z",
    copy: "M5 5H15V15H5Z M6.5 6.5V13.5H13.5V6.5Z M1 1H11V3.5H9.5V2.5H2.5V9.5H3.5V11H1Z",
    filter: "M1 2H15L9.5 8.5V14L6.5 12.5V8.5Z",
  };
  var ICONS_EVENODD = { gear: true, copy: true };


  function byNumber(a, b) {
    return Number(a) - Number(b);
  }

  function pairKey(a, b) {
    return Number(a) < Number(b) ? a + "-" + b : b + "-" + a;
  }

  // Stash returns absolute URLs built from the request's host; keep only path and query so that the
  // browser always asks the origin it is on (e.g. behind a reverse proxy).
  function localUrl(u) {
    if (!u) return null;
    try {
      var x = new URL(u, "http://localhost/"); // base only for parsing; absolute URLs keep their path
      return x.pathname.replace(/^\//, "") + x.search;
    } catch (e) {
      return null;
    }
  }

  // FNV-1a (32 bit) over the bytes plus the length; enough to recognise "the same image file".
  function bytesHash(buf) {
    var b = new Uint8Array(buf), h = 0x811c9dc5;
    for (var i = 0; i < b.length; i++) {
      h ^= b[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8) + ":" + b.length;
  }

  function dims(img) {
    return { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height };
  }

  function boxToPixels(img, nb) {
    var d = dims(img);
    return { originX: nb[0] * d.w, originY: nb[1] * d.h, width: nb[2] * d.w, height: nb[3] * d.h };
  }

  function boxToNormal(img, bb) {
    var d = dims(img);
    return [bb.originX / d.w, bb.originY / d.h, bb.width / d.w, bb.height / d.h].map(function (x) {
      return Math.round(x * 10000) / 10000;
    });
  }

  // Tall images (height above TALL_RATIO times the width) are usually full-body photos, often 1:2, with
  // the head near the top edge.
  var TALL_RATIO = 1.5, TOP_MARGIN = 0.02;
  function isTall(w, h) {
    return h > w * TALL_RATIO;
  }

  // Square crop used when no face is known, {x, y, side} in image pixels, full width (or full height for
  // wide images). mode (setting fallbackCrop): "top" = TOP_MARGIN of the height below the top edge,
  // "upperThird" = centred on the upper third, "center", "auto" = top for tall images, else upper third.
  function fallbackSquare(w, h, mode) {
    var side = Math.min(w, h), y;
    if (mode !== "top" && mode !== "upperThird" && mode !== "center") mode = isTall(w, h) ? "top" : "upperThird";
    if (mode === "top") y = h * TOP_MARGIN;
    else if (mode === "center") y = (h - side) / 2;
    else y = h / 3 - side / 2;
    return { x: (w - side) / 2, y: Math.max(0, Math.min(h - side, y)), side: side };
  }

  // Region of the second detection attempt on tall images, {x, y, side} in image pixels: the top square
  // (for 1:2 the upper half). null for other images.
  function tallRegion(w, h) {
    return isTall(w, h) ? { x: 0, y: 0, side: w } : null;
  }

  // A box detected on the region drawn at size x size pixels, back in image pixels.
  function regionBoxToImage(bb, region, size) {
    var f = region.side / size;
    return { originX: region.x + bb.originX * f, originY: region.y + bb.originY * f, width: bb.width * f, height: bb.height * f };
  }

  function I18n(locale, messages, fallback) {
    this.locale = locale;
    this.messages = messages || {};
    this.fallback = fallback || {};
    this.plural = new Intl.PluralRules(locale);
    this.numberFormat = new Intl.NumberFormat(locale);
    this.dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  }
  I18n.prototype.lookup = function (key) {
    if (Object.prototype.hasOwnProperty.call(this.messages, key)) return this.messages[key];
    if (Object.prototype.hasOwnProperty.call(this.fallback, key)) return this.fallback[key];
    return null;
  };
  I18n.prototype.t = function (key, params) {
    var self = this, text = null;
    if (params && typeof params.count === "number") {
      text = this.lookup(key + "_" + this.plural.select(params.count));
      if (text == null) text = this.lookup(key + "_other");
    }
    if (text == null) text = this.lookup(key);
    if (text == null) return key;
    return String(text).replace(/\{(\w+)\}/g, function (m, name) {
      if (!params || !(name in params)) return m;
      var v = params[name];
      return typeof v === "number" ? self.numberFormat.format(v) : String(v);
    });
  };
  I18n.prototype.n = function (v) {
    return this.numberFormat.format(v);
  };
  I18n.prototype.date = function (iso) {
    if (!iso) return "";
    var d = new Date(iso + "T00:00:00Z");
    return isNaN(d) ? iso : this.dateFormat.format(d);
  };

  // ------------------------------------------------------------------ data -> graph

  // Scene fields only the edge detail needs (title, date, screenshot, galleries); loaded on demand for the
  // shared scenes of one edge (attachSceneDetails), or already part of the data (demo, tests).
  function sceneDetail(sc) {
    var galleries = (sc.galleries || []).map(function (g) {
      var file = g.files && g.files[0] ? g.files[0].basename : null;
      var folder = g.folder && g.folder.path ? g.folder.path.split(/[\\/]/).pop() : null;
      return { id: g.id, title: g.title || file || folder || null, images: g.image_count || 0, cover: localUrl(g.paths && g.paths.cover) };
    });
    return {
      title: sc.title || (sc.files && sc.files[0] ? sc.files[0].basename : null), // null: the UI names it (untitledScene)
      date: sc.date || null,
      screenshot: localUrl(sc.paths && sc.paths.screenshot),
      galleries: galleries,
      detail: true,
    };
  }

  function attachSceneDetails(base, scenes) {
    (scenes || []).forEach(function (sc) {
      var s = base.sceneById[sc.id];
      if (s) Object.assign(s, sceneDetail(sc));
    });
  }

  // Tags per scene are the largest part of the scene data (5.3 of 7.6 MB in a library of 19,500 scenes),
  // so the main query leaves them out and they are attached later, page by page; base.tagsLoaded says
  // whether the tag filter can be applied yet (complete = the last page has been attached).
  // Performer orgasm counts (Stash's performer.o_counter), loaded after the network.
  function attachOrgasms(base, list) {
    (list || []).forEach(function (p) {
      if (base.performers[p.id]) base.performers[p.id].o_counter = p.o_counter || 0;
    });
    base.orgasmsLoaded = true;
  }

  function attachTags(base, scenes, complete) {
    (scenes || []).forEach(function (sc) {
      var s = base.sceneById[sc.id];
      if (!s) return;
      Object.keys(s.tagIds).forEach(function (id) {
        if (base.tags[id]) base.tags[id].scenes--; // attached before: count once
      });
      s.tagIds = {};
      (sc.tags || []).forEach(function (t) {
        if (!base.tags[t.id]) base.tags[t.id] = { id: t.id, name: t.name || t.id, aliases: [], scenes: 0 };
        base.tags[t.id].scenes++;
        s.tagIds[t.id] = true;
      });
    });
    if (complete !== false) base.tagsLoaded = true;
  }

  // data: findScenes (performers, groups, studio, tags as ids or as full objects), optionally findPerformers,
  // findGroups, findStudios, findTags, genders, configuration. Scenes without "tags" leave base.tagsLoaded
  // false (see attachTags); scenes without detail fields get them later (attachSceneDetails).
  function prepareData(data) {
    var studios = {};
    data.findStudios.studios.forEach(function (s) {
      studios[s.id] = { id: s.id, name: s.name, parent: s.parent_studio ? s.parent_studio.id : null, scenes: 0, children: [] };
    });
    Object.keys(studios).forEach(function (id) {
      var s = studios[id];
      if (s.parent && studios[s.parent]) studios[s.parent].children.push(id);
    });
    function ancestry(id) {
      var list = [], depth = 0;
      while (id && studios[id] && depth++ < 20) {
        list.push(id);
        id = studios[id].parent;
      }
      return list;
    }
    // performer details come once per performer (findPerformers) or, in the older shape, inside every scene
    var performerList = {};
    ((data.findPerformers && data.findPerformers.performers) || []).forEach(function (p) {
      performerList[p.id] = p;
    });
    var groupList = {};
    ((data.findGroups && data.findGroups.groups) || []).forEach(function (g) {
      groupList[g.id] = { id: g.id, name: g.name };
    });
    var performers = {};
    var tags = {};
    ((data.findTags && data.findTags.tags) || []).forEach(function (t) {
      tags[t.id] = { id: t.id, name: t.name, aliases: t.aliases || [], scenes: 0 };
    });
    var tagsLoaded = true;
    var scenes = data.findScenes.scenes.map(function (sc) {
      var chain = sc.studio ? ancestry(sc.studio.id) : [];
      chain.forEach(function (id) {
        studios[id].scenes++;
      });
      var ids = sc.performers.map(function (ref) {
        if (!performers[ref.id]) performers[ref.id] = performerList[ref.id] || ref;
        return ref.id;
      });
      var tagIds = {};
      if (!sc.tags) tagsLoaded = false;
      (sc.tags || []).forEach(function (t) {
        if (!tags[t.id]) tags[t.id] = { id: t.id, name: t.name || t.id, aliases: [], scenes: 0 };
        tags[t.id].scenes++;
        tagIds[t.id] = true;
      });
      var groups = (sc.groups || []).map(function (g) {
        return groupList[g.group.id] || { id: g.group.id, name: g.group.name };
      });
      groups.sort(function (a, b) {
        return byNumber(a.id, b.id);
      });
      var out = {
        id: sc.id,
        studioChain: chain,
        rating: sc.rating100 == null ? null : sc.rating100,
        plays: sc.play_count || 0,
        orgasmCount: sc.o_counter || 0, // Stash's GraphQL field is o_counter
        tagIds: tagIds,
        group: groups[0] || null, // a scene in several groups counts for the lowest group id only
        performers: ids,
        date: sc.date || null, // YYYY-MM-DD (Stash may also return YYYY or YYYY-MM)
        year: yearOf(sc.date),
        detail: false,
      };
      return "title" in sc || "paths" in sc ? Object.assign(out, sceneDetail(sc)) : out;
    });
    var sceneById = {};
    scenes.forEach(function (sc) {
      sceneById[sc.id] = sc;
    });
    // scene_count comes from the scenes when the query leaves it out (it costs Stash a count per performer)
    var sceneCount = {};
    scenes.forEach(function (sc) {
      sc.performers.forEach(function (id) {
        sceneCount[id] = (sceneCount[id] || 0) + 1;
      });
    });
    Object.keys(performers).forEach(function (id) {
      if (performers[id].scene_count == null) performers[id].scene_count = sceneCount[id] || 0;
    });
    // the performers' orgasm counts may follow later (attachOrgasms)
    var orgasmsLoaded = Object.keys(performers).some(function (id) {
      return "o_counter" in performers[id];
    });

    var genders = ((data.genders && data.genders.enumValues) || []).map(function (v) {
      return v.name;
    });
    if (!genders.length) genders = Object.keys(GENDER_COLORS).filter(function (g) { return g !== UNKNOWN; });
    genders.push(UNKNOWN);
    var colors = {}, spare = 0;
    genders.forEach(function (g) {
      colors[g] = GENDER_COLORS[g] || SPARE_COLORS[spare++ % SPARE_COLORS.length];
    });

    var years = { min: null, max: null, undated: 0 };
    scenes.forEach(function (sc) {
      if (sc.year == null) return years.undated++;
      if (years.min == null || sc.year < years.min) years.min = sc.year;
      if (years.max == null || sc.year > years.max) years.max = sc.year;
    });

    var plugins = data.configuration && data.configuration.plugins;
    var settings = (plugins && plugins[PLUGIN_ID]) || {};
    return {
      studios: studios, performers: performers, scenes: scenes, sceneById: sceneById, tags: tags, tagsLoaded: tagsLoaded,
      genders: genders, genderColors: colors, settings: settings, years: years, orgasmsLoaded: orgasmsLoaded || !scenes.length,
    };
  }

  function yearOf(date) {
    var m = /^(\d{4})/.exec(date || "");
    return m ? Number(m[1]) : null;
  }

  // First and last date among scenes (for "together from ... to ..."); null if none has a date.
  function dateSpan(scenes) {
    var first = null, last = null;
    scenes.forEach(function (sc) {
      if (!sc.date) return;
      if (first == null || sc.date < first) first = sc.date;
      if (last == null || sc.date > last) last = sc.date;
    });
    return first == null ? null : { first: first, last: last };
  }

  function genderOf(base, p) {
    return p.gender && base.genderColors[p.gender] ? p.gender : UNKNOWN;
  }

  // Scenes of the current selection (studio and tag filter). withTags=false ignores the tag filter.
  function selectScenes(base, f, withTags) {
    var tagIds = withTags === false ? [] : f.tags;
    return base.scenes.filter(function (sc) {
      if (f.studio && sc.studioChain.indexOf(f.studio) < 0) return false;
      if (f.sceneStars && (sc.rating == null || sc.rating < f.sceneStars * 20)) return false;
      if (f.watchedOnly && !sc.plays) return false;
      if (f.orgasmOnly && !sc.orgasmCount) return false;
      // a year range leaves out scenes without a date
      if ((f.yearFrom || f.yearTo) && (sc.year == null || (f.yearFrom && sc.year < f.yearFrom) || (f.yearTo && sc.year > f.yearTo))) return false;
      if (tagIds.length) {
        var hit = f.tagMode === "all"
          ? tagIds.every(function (t) { return sc.tagIds[t]; })
          : tagIds.some(function (t) { return sc.tagIds[t]; });
        if (!hit) return false;
      }
      return true;
    });
  }

  // Units: one group = one collaboration, a scene without a group = one collaboration.
  function computeGraph(base, f) {
    var scenes = selectScenes(base, f);
    var units = {};
    var scenesPerPerformer = {};
    scenes.forEach(function (sc) {
      var key = sc.group ? "g" + sc.group.id : "s" + sc.id;
      var u = units[key];
      if (!u) {
        u = units[key] = sc.group
          ? { kind: "group", id: sc.group.id, name: sc.group.name, scenes: [], performers: {} }
          : { kind: "scene", id: sc.id, scenes: [], performers: {} };
      }
      u.scenes.push(sc);
      sc.performers.forEach(function (pid) {
        u.performers[pid] = true;
        scenesPerPerformer[pid] = (scenesPerPerformer[pid] || 0) + 1;
      });
    });

    function visible(pid) {
      return !!f.genders[genderOf(base, base.performers[pid])];
    }
    function fav(pid) {
      return !!base.performers[pid].favorite;
    }

    // Counting: "scenes" -> every shared scene counts 1 and the cast limit applies to the single scene;
    // "productions" -> all scenes of one group count once and the limit applies to the whole production.
    // Each edge keeps both: the shared scenes and the productions they belong to; weight is the count
    // of the chosen mode.
    var pairs = {};
    var tooBig = 0;
    // Scenes of a production in which both performers appear; if they only appear in different scenes
    // of the same group, the scenes of either of them (so the production is never listed empty).
    function sharedScenes(list, a, b) {
      if (list.length === 1) return list;
      var both = list.filter(function (sc) {
        return sc.performers.indexOf(a) >= 0 && sc.performers.indexOf(b) >= 0;
      });
      return both.length
        ? both
        : list.filter(function (sc) {
            return sc.performers.indexOf(a) >= 0 || sc.performers.indexOf(b) >= 0;
          });
    }
    function addPairs(ids, sceneList, unit) {
      if (ids.length < 2) return;
      if (ids.length > f.maxCast) {
        tooBig++;
        return;
      }
      ids = ids.filter(visible).sort(byNumber);
      for (var i = 0; i < ids.length; i++)
        for (var j = i + 1; j < ids.length; j++) {
          var k = ids[i] + "-" + ids[j];
          var p = pairs[k] || (pairs[k] = { from: ids[i], to: ids[j], scenes: [], units: [], unitKeys: {} });
          sharedScenes(sceneList, ids[i], ids[j]).forEach(function (sc) {
            p.scenes.push(sc);
          });
          if (!p.unitKeys[unit.key]) {
            p.unitKeys[unit.key] = true;
            p.units.push(unit);
          }
        }
    }
    Object.keys(units).forEach(function (key) {
      var u = units[key];
      u.key = key;
      if (f.countBy === "productions") addPairs(Object.keys(u.performers), u.scenes, u);
      else
        u.scenes.forEach(function (sc) {
          addPairs(sc.performers.slice(), [sc], u);
        });
    });
    Object.keys(pairs).forEach(function (k) {
      var p = pairs[k];
      p.weight = f.countBy === "productions" ? p.units.length : p.scenes.length;
      p.orgasmSum = p.scenes.reduce(function (n, sc) { return n + sc.orgasmCount; }, 0);
      delete p.unitKeys;
    });

    // Performer filters (favourites, rating): a performer passing all active ones is "core". Edges between
    // two core performers are kept; with "+ partners" (allowed only if every active filter allows it) also
    // the edges of a core performer.
    var coreActive = f.favOn || f.perfStars > 0 || f.perfOrgasm;
    var partnersAllowed = (!f.favOn || f.favMode === "partners") && (!f.perfStars || f.perfStarsPartners) && (!f.perfOrgasm || f.perfOrgasmPartners);
    function core(pid) {
      if (f.favOn && !fav(pid)) return false;
      if (f.perfOrgasm && !(base.performers[pid].o_counter > 0)) return false;
      if (f.perfStars) {
        var r = base.performers[pid].rating100;
        if (r == null || r < f.perfStars * 20) return false;
      }
      return true;
    }
    var edges = Object.keys(pairs)
      .map(function (k) {
        return pairs[k];
      })
      .filter(function (e) {
        if (e.weight < f.minStrength) return false;
        if (!coreActive) return true;
        return partnersAllowed ? core(e.from) || core(e.to) : core(e.from) && core(e.to);
      });

    var neighbours = {};
    edges.forEach(function (e) {
      (neighbours[e.from] = neighbours[e.from] || {})[e.to] = e.weight;
      (neighbours[e.to] = neighbours[e.to] || {})[e.from] = e.weight;
    });

    var nodes = Object.keys(scenesPerPerformer).filter(function (pid) {
      if (!visible(pid)) return false;
      if (coreActive && !core(pid) && !(partnersAllowed && neighbours[pid])) return false;
      return f.showIsolated || !!neighbours[pid];
    });

    return {
      nodes: nodes,
      edges: edges,
      neighbours: neighbours,
      scenesPerPerformer: scenesPerPerformer,
      sceneCount: scenes.length,
      unitCount: Object.keys(units).length,
      countBy: f.countBy,
      tooBig: tooBig,
      // a tag filter is set but the tags of the scenes are not loaded yet: the result is not final
      tagsPending: f.tags.length > 0 && base.tagsLoaded === false,
    };
  }

  // Start view for large networks: at most `limit` performers, so that layout and drawing stay fast.
  // With favorites in the network: the favorites (the most connected ones if there are more than limit),
  // then each favorite's strongest partner, filled up with the partners that have the strongest ties to
  // favorites (summed edge strength). Without
  // favorites: the most connected performers (partners, then summed edge strength, then id). Edges are
  // those among the chosen performers; a performer that loses all its edges this way is left out.
  // Returns the graph unchanged when it is small enough, else a copy with limited = {shown, total, by}.
  function limitGraph(graph, base, limit) {
    if (!limit || graph.nodes.length <= limit) return graph;
    var nb = graph.neighbours, strength = {};
    function degree(id) {
      return nb[id] ? Object.keys(nb[id]).length : 0;
    }
    function sum(id) {
      if (strength[id] == null)
        strength[id] = Object.keys(nb[id] || {}).reduce(function (n, k) { return n + nb[id][k]; }, 0);
      return strength[id];
    }
    function byConnected(a, b) {
      return degree(b) - degree(a) || sum(b) - sum(a) || byNumber(a, b);
    }
    function fav(id) {
      return !!base.performers[id].favorite;
    }
    var favs = graph.nodes.filter(fav).sort(byConnected), keep;
    if (favs.length) {
      keep = favs.slice(0, limit);
      var tie = {};
      keep.forEach(function (f) {
        Object.keys(nb[f] || {}).forEach(function (p) {
          if (!fav(p)) tie[p] = (tie[p] || 0) + nb[f][p];
        });
      });
      var partners = Object.keys(tie).sort(function (a, b) {
        return tie[b] - tie[a] || byConnected(a, b);
      });
      // first every favorite's strongest partner (so no favorite ends up without an edge), then the rest
      var first = [], taken = {};
      keep.forEach(function (f) {
        var best = null;
        Object.keys(nb[f] || {}).forEach(function (p) {
          if (fav(p)) return;
          if (best == null || nb[f][p] > nb[f][best] || (nb[f][p] === nb[f][best] && byConnected(p, best) < 0)) best = p;
        });
        if (best != null && !taken[best]) first.push((taken[best] = best));
      });
      partners = first.concat(partners.filter(function (p) { return !taken[p]; }));
      keep = keep.concat(partners.slice(0, limit - keep.length));
    } else keep = graph.nodes.slice().sort(byConnected).slice(0, limit);
    var chosen = {};
    keep.forEach(function (id) {
      chosen[id] = true;
    });
    var edges = graph.edges.filter(function (e) {
      return chosen[e.from] && chosen[e.to];
    });
    var neighbours = {};
    edges.forEach(function (e) {
      (neighbours[e.from] = neighbours[e.from] || {})[e.to] = e.weight;
      (neighbours[e.to] = neighbours[e.to] || {})[e.from] = e.weight;
    });
    var nodes = graph.nodes.filter(function (id) {
      return chosen[id] && (neighbours[id] || !nb[id]); // keep performers that were isolated already
    });
    return Object.assign({}, graph, {
      nodes: nodes,
      edges: edges,
      neighbours: neighbours,
      limited: { shown: nodes.length, total: graph.nodes.length, by: favs.length ? "favorites" : "connected" },
    });
  }

  // ------------------------------------------------------------------ layout for large networks
  // Force-directed layout with the same model as vis-network's "forceAtlas2Based" solver (Barnes-Hut
  // repulsion weighted by degree, springs along edges, degree-weighted central gravity, damped velocity),
  // on typed arrays. vis-network needs ~37 ms per step for 4,581 nodes on the main thread; this runs in a
  // Web Worker (the UI turns this function into the worker's source, so it must not use anything from
  // outside its own body). input: {n, edges: Int32Array [from0, to0, from1, ...], radius: Float64Array,
  // params}; report(x, y, iterations) is called about every params.reportMs and at the end.
  function runLayout(input, report) {
    var p = input.params, n = input.n, E = input.edges, R = input.radius;
    var x = new Float64Array(n), y = new Float64Array(n), vx = new Float64Array(n), vy = new Float64Array(n);
    var fx = new Float64Array(n), fy = new Float64Array(n), deg = new Float64Array(n);
    var i, j, k;
    for (i = 0; i < n; i++) deg[i] = 1;
    for (k = 0; k < E.length; k += 2) {
      deg[E[k]]++;
      deg[E[k + 1]]++;
    }
    // start positions like vis-network: random on a disc whose radius grows with the node count
    var seed = (p.seed >>> 0) || 1;
    function rnd() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    }
    var r0 = 10 * 0.1 * n + 10;
    for (i = 0; i < n; i++) {
      var a = 2 * Math.PI * rnd(), d = r0 * Math.sqrt(rnd());
      x[i] = d * Math.cos(a);
      y[i] = d * Math.sin(a);
    }
    // quadtree in flat arrays: per cell the box (left, top, size), mass and mass-weighted centre, four
    // children and a body (node index, -1 = empty, -2 = internal)
    var cap = 8 * n + 64;
    var cl = new Float64Array(cap), ct = new Float64Array(cap), cs = new Float64Array(cap);
    var cm = new Float64Array(cap), cx = new Float64Array(cap), cy = new Float64Array(cap);
    var child = new Int32Array(cap * 4), body = new Int32Array(cap), cells = 0;
    function cell(l, t, s) {
      if (cells >= cap) return -1;
      var c = cells++;
      cl[c] = l;
      ct[c] = t;
      cs[c] = s;
      cm[c] = cx[c] = cy[c] = 0;
      body[c] = -1;
      child[4 * c] = child[4 * c + 1] = child[4 * c + 2] = child[4 * c + 3] = -1;
      return c;
    }
    function quadrant(c, b) {
      var h = cs[c] / 2;
      return (x[b] >= cl[c] + h ? 1 : 0) + (y[b] >= ct[c] + h ? 2 : 0);
    }
    function sub(c, q) {
      var h = cs[c] / 2, s = child[4 * c + q];
      if (s < 0) s = child[4 * c + q] = cell(cl[c] + (q & 1 ? h : 0), ct[c] + (q & 2 ? h : 0), h);
      return s;
    }
    function insert(root, b) {
      var c = root, depth = 0;
      for (;;) {
        cm[c] += 1;
        cx[c] += x[b];
        cy[c] += y[b];
        if (body[c] === -1 && cm[c] === 1) {
          body[c] = b;
          return;
        }
        if (body[c] >= 0) {
          // split: move the resident body one level down (identical positions stop at depth 40)
          var old = body[c];
          body[c] = -2;
          if (depth > 40) return;
          var so = sub(c, quadrant(c, old));
          if (so < 0) return;
          cm[so] += 1;
          cx[so] += x[old];
          cy[so] += y[old];
          body[so] = old;
        }
        if (depth++ > 40) return;
        var s = sub(c, quadrant(c, b));
        if (s < 0) return;
        c = s;
      }
    }
    var stack = new Int32Array(cap);
    var G = p.gravitationalConstant, theta = 1 / p.theta, overlap = 1 - Math.max(0, Math.min(1, p.avoidOverlap));
    function repel(b) {
      var top = 0, ox = x[b], oy = y[b];
      stack[top++] = 0;
      while (top) {
        var c = stack[--top];
        if (cm[c] === 0 || body[c] === b) continue;
        var mx = cx[c] / cm[c], my = cy[c] / cm[c];
        var dx = mx - ox, dy = my - oy, dist = Math.sqrt(dx * dx + dy * dy);
        if (body[c] === -2 && dist / cs[c] <= theta) {
          for (var q = 0; q < 4; q++) if (child[4 * c + q] >= 0) stack[top++] = child[4 * c + q];
          continue;
        }
        if (dist === 0) {
          dist = 0.1 * rnd();
          dx = dist;
        }
        if (overlap < 1 && R[b]) dist = Math.max(0.1 + overlap * R[b], dist - R[b]);
        var force = (G * cm[c] * deg[b]) / (dist * dist);
        fx[b] += dx * force;
        fy[b] += dy * force;
      }
    }
    var it = 0, last = Date.now(), dt = p.timestep, damping = p.damping, maxV = p.maxVelocity;
    for (it = 1; it <= p.iterations; it++) {
      // tree over the current positions
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (i = 0; i < n; i++) {
        if (x[i] < minX) minX = x[i];
        if (x[i] > maxX) maxX = x[i];
        if (y[i] < minY) minY = y[i];
        if (y[i] > maxY) maxY = y[i];
      }
      var size = Math.max(maxX - minX, maxY - minY) + 1;
      cells = 0;
      var root = cell(minX - 0.5, minY - 0.5, size);
      for (i = 0; i < n; i++) insert(root, i);
      for (i = 0; i < n; i++) {
        fx[i] = -x[i] * p.centralGravity * deg[i];
        fy[i] = -y[i] * p.centralGravity * deg[i];
        repel(i);
      }
      for (k = 0; k < E.length; k += 2) {
        i = E[k];
        j = E[k + 1];
        var ex = x[i] - x[j], ey = y[i] - y[j], len = Math.max(Math.sqrt(ex * ex + ey * ey), 0.01);
        var sf = (p.springConstant * (p.springLength - len)) / len;
        fx[i] += ex * sf;
        fy[i] += ey * sf;
        fx[j] -= ex * sf;
        fy[j] -= ey * sf;
      }
      var fastest = 0;
      for (i = 0; i < n; i++) {
        vx[i] += (fx[i] - damping * vx[i]) * dt;
        vy[i] += (fy[i] - damping * vy[i]) * dt;
        if (vx[i] > maxV) vx[i] = maxV;
        else if (vx[i] < -maxV) vx[i] = -maxV;
        if (vy[i] > maxV) vy[i] = maxV;
        else if (vy[i] < -maxV) vy[i] = -maxV;
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
        var v = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
        if (v > fastest) fastest = v;
      }
      if (fastest < p.minVelocity) break;
      if (report && Date.now() - last >= p.reportMs) {
        last = Date.now();
        report(x, y, it, false);
      }
    }
    it = Math.min(it, p.iterations);
    if (report) report(x, y, it, true);
    return { x: x, y: y, iterations: it };
  }

  // vis-network's forceAtlas2Based settings as the plugin uses them (see the options in draw())
  // The same force model in three dimensions, for the 3D view (beta): an octree instead of the quadtree,
  // start positions in a ball. Self-contained like runLayout (it is sent to the Web Worker as source
  // text), so it must not use anything outside this function. report(x, y, z, iterations, done).
  function runLayout3D(input, report) {
    var p = input.params, n = input.n, E = input.edges, R = input.radius;
    var x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
    var vx = new Float64Array(n), vy = new Float64Array(n), vz = new Float64Array(n);
    var fx = new Float64Array(n), fy = new Float64Array(n), fz = new Float64Array(n), deg = new Float64Array(n);
    var i, j, k;
    for (i = 0; i < n; i++) deg[i] = 1;
    for (k = 0; k < E.length; k += 2) {
      deg[E[k]]++;
      deg[E[k + 1]]++;
    }
    var seed = (p.seed >>> 0) || 1;
    function rnd() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    }
    // random in a ball whose radius grows with the node count (like the disc of the 2D layout)
    var r0 = 10 * 0.1 * Math.pow(n, 2 / 3) * 2 + 10;
    for (i = 0; i < n; i++) {
      var u = 2 * rnd() - 1, phi = 2 * Math.PI * rnd(), rr = r0 * Math.cbrt(rnd()), sq = Math.sqrt(1 - u * u);
      x[i] = rr * sq * Math.cos(phi);
      y[i] = rr * sq * Math.sin(phi);
      z[i] = rr * u;
    }
    // octree in flat arrays: per cell the corner (cl, ct, cf), size, mass, mass-weighted centre, eight
    // children and a body (node index, -1 = empty, -2 = internal)
    var cap = 16 * n + 64;
    var cl = new Float64Array(cap), ct = new Float64Array(cap), cf = new Float64Array(cap), cs = new Float64Array(cap);
    var cm = new Float64Array(cap), cx = new Float64Array(cap), cy = new Float64Array(cap), cz = new Float64Array(cap);
    var child = new Int32Array(cap * 8), body = new Int32Array(cap), cells = 0;
    function cell(l, t, f, sz) {
      if (cells >= cap) return -1;
      var c = cells++;
      cl[c] = l;
      ct[c] = t;
      cf[c] = f;
      cs[c] = sz;
      cm[c] = cx[c] = cy[c] = cz[c] = 0;
      body[c] = -1;
      for (var q = 0; q < 8; q++) child[8 * c + q] = -1;
      return c;
    }
    function octant(c, b) {
      var h = cs[c] / 2;
      return (x[b] >= cl[c] + h ? 1 : 0) + (y[b] >= ct[c] + h ? 2 : 0) + (z[b] >= cf[c] + h ? 4 : 0);
    }
    function sub(c, q) {
      var h = cs[c] / 2, sc = child[8 * c + q];
      if (sc < 0) sc = child[8 * c + q] = cell(cl[c] + (q & 1 ? h : 0), ct[c] + (q & 2 ? h : 0), cf[c] + (q & 4 ? h : 0), h);
      return sc;
    }
    function add(c, b) {
      cm[c] += 1;
      cx[c] += x[b];
      cy[c] += y[b];
      cz[c] += z[b];
    }
    function insert(root, b) {
      var c = root, depth = 0;
      for (;;) {
        add(c, b);
        if (body[c] === -1 && cm[c] === 1) {
          body[c] = b;
          return;
        }
        if (body[c] >= 0) {
          var old = body[c];
          body[c] = -2;
          if (depth > 40) return;
          var so = sub(c, octant(c, old));
          if (so < 0) return;
          add(so, old);
          body[so] = old;
        }
        if (depth++ > 40) return;
        var sc = sub(c, octant(c, b));
        if (sc < 0) return;
        c = sc;
      }
    }
    var stack = new Int32Array(cap);
    var G = p.gravitationalConstant, theta = 1 / p.theta, overlap = 1 - Math.max(0, Math.min(1, p.avoidOverlap));
    function repel(b) {
      var top = 0, ox = x[b], oy = y[b], oz = z[b];
      stack[top++] = 0;
      while (top) {
        var c = stack[--top];
        if (cm[c] === 0 || body[c] === b) continue;
        var dx = cx[c] / cm[c] - ox, dy = cy[c] / cm[c] - oy, dz = cz[c] / cm[c] - oz;
        var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (body[c] === -2 && dist / cs[c] <= theta) {
          for (var q = 0; q < 8; q++) if (child[8 * c + q] >= 0) stack[top++] = child[8 * c + q];
          continue;
        }
        if (dist === 0) {
          dist = 0.1 * rnd();
          dx = dist;
        }
        if (overlap < 1 && R[b]) dist = Math.max(0.1 + overlap * R[b], dist - R[b]);
        var force = (G * cm[c] * deg[b]) / (dist * dist);
        fx[b] += dx * force;
        fy[b] += dy * force;
        fz[b] += dz * force;
      }
    }
    var it = 0, last = Date.now(), dt = p.timestep, damping = p.damping, maxV = p.maxVelocity;
    function clamp(v) {
      return v > maxV ? maxV : v < -maxV ? -maxV : v;
    }
    for (it = 1; it <= p.iterations; it++) {
      var minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (i = 0; i < n; i++) {
        if (x[i] < minX) minX = x[i];
        if (x[i] > maxX) maxX = x[i];
        if (y[i] < minY) minY = y[i];
        if (y[i] > maxY) maxY = y[i];
        if (z[i] < minZ) minZ = z[i];
        if (z[i] > maxZ) maxZ = z[i];
      }
      cells = 0;
      var root = cell(minX - 0.5, minY - 0.5, minZ - 0.5, Math.max(maxX - minX, maxY - minY, maxZ - minZ) + 1);
      for (i = 0; i < n; i++) insert(root, i);
      for (i = 0; i < n; i++) {
        fx[i] = -x[i] * p.centralGravity * deg[i];
        fy[i] = -y[i] * p.centralGravity * deg[i];
        fz[i] = -z[i] * p.centralGravity * deg[i];
        repel(i);
      }
      for (k = 0; k < E.length; k += 2) {
        i = E[k];
        j = E[k + 1];
        var ex = x[i] - x[j], ey = y[i] - y[j], ez = z[i] - z[j];
        var len = Math.max(Math.sqrt(ex * ex + ey * ey + ez * ez), 0.01);
        var sf = (p.springConstant * (p.springLength - len)) / len;
        fx[i] += ex * sf;
        fy[i] += ey * sf;
        fz[i] += ez * sf;
        fx[j] -= ex * sf;
        fy[j] -= ey * sf;
        fz[j] -= ez * sf;
      }
      var fastest = 0;
      for (i = 0; i < n; i++) {
        vx[i] = clamp(vx[i] + (fx[i] - damping * vx[i]) * dt);
        vy[i] = clamp(vy[i] + (fy[i] - damping * vy[i]) * dt);
        vz[i] = clamp(vz[i] + (fz[i] - damping * vz[i]) * dt);
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
        z[i] += vz[i] * dt;
        var v = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i]);
        if (v > fastest) fastest = v;
      }
      if (fastest < p.minVelocity) break;
      if (report && Date.now() - last >= p.reportMs) {
        last = Date.now();
        report(x, y, z, it, false);
      }
    }
    it = Math.min(it, p.iterations);
    if (report) report(x, y, z, it, true);
    return { x: x, y: y, z: z, iterations: it };
  }

  // Cells of the face atlas for the 3D view. The atlas is a square texture only as large as the cells
  // need, at most 4096 px (64 MB on the graphics card) and never above the device's maxTextureSize; with
  // many performers the cells get smaller, down to minCell, and then only the first `count` performers
  // (the largest nodes) get a cell.
  function atlasGrid(n, maxTexture, wantCell, minCell) {
    var limit = Math.min(maxTexture || 4096, 4096), c = Math.min(wantCell, limit);
    while (c > minCell && Math.pow(Math.floor(limit / c), 2) < n) c = Math.max(minCell, Math.floor(c * 0.75));
    var per = Math.max(1, Math.min(Math.floor(limit / c), Math.ceil(Math.sqrt(Math.max(n, 1)))));
    return { cell: c, per: per, side: per * c, count: Math.min(n, per * per) };
  }

  var LAYOUT_PARAMS = {
    gravitationalConstant: -70, centralGravity: 0.012, springLength: 110, springConstant: 0.06, avoidOverlap: 0.5,
    damping: 0.4, timestep: 0.5, maxVelocity: 50, minVelocity: 0.1, theta: 0.5, iterations: 500, seed: 7, reportMs: 400,
  };

  // Shortest path by number of steps; among equally short paths the one with the larger sum of edge
  // strengths wins (BFS layers, then a best-sum pass over the shortest-path DAG).
  function shortestPath(graph, from, to) {
    var nb = graph.neighbours;
    if (!nb[from] || !nb[to]) return from === to ? [from] : null;
    var dist = {}, order = [from], queue = [from];
    dist[from] = 0;
    while (queue.length) {
      var u = queue.shift();
      if (u === to) break;
      Object.keys(nb[u]).forEach(function (v) {
        if (dist[v] == null) {
          dist[v] = dist[u] + 1;
          order.push(v);
          queue.push(v);
        }
      });
    }
    if (dist[to] == null) return null;
    var best = {}, prev = {};
    best[from] = 0;
    order.forEach(function (v) {
      if (v === from || dist[v] > dist[to]) return;
      Object.keys(nb[v]).forEach(function (u) {
        if (dist[u] === dist[v] - 1 && best[u] != null) {
          var s = best[u] + nb[v][u];
          if (best[v] == null || s > best[v] || (s === best[v] && byNumber(u, prev[v]) < 0)) {
            best[v] = s;
            prev[v] = u;
          }
        }
      });
    });
    var path = [to];
    while (path[0] !== from) path.unshift(prev[path[0]]);
    return path;
  }

  // ------------------------------------------------------------------ settings
  // One table for every persistent setting. Stored in Stash's plugin settings (configuration.plugins /
  // configurePlugin), so they are the same on every device and also appear under Settings -> Plugins;
  // each key needs a matching entry under "settings" in the .yml. JSON values are kept as STRING settings.
  // Booleans whose default is on are stored "negatively" (disableFaceCrops), because Stash shows a missing
  // BOOLEAN as off; "invert" makes the dialog show the positive wording.
  var SETTINGS = [
    // off by default for new installations; see effectiveStoreFaces for libraries that already have face data
    { key: "storeFaces", type: "BOOLEAN", def: false, alwaysStore: true, section: "faces", label: "setStoreFaces", help: "setStoreFacesHelp" },
    { key: "disableFaceCrops", type: "BOOLEAN", def: false, invert: true, section: "faces", label: "setUseCrops", help: "setUseCropsHelp" },
    { key: "fallbackCrop", type: "STRING", def: "auto", options: { auto: "cropAuto", top: "cropTop", upperThird: "cropUpperThird", center: "cropCenter" }, section: "faces", label: "setFallbackCrop", help: "setFallbackCropHelp" },
    { key: "nodeShape3d", type: "STRING", def: "sphere", options: { sphere: "shapeSphere", chip: "shapeChip", flat: "shapeFlat" }, section: "display", label: "setNodeShape3d", help: "setNodeShape3dHelp" },
    { key: "labelZoom", type: "NUMBER", def: 8, min: 0, max: 24, section: "display", label: "setLabelZoom", help: "setLabelZoomHelp" },
    { key: "genderColors", type: "JSON", def: {}, section: "display", label: "setGenderColors", editor: "colors" },
    { key: "startLimit", type: "NUMBER", def: 400, min: 50, max: 10000, step: 50, zeroIsDefault: true, section: "display", label: "setStartLimit", help: "setStartLimitHelp" },
    { key: "defaultCountBy", type: "STRING", def: "scenes", options: { scenes: "countScenes", productions: "countProductions" }, section: "defaults", label: "countBy" },
    { key: "defaultMaxCast", type: "NUMBER", def: 12, min: 2, max: 40, zeroIsDefault: true, section: "defaults", label: "maxCast" },
    { key: "defaultFavMode", type: "STRING", def: "partners", options: { partners: "favPartners", only: "favOnly" }, section: "defaults", label: "setFavMode" },
    { key: "nodeSizeBy", type: "STRING", def: "scenes", options: { scenes: "sizeScenes", orgasms: "sizeOrgasm" }, legacyValues: { o: "orgasms" }, section: "defaults", label: "sizeBy" },
    { key: "defaultFilters", type: "JSON", def: {}, section: "defaults", label: "setDefaultFilters", editor: "filters", legacyKeys: { orgasmOnly: "oOnly" } },
  ];
  var SETTING = {};
  SETTINGS.forEach(function (d) {
    SETTING[d.key] = d;
  });

  // Renamed keys and values stay readable: "legacyValues" maps an old option value to the new one,
  // "legacyKeys" (JSON settings) maps a new key inside the object to its old name, which is read only
  // when the new key is not stored. Saving the dialog writes the new names.
  function renameLegacy(obj, legacyKeys) {
    var out = Object.assign({}, obj);
    Object.keys(legacyKeys || {}).forEach(function (key) {
      var old = legacyKeys[key];
      if (!Object.prototype.hasOwnProperty.call(out, old)) return;
      if (out[key] == null) out[key] = out[old];
      delete out[old];
    });
    return out;
  }

  // invalid or missing values fall back to the default
  function settingValue(d, raw) {
    if (raw == null || raw === "") return d.def;
    if (d.type === "BOOLEAN") return typeof raw === "boolean" ? raw : raw === "true" ? true : raw === "false" ? false : d.def;
    if (d.type === "NUMBER") {
      var n = Number(raw);
      if (n === 0 && d.zeroIsDefault) return d.def; // Stash shows an unset NUMBER as 0
      return isFinite(n) ? Math.min(d.max, Math.max(d.min, n)) : d.def;
    }
    if (d.type === "JSON") {
      try {
        var v = typeof raw === "string" ? JSON.parse(raw) : raw;
        return v && typeof v === "object" && !Array.isArray(v) ? (d.legacyKeys ? renameLegacy(v, d.legacyKeys) : v) : d.def;
      } catch (e) {
        return d.def;
      }
    }
    raw = String(raw);
    if (d.legacyValues && Object.prototype.hasOwnProperty.call(d.legacyValues, raw)) raw = d.legacyValues[raw];
    return d.options && !Object.prototype.hasOwnProperty.call(d.options, raw) ? d.def : raw;
  }

  // Storing face positions on performers is off by default. To avoid a silent change for libraries that
  // used an earlier version (where it was on by default):
  //   1. an explicit storeFaces value wins;
  //   2. else the old key disableFaceWriteback (pre-release versions) is honoured;
  //   3. else, if performers already carry face data, it stays on ("existingData") until the setting is
  //      saved once -- the dialog says so;
  //   4. else off.
  function effectiveStoreFaces(stored, hasFaceData) {
    stored = stored || {};
    var d = SETTING.storeFaces;
    if (stored.storeFaces != null && stored.storeFaces !== "") return { value: settingValue(d, stored.storeFaces), source: "setting" };
    if (stored.disableFaceWriteback != null && stored.disableFaceWriteback !== "")
      return { value: !settingValue({ type: "BOOLEAN", def: false }, stored.disableFaceWriteback), source: "legacy" };
    if (hasFaceData) return { value: true, source: "existingData" };
    return { value: false, source: "default" };
  }

  // ctx.hasFaceData: whether any performer already has face data (see effectiveStoreFaces)
  function readSettings(stored, ctx) {
    var out = {};
    SETTINGS.forEach(function (d) {
      out[d.key] = settingValue(d, stored ? stored[d.key] : null);
    });
    var sf = effectiveStoreFaces(stored, ctx && ctx.hasFaceData);
    out.storeFaces = sf.value;
    out.storeFacesSource = sf.source;
    return out;
  }

  // the map sent to configurePlugin (it replaces the whole map): values equal to the default are left
  // out, except settings marked alwaysStore (so an explicit "off" survives the existing-data rule)
  function settingsInput(values) {
    var input = {};
    SETTINGS.forEach(function (d) {
      var v = values[d.key];
      if (!d.alwaysStore && JSON.stringify(v) === JSON.stringify(d.def)) return;
      input[d.key] = d.type === "JSON" ? JSON.stringify(v) : v;
    });
    return input;
  }

  // URL parameters that were renamed; the old name is still accepted when the new one is absent.
  var LEGACY_PARAMS = { orgasms: "o" };
  var LEGACY_PARAM_VALUES = { size: { o: "orgasms" } };
  function queryParam(q, name) {
    var v = q.get(name);
    if (v == null && LEGACY_PARAMS[name]) v = q.get(LEGACY_PARAMS[name]);
    var map = LEGACY_PARAM_VALUES[name];
    return v != null && map && Object.prototype.hasOwnProperty.call(map, v) ? map[v] : v;
  }

  // Rankings of the shown network: the strongest pairs (edge weight) and the performers with the most
  // partners. Ties are broken by name (compare, e.g. Intl.Collator), so the order does not depend on ids.
  function rankings(graph, performers, limit, compare) {
    function name(id) {
      return performers[id] ? performers[id].name : String(id);
    }
    var pairs = graph.edges.slice().sort(function (x, y) {
      return y.weight - x.weight || compare(name(x.from), name(y.from)) || compare(name(x.to), name(y.to));
    });
    var partners = graph.nodes
      .map(function (id) {
        return { id: id, count: Object.keys(graph.neighbours[id] || {}).length };
      })
      .filter(function (x) {
        return x.count > 0;
      })
      .sort(function (x, y) {
        return y.count - x.count || compare(name(x.id), name(y.id));
      });
    return {
      pairs: pairs.slice(0, limit).map(function (e) {
        return { id: e.from + "-" + e.to, from: e.from, to: e.to, weight: e.weight };
      }),
      partners: partners.slice(0, limit),
    };
  }

  // Link to Stash's scene list filtered to scenes with all of the given performers ({id, name}). Stash
  // keeps each criterion as JSON in a "c" parameter, with braces outside strings written as parentheses
  // (ListFilterModel.translateJSON in Stash's UI). Stash applies none of the network's own filters.
  function scenesUrl(performers) {
    var criterion = {
      type: "performers",
      modifier: performers.length > 1 ? "INCLUDES_ALL" : "INCLUDES",
      value: {
        items: performers.map(function (p) {
          return { id: String(p.id), label: p.name };
        }),
        excluded: [],
      },
    };
    var inString = false, escaped = false;
    var c = JSON.stringify(criterion)
      .split("")
      .map(function (ch) {
        if (escaped) {
          escaped = false;
          return ch;
        }
        if (ch === "\\" && inString) escaped = true;
        else if (ch === '"') inString = !inString;
        else if (!inString && ch === "{") return "(";
        else if (!inString && ch === "}") return ")";
        return ch;
      })
      .join("");
    return "/scenes?c=" + encodeURIComponent(c);
  }

  // The view in the URL (docs/settings.md, "URL parameters"). readView turns the query into filter values
  // (settings and their defaultFilters apply where a parameter is absent); writeView is the reverse, for
  // "Copy link to this view": it writes what differs from what the page would open with anyway, so
  // readView(writeView(f)) gives f back. count is always written, because without it the receiving
  // browser would fall back to its own last choice (sessionStorage).
  var COUNT_MODES = ["scenes", "productions"];
  function clampNumber(v, d, lo, hi) {
    var n = Number(v);
    return v != null && v !== "" && isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  }
  function performerPair(v, b) {
    var ids = (v || "").split(",");
    return ids.length === 2 && ids[0] !== ids[1] && b.performers[ids[0]] && b.performers[ids[1]] ? ids : null;
  }
  function readView(q, st, b) {
    var df = st.defaultFilters || {}, out = {};
    out.maxCast = clampNumber(q.get("maxCast"), st.defaultMaxCast, 2, 40);
    out.favMode = ["partners", "only"].indexOf(q.get("favMode")) >= 0 ? q.get("favMode") : st.defaultFavMode;
    out.favOn = q.get("fav") === "1";
    out.minStrength = clampNumber(q.get("min"), 1, 1, 10);
    var size = queryParam(q, "size");
    out.sizeBy = ["scenes", "orgasms"].indexOf(size) >= 0 ? size : st.nodeSizeBy;
    var studio = q.has("studio") ? q.get("studio") : df.studio || ""; // ?studio= (empty) = all studios
    out.studio = b.studios[studio] ? studio : "";
    var tags = q.get("tags") != null ? q.get("tags").split(",") : df.tags || [];
    out.tags = tags.map(String).filter(function (id, i, a) {
      return b.tags[id] && a.indexOf(id) === i;
    });
    out.tagMode = (q.get("tagMode") || df.tagMode) === "all" ? "all" : "any";
    out.sceneStars = clampNumber(q.get("sceneStars"), clampNumber(df.sceneStars, 0, 0, 5), 0, 5);
    out.perfStars = clampNumber(q.get("perfStars"), clampNumber(df.perfStars, 0, 0, 5), 0, 5);
    out.watchedOnly = q.get("watched") != null ? q.get("watched") === "1" : !!df.watchedOnly;
    var orgasms = queryParam(q, "orgasms");
    out.orgasmOnly = orgasms != null ? orgasms === "1" : !!df.orgasmOnly;
    // ?genders=FEMALE,MALE: only these are shown; absent = all
    var shown = q.get("genders") != null ? q.get("genders").split(",") : null;
    out.genders = {};
    (b.genders || []).forEach(function (g) {
      out.genders[g] = !shown || shown.indexOf(g) >= 0;
    });
    var count = q.get("count");
    out.countBy = COUNT_MODES.indexOf(count) >= 0 ? count : null; // null: the caller decides
    // ?from=<year>&to=<year>: scenes of these years only (0 or absent = open end)
    out.yearFrom = clampNumber(q.get("from"), 0, 0, 9999);
    out.yearTo = clampNumber(q.get("to"), 0, 0, 9999);
    out.showAll = q.get("all") === "1";
    out.view = q.get("view") === "3d" ? "3d" : "2d"; // ?view=3d: the 3D view (beta)
    // opened after the layout: ?focus=<performer id>, ?path=<id>,<id> (shortest path between the two),
    // ?edge=<id>,<id>
    var focus = q.get("focus");
    out.focus = focus && b.performers[focus] ? focus : null;
    out.path = performerPair(q.get("path"), b);
    out.edge = performerPair(q.get("edge"), b); // ?edge=<id>,<id>: the edge between the two, as if clicked
    return out;
  }
  function writeView(f, st, b, extra) {
    extra = extra || {};
    var d = readView(new URLSearchParams(""), st, b), q = new URLSearchParams();
    q.set("count", f.countBy);
    if (f.maxCast !== d.maxCast) q.set("maxCast", f.maxCast);
    if (f.favOn) q.set("fav", "1");
    if (f.favMode !== d.favMode) q.set("favMode", f.favMode);
    if (f.minStrength !== d.minStrength) q.set("min", f.minStrength);
    if (f.sizeBy !== d.sizeBy) q.set("size", f.sizeBy);
    if (f.studio !== d.studio) q.set("studio", f.studio);
    if (f.tags.join(",") !== d.tags.join(",")) q.set("tags", f.tags.join(","));
    if (f.tagMode !== d.tagMode) q.set("tagMode", f.tagMode);
    if (f.sceneStars !== d.sceneStars) q.set("sceneStars", f.sceneStars);
    if (f.perfStars !== d.perfStars) q.set("perfStars", f.perfStars);
    if (f.watchedOnly !== d.watchedOnly) q.set("watched", f.watchedOnly ? "1" : "0");
    if (f.orgasmOnly !== d.orgasmOnly) q.set("orgasms", f.orgasmOnly ? "1" : "0");
    var genders = (b.genders || []).filter(function (g) {
      return f.genders[g];
    });
    if (genders.length !== (b.genders || []).length) q.set("genders", genders.join(","));
    if (f.yearFrom) q.set("from", f.yearFrom);
    if (f.yearTo) q.set("to", f.yearTo);
    if (extra.showAll) q.set("all", "1");
    if (extra.view === "3d") q.set("view", "3d");
    if (extra.path) q.set("path", extra.path.join(","));
    else if (extra.edge) q.set("edge", extra.edge.join(","));
    else if (extra.focus) q.set("focus", extra.focus);
    return q.toString().replace(/%2C/g, ","); // commas are fine in a query and easier to read
  }

  // Detector version: bfsr2 (0.1.1) adds the second attempt on the top square of tall images. Results of
  // bfsr1 are still read; faceStillValid says which of them stand.
  var FACE_FIELD = "spn_face";
  var FACE_VERSION = "mp-tv1.0.1-bfsr2";
  var FACE_VERSIONS = [FACE_VERSION, "mp-tv1.0.1-bfsr1"];

  function readFaceField(p) {
    try {
      var raw = p.custom_fields && p.custom_fields[FACE_FIELD];
      var v = typeof raw === "string" ? JSON.parse(raw) : raw;
      return v && FACE_VERSIONS.indexOf(v.v) >= 0 && typeof v.h === "string" ? v : null;
    } catch (e) {
      return null;
    }
  }

  // A result {v, b} for an image of w x h pixels: one of the current version always stands, an earlier
  // one if it found a face or the image is not tall (there the first attempt is all the detector does).
  // An earlier "no face" for a tall image is detected again, once.
  function faceStillValid(rec, w, h) {
    return !!rec && (rec.v === FACE_VERSION || !!rec.b || !isTall(w, h));
  }

  // ------------------------------------------------------------------ request guard
  // MediaPipe's tasks-vision (vendor/mediapipe) sends usage statistics to odml.pa.googleapis.com and has
  // no option to turn that off. While the face detector exists, the UI wraps fetch, XMLHttpRequest and
  // sendBeacon and refuses a request when it leaves the page's origin and the call comes from the bundled
  // MediaPipe code (its file is on the call stack). Returns the refused host, else null.
  var MEDIAPIPE_CODE = /\/vendor\/mediapipe\//;
  function foreignHost(url, origin) {
    try {
      var u = new URL(String(url), origin);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null; // data:, blob:
      return u.origin === origin ? null : u.host;
    } catch (e) {
      return null;
    }
  }
  function blockedRequest(url, origin, stack) {
    var host = foreignHost(url, origin);
    if (!host) return null;
    if (typeof stack === "function") stack = stack();
    return MEDIAPIPE_CODE.test(stack || "") ? host : null;
  }

  // The guard is installed for as long as the detector lives (it reports when created, every 60 s and when
  // closed) and removed afterwards. Same-origin requests are passed on before anything else is looked at,
  // and the call stack is only taken for foreign ones. uninstall puts the originals back; where someone
  // else has wrapped a function on top of ours since, ours stays in place but passes everything through.
  // win: the window (or a stand-in in tests); onBlocked(host) is called for every refused request.
  function createRequestGuard(win, onBlocked, stackOf) {
    stackOf = stackOf || function () {
      return new Error().stack;
    };
    var on = false, wrapped = false, orig = {}, refused = typeof WeakSet === "function" ? new WeakSet() : null;
    function check(url) {
      if (!on) return null;
      var host = blockedRequest(url, win.location.origin, stackOf);
      if (host && onBlocked) onBlocked(host);
      return host;
    }
    var wrap = {
      fetch: function (input) {
        var url = input && typeof input === "object" && "url" in input ? input.url : input;
        if (check(url)) return Promise.reject(new TypeError("request blocked"));
        return orig.fetch.apply(this, arguments);
      },
      open: function (method, url) {
        if (refused) refused[check(url) ? "add" : "delete"](this);
        return orig.open.apply(this, arguments);
      },
      send: function () {
        if (!refused || !refused.has(this)) return orig.send.apply(this, arguments);
        var xhr = this;
        setTimeout(function () {
          xhr.dispatchEvent(new win.ProgressEvent("error"));
        }, 0);
      },
      sendBeacon: function (url) {
        return check(url) ? false : orig.sendBeacon.apply(win.navigator, arguments);
      },
    };
    function places() {
      var xhr = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
      return [
        [win, "fetch"],
        [xhr, "open"],
        [xhr, "send"],
        [win.navigator, "sendBeacon"],
      ].filter(function (p) {
        return p[0] && typeof p[0][p[1]] === "function";
      });
    }
    return {
      active: function () {
        return on;
      },
      install: function () {
        if (on) return;
        on = true;
        if (wrapped) return; // still in place (someone wrapped on top of ours): passing through ends here
        wrapped = true;
        places().forEach(function (p) {
          orig[p[1]] = p[0][p[1]];
          p[0][p[1]] = wrap[p[1]];
        });
      },
      uninstall: function () {
        if (!on) return;
        on = false;
        var kept = false;
        places().forEach(function (p) {
          if (p[0][p[1]] === wrap[p[1]]) p[0][p[1]] = orig[p[1]];
          else if (orig[p[1]]) kept = true;
        });
        wrapped = kept;
      },
    };
  }

  // Level of detail with many nodes on screen: images are drawn for at most `max` nodes, the largest
  // first. radii: on-screen radii of the nodes drawn in the last frame. Returns the smallest on-screen
  // radius that still gets an image (at least minPx).
  function imageMinRadius(radii, max, minPx) {
    var big = [];
    for (var i = 0; i < radii.length; i++) if (radii[i] >= minPx) big.push(radii[i]);
    if (big.length <= max) return minPx;
    big.sort(function (a, b) {
      return b - a;
    });
    // nodes of the same size as the last one taken would get an image or not by chance: leave them all out
    var cut = big[max - 1];
    return cut === big[max] ? cut + 1e-6 : cut;
  }

  // Arguments for a patch.before callback that adds one child (the navbar entry, the button on the
  // performer page): the props with item appended to the children, all other arguments unchanged.
  // Whatever goes wrong, the original arguments come back, so Stash's own content still renders.
  // toArray is React.Children.toArray.
  function withChild(args, item, toArray) {
    args = Array.prototype.slice.call(args || []);
    try {
      var props = args[0];
      if (!props || typeof props !== "object") return args;
      var children = toArray(props.children).concat([item]);
      return [Object.assign({}, props, { children: children })].concat(args.slice(1));
    } catch (e) {
      return args;
    }
  }

  var SPNCore = {
    PLUGIN_ID: PLUGIN_ID,
    withChild: withChild,
    blockedRequest: blockedRequest,
    createRequestGuard: createRequestGuard,
    imageMinRadius: imageMinRadius,
    GENDER_COLORS: GENDER_COLORS,
    SPARE_COLORS: SPARE_COLORS,
    UNKNOWN: UNKNOWN,
    ICON_BOX: ICON_BOX,
    ICONS: ICONS,
    ICONS_EVENODD: ICONS_EVENODD,
    byNumber: byNumber,
    pairKey: pairKey,
    localUrl: localUrl,
    bytesHash: bytesHash,
    dims: dims,
    boxToPixels: boxToPixels,
    boxToNormal: boxToNormal,
    isTall: isTall,
    fallbackSquare: fallbackSquare,
    tallRegion: tallRegion,
    regionBoxToImage: regionBoxToImage,
    I18n: I18n,
    prepareData: prepareData,
    attachTags: attachTags,
    attachOrgasms: attachOrgasms,
    attachSceneDetails: attachSceneDetails,
    genderOf: genderOf,
    selectScenes: selectScenes,
    computeGraph: computeGraph,
    limitGraph: limitGraph,
    runLayout: runLayout,
    runLayout3D: runLayout3D,
    atlasGrid: atlasGrid,
    LAYOUT_PARAMS: LAYOUT_PARAMS,
    shortestPath: shortestPath,
    SETTINGS: SETTINGS,
    SETTING: SETTING,
    settingValue: settingValue,
    effectiveStoreFaces: effectiveStoreFaces,
    readSettings: readSettings,
    settingsInput: settingsInput,
    queryParam: queryParam,
    readView: readView,
    rankings: rankings,
    dateSpan: dateSpan,
    scenesUrl: scenesUrl,
    writeView: writeView,
    FACE_FIELD: FACE_FIELD,
    FACE_VERSION: FACE_VERSION,
    readFaceField: readFaceField,
    faceStillValid: faceStillValid,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = SPNCore;
  else root.SPNCore = SPNCore;
})(typeof window !== "undefined" ? window : globalThis);
