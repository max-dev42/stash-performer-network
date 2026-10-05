/*
 * stash-performer-network -- Stash UI plugin: a network of who performed with whom.
 *
 * Adds a page (ROUTE below) and a navbar entry. Nodes are performers (round face crops), edges are
 * collaborations; the more often two performers worked together, the thicker the edge.
 *
 * Counting (see docs/features.md, "Counting rule"): by default every shared scene counts 1; optionally all scenes
 * of the same group count as ONE production. Scenes/productions with more than N performers (slider,
 * default 12) are not turned into pairs.
 *
 * Bundled libraries (no CDN, loaded lazily from the plugin's asset path when the page opens):
 *   vendor/vis-network  vis-network 10.1.2            (Apache-2.0 OR MIT)
 *   vendor/mediapipe    @mediapipe/tasks-vision 1.0.1  (Apache-2.0), model blaze_face_short_range
 *   vendor/three        three 0.186.1                  (MIT), only for the 3D view (beta), loaded with import()
 * UI texts: locales/<code>.json, loaded at runtime from the asset path (see docs/translating.md).
 */
(function () {
  "use strict";

  // ------------------------------------------------------------------ identifiers (keep in one place)
  var PLUGIN_ID = (window.SPNCore || {}).PLUGIN_ID; // defined once, in stash-performer-network-core.js
  var ROUTE = "/performer-network"; // not /plugin/...: Stash serves /plugin/* server-side (reload -> 404)
  var CSS = "spn"; // CSS class prefix
  var DB_NAME = PLUGIN_ID + "-faces";
  var DEBUG_HANDLE = "performerNetwork"; // window.performerNetwork for testing in the console
  var FALLBACK_LOCALE = "en";

  var PluginApi = window.PluginApi;
  var Core = window.SPNCore; // stash-performer-network-core.js, loaded first
  if (!PluginApi || !Core) return;
  // Loaded twice (plugin installed in two folders, or the script included again): the second copy would
  // register the route and the navbar entry once more.
  if (window.SPNLoaded) return;
  window.SPNLoaded = true;
  var GENDER_COLORS = Core.GENDER_COLORS, UNKNOWN = Core.UNKNOWN, I18n = Core.I18n, ICONS = Core.ICONS, ICON_BOX = Core.ICON_BOX;
  var byNumber = Core.byNumber, pairKey = Core.pairKey, localUrl = Core.localUrl, bytesHash = Core.bytesHash;
  var dims = Core.dims, boxToPixels = Core.boxToPixels, boxToNormal = Core.boxToNormal, fallbackSquare = Core.fallbackSquare;
  var tallRegion = Core.tallRegion, regionBoxToImage = Core.regionBoxToImage, faceStillValid = Core.faceStillValid;
  var prepareData = Core.prepareData, genderOf = Core.genderOf, selectScenes = Core.selectScenes;
  var computeGraph = Core.computeGraph, shortestPath = Core.shortestPath;
  var SETTINGS = Core.SETTINGS, readSettings = Core.readSettings;
  var FACE_FIELD = Core.FACE_FIELD, FACE_VERSION = Core.FACE_VERSION, readFaceField = Core.readFaceField;
  var React = PluginApi.React;
  var h = React.createElement;
  var RRD = PluginApi.libraries.ReactRouterDOM;
  var Bootstrap = PluginApi.libraries.Bootstrap;
  var ReactIntl = PluginApi.libraries.Intl;

  var ASSET_BASE = new URL("plugin/" + PLUGIN_ID + "/assets/", document.baseURI).href;
  var VENDOR = ASSET_BASE + "vendor/";
  var GRAPHQL = new URL("graphql", document.baseURI).href;

  // ------------------------------------------------------------------ i18n
  // Language = Stash's interface language (the locale Stash's own react-intl provider uses), else
  // navigator.language, else English. Texts come from locales/<code>.json; a missing key falls back to
  // en.json; locales/index.json lists the available codes. Placeholders are {name}; a {count} parameter
  // selects "<key>_one"/"<key>_other" etc. via
  // Intl.PluralRules. Numbers in parameters are formatted with Intl.NumberFormat of the chosen locale.

  var localeCache = {};
  function fetchLocale(code) {
    if (!localeCache[code])
      localeCache[code] = fetch(ASSET_BASE + "locales/" + code + ".json", { credentials: "same-origin" }).then(function (r) {
        return r.ok ? r.json() : null;
      }).catch(function () {
        return null;
      });
    return localeCache[code];
  }

  var i18nCache = {};
  function loadI18n(locale) {
    locale = locale || navigator.language || FALLBACK_LOCALE;
    if (i18nCache[locale]) return i18nCache[locale];
    var candidates = [locale, locale.split(/[-_]/)[0]].filter(function (c, i, a) {
      return c && a.indexOf(c) === i;
    });
    // locales/index.json lists the available codes, so no request is made for a file that does not exist
    var available = fetchLocale("index").then(function (list) {
      return Array.isArray(list) ? list : [FALLBACK_LOCALE];
    });
    i18nCache[locale] = Promise.all([available, fetchLocale(FALLBACK_LOCALE)]).then(function (res) {
      var list = res[0], fallback = res[1] || {};
      var code = candidates.filter(function (c) {
        return list.indexOf(c) >= 0;
      })[0];
      var messages = !code || code === FALLBACK_LOCALE ? Promise.resolve(fallback) : fetchLocale(code);
      return messages.then(function (m) {
        return new I18n(locale, m || fallback, fallback);
      });
    });
    return i18nCache[locale];
  }

  // Stash's configured interface language inside React components.
  function useStashLocale() {
    try {
      var intl = ReactIntl && ReactIntl.useIntl ? ReactIntl.useIntl() : null;
      if (intl && intl.locale) return intl.locale;
    } catch (e) {
      /* outside an IntlProvider */
    }
    return navigator.language || FALLBACK_LOCALE;
  }

  function useI18n() {
    var locale = useStashLocale();
    var state = React.useState(null);
    React.useEffect(
      function () {
        var alive = true;
        loadI18n(locale).then(function (i) {
          if (alive) state[1](i);
        });
        return function () {
          alive = false;
        };
      },
      [locale]
    );
    return state[0] && state[0].locale === locale ? state[0] : null;
  }

  // Unicode gender signs (not emoji); U+FE0E asks for the text glyph, never an emoji rendering.
  var GENDER_SYMBOLS = {
    FEMALE: "\u2640\ufe0e",
    MALE: "\u2642\ufe0e",
    TRANSGENDER_FEMALE: "\u26a7\ufe0e",
    TRANSGENDER_MALE: "\u26a7\ufe0e",
    INTERSEX: "\u26a5\ufe0e",
    NON_BINARY: "\u26b2\ufe0e",
    UNKNOWN: "?",
  };
  // Loading is split by when the data is needed (sizes for a library of 19,500 scenes and 5,400
  // performers): the network needs ids and numbers per scene plus each performer once (about 3.5 MB);
  // the tags per scene (5.3 MB) follow in the background; titles, screenshots and galleries are fetched
  // only for the scenes of an opened edge. The earlier single query repeated every performer in every
  // scene and returned 29.6 MB.
  // The scenes come in pages of SCENE_PAGE (a few at a time), so the status line can show progress; one
  // page of 2,000 took 0.07 s, all 19,500 at once 1.0 s. scene_count is counted from the scenes, and the
  // performers' orgasm counts (0.2 s for Stash) follow in the background (QUERY_ORGASMS).
  var QUERY =
    "query PerformerNetwork {" +
    " findPerformers(filter: {per_page: -1}) { performers { id name gender favorite rating100 image_path custom_fields } }" +
    " findGroups(filter: {per_page: -1}) { groups { id name } }" +
    " findStudios(filter: {per_page: -1}) { studios { id name parent_studio { id } } }" +
    " findTags(filter: {per_page: -1}) { tags { id name aliases } }" +
    ' genders: __type(name: "GenderEnum") { enumValues { name } }' +
    ' configuration { plugins(include: ["' + PLUGIN_ID + '"]) }' +
    "}";
  // in pages: one 5.3 MB answer cost a ~200 ms task (parsing and garbage collection) while faces were
  // detected; pages of TAG_PAGE scenes keep each step small
  var QUERY_SCENES =
    "query PerformerNetworkScenePage($page: Int, $per: Int) { findScenes(filter: {per_page: $per, page: $page, sort: \"id\", direction: ASC})" +
    " { count scenes { id date rating100 play_count o_counter performers { id } groups { group { id } } studio { id } } } }";
  var SCENE_PAGE = 2000, SCENE_PAGES_AT_ONCE = 3;
  var QUERY_ORGASMS = "query PerformerNetworkOrgasms { findPerformers(filter: {per_page: -1}) { performers { id o_counter } } }";
  var QUERY_TAGS =
    "query PerformerNetworkTags($page: Int, $per: Int) { findScenes(filter: {per_page: $per, page: $page, sort: \"id\", direction: ASC})" +
    " { scenes { id tags { id } } } }";
  var TAG_PAGE = 2500;
  var QUERY_DETAILS =
    "query PerformerNetworkScenes($ids: [ID!]) { findScenes(ids: $ids, filter: {per_page: -1}) { scenes { id title date files { basename }" +
    " paths { screenshot } galleries { id title image_count paths { cover } folder { path } files { basename } } } } }";

  // ------------------------------------------------------------------ helpers

  function loadScript(url, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = url;
      s.async = true;
      s.onload = function () {
        window[globalName] ? resolve(window[globalName]) : reject(new Error(globalName + " missing after " + url));
      };
      s.onerror = function () {
        reject(new Error("failed to load " + url));
      };
      document.head.appendChild(s);
    });
  }

  function gql(query, variables) {
    return fetch(GRAPHQL, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(variables ? { query: query, variables: variables } : { query: query }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("GraphQL HTTP " + r.status);
        return r.json();
      })
      .then(function (j) {
        if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
        return j.data;
      });
  }

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs)
      Object.keys(attrs).forEach(function (k) {
        if (attrs[k] == null) return;
        if (k === "text") e.textContent = attrs[k];
        else if (k === "class") e.className = attrs[k];
        else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]);
        else e.setAttribute(k, attrs[k]);
      });
    (children || []).forEach(function (c) {
      if (c != null) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
  }

  // Inline SVG icon (Core.ICONS) in the current text colour; decorative unless a label is given.
  var SVG_NS = "http://www.w3.org/2000/svg";
  function svgIcon(name, cls, label) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + ICON_BOX + " " + ICON_BOX);
    svg.setAttribute("width", "1em");
    svg.setAttribute("height", "1em");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("class", CSS + "-icon" + (cls ? " " + cls : ""));
    if (label) {
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", label);
      var title = document.createElementNS(SVG_NS, "title");
      title.textContent = label;
      svg.appendChild(title);
    } else svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ICONS[name]);
    if (Core.ICONS_EVENODD[name]) path.setAttribute("fill-rule", "evenodd");
    svg.appendChild(path);
    return svg;
  }

  // small heart after the name of a favorite performer
  function favIcon(p, t) {
    return p.favorite ? svgIcon("heart", CSS + "-fav", t("favorite")) : null;
  }

  function whenIdle(fn) {
    if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: 500 });
    else setTimeout(fn, 30);
  }

  // Follow the Stash theme (dark by default, custom CSS may make it light).
  function isDark() {
    var m = (getComputedStyle(document.body).backgroundColor || "").match(/\d+(\.\d+)?/g);
    if (!m || m.length < 3) return true;
    if (m.length >= 4 && Number(m[3]) === 0) return true;
    return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2] < 128;
  }

  // image_path carries "?t=<timestamp>" for real images and "default=true" for the placeholder.
  function imageStamp(imagePath) {
    try {
      var u = new URL(imagePath, document.baseURI);
      if (u.searchParams.get("default") === "true") return null;
      return u.searchParams.get("t") || "0";
    } catch (e) {
      return null;
    }
  }

  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/);
    return (parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "")).toUpperCase();
  }

  var SIZE = 160;
  function initialsImage(name, color) {
    return initialsCanvas(name, color).toDataURL("image/png");
  }
  function initialsCanvas(name, color) {
    var c = document.createElement("canvas");
    c.width = c.height = SIZE;
    var g = c.getContext("2d");
    g.fillStyle = color;
    g.fillRect(0, 0, SIZE, SIZE);
    g.fillStyle = "rgba(0,0,0,0.18)";
    g.fillRect(0, 0, SIZE, SIZE);
    g.fillStyle = "#ffffff";
    g.font = "600 64px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(initials(name), SIZE / 2, SIZE / 2 + 4);
    return c;
  }

  // Crops are canvases: drawn on the network directly, encoded (toUrl) only for the cache and the cards.
  function crop(img, x, y, side) {
    var c = document.createElement("canvas");
    c.width = c.height = SIZE;
    var g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(img, x, y, side, side, 0, 0, SIZE, SIZE);
    return c;
  }

  function toUrl(canvas) {
    return canvas.toDataURL("image/jpeg", 0.85);
  }

  // Fallback without a face: full-width square, placed by the setting fallbackCrop (see Core.fallbackSquare).
  function fallbackCrop(img, mode) {
    var d = dims(img), sq = fallbackSquare(d.w, d.h, mode);
    return crop(img, sq.x, sq.y, sq.side);
  }

  // Face: square around the largest detection, with margin for hair and chin, kept inside the image.
  function faceCrop(img, box) {
    var d = dims(img), w = d.w, ht = d.h;
    var side = Math.min(Math.max(box.width, box.height) * 1.9, w, ht);
    var cx = box.originX + box.width / 2;
    var cy = box.originY + box.height / 2 - box.height * 0.08;
    var x = Math.max(0, Math.min(w - side, cx - side / 2));
    var y = Math.max(0, Math.min(ht - side, cy - side / 2));
    return crop(img, x, y, side);
  }

  // Fetch and decode off the main thread (createImageBitmap), scaled so the longer side is at most
  // DECODE_MAX px: performer images can be several megapixels, and decoding them synchronously on the
  // main thread was the largest share of the long tasks while faces were processed.
  var DECODE_MAX = 512;
  // Resolves to {img, hash}: hash identifies the image bytes across devices (Stash's ?t= stamp is the
  // performer's updated_at and changes with any edit, including our own custom_fields write).
  function loadBitmap(url) {
    if (!window.createImageBitmap)
      return loadImage(url).then(function (img) {
        return { img: img, hash: null };
      });
    return fetch(url, { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("image HTTP " + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        var hash = bytesHash(buf);
        var blob = new Blob([buf]);
        return createImageBitmap(blob).then(function (probe) {
          var w = probe.width, ht = probe.height, f = Math.min(1, DECODE_MAX / Math.max(w, ht));
          if (f === 1) return { img: probe, hash: hash };
          probe.close();
          return createImageBitmap(blob, { resizeWidth: Math.round(w * f), resizeHeight: Math.round(ht * f), resizeQuality: "high" }).then(function (img) {
            return { img: img, hash: hash };
          });
        });
      });
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        reject(new Error("image not loadable: " + url));
      };
      img.src = url;
    });
  }

  // Small heart (favourite marker), drawn onto the vis-network canvas.
  function drawHeart(ctx, x, y, s, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(s / ICON_BOX, s / ICON_BOX);
    ctx.translate(-ICON_BOX / 2, -ICON_BOX / 2);
    var heart = iconPath("heart");
    ctx.fillStyle = "#ff3b5c";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke(heart);
    ctx.fill(heart);
    ctx.restore();
  }

  var iconPaths = {};
  function iconPath(name) {
    return iconPaths[name] || (iconPaths[name] = new Path2D(ICONS[name]));
  }

  // rating badge: number plus the star icon
  function drawBadge(ctx, x, y, text, size, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = "700 " + size + "px system-ui, sans-serif";
    var tw = ctx.measureText(text).width, star = size * 0.9, gap = size * 0.12;
    var w = tw + gap + star + size * 0.6, ht = size * 1.35;
    ctx.fillStyle = "rgba(20, 24, 28, 0.85)";
    ctx.strokeStyle = "#f5c518";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, y - ht / 2, w, ht, ht / 2);
    else ctx.rect(x - w / 2, y - ht / 2, w, ht);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f5c518";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    var left = x - (tw + gap + star) / 2;
    ctx.fillText(text, left, y + size * 0.05);
    ctx.translate(left + tw + gap, y - star / 2);
    ctx.scale(star / ICON_BOX, star / ICON_BOX);
    ctx.fill(iconPath("star"));
    ctx.restore();
  }

  // ------------------------------------------------------------------ crop cache (IndexedDB)
  // Key "<performer id>:<image timestamp>", so only new or changed images are processed again.

  var Cache = {
    db: null,
    open: function () {
      if (this.db) return Promise.resolve(this.db);
      var self = this;
      return new Promise(function (resolve) {
        var req;
        try {
          req = indexedDB.open(DB_NAME, 1);
        } catch (e) {
          return resolve(null);
        }
        req.onupgradeneeded = function () {
          req.result.createObjectStore("crops");
        };
        req.onsuccess = function () {
          self.db = req.result;
          resolve(self.db);
        };
        req.onerror = function () {
          resolve(null);
        };
      });
    },
    getMany: function (keys) {
      return this.open().then(function (db) {
        if (!db) return {};
        return new Promise(function (resolve) {
          var out = {};
          var tx = db.transaction("crops", "readonly");
          var st = tx.objectStore("crops");
          keys.forEach(function (k) {
            var r = st.get(k);
            r.onsuccess = function () {
              if (r.result) out[k] = r.result;
            };
          });
          tx.oncomplete = function () {
            resolve(out);
          };
          tx.onerror = function () {
            resolve(out);
          };
        });
      });
    },
    clear: function () {
      return this.open().then(function (db) {
        if (!db) return 0;
        return new Promise(function (resolve) {
          var st = db.transaction("crops", "readwrite").objectStore("crops");
          var c = st.count();
          c.onsuccess = function () {
            var n = c.result;
            var r = st.clear();
            r.onsuccess = function () {
              resolve(n);
            };
            r.onerror = function () {
              resolve(0);
            };
          };
          c.onerror = function () {
            resolve(0);
          };
        });
      });
    },
    put: function (k, value) {
      return this.open().then(function (db) {
        if (!db) return;
        try {
          db.transaction("crops", "readwrite").objectStore("crops").put(value, k);
        } catch (e) {
          /* quota or blocked: carry on without cache */
        }
      });
    },
  };

  // ------------------------------------------------------------------ face detection (MediaPipe)

  // MediaPipe's WASM build writes its glog/TFLite status lines to the console (the XNNPACK "INFO" line even
  // via console.error). While faces are processed, drop exactly those info/warning lines; everything else,
  // including MediaPipe errors ("E..." lines), passes through unchanged.
  var MEDIAPIPE_CHATTER = [
    /^[IW]\d{4} \d\d:\d\d:\d\d\.\d+\s+\d+ [\w.]+:\d+\]/,
    /^INFO: Created TensorFlow Lite /,
    /^Graph successfully started running\.?$/,
  ];
  var quietConsole = {
    depth: 0,
    saved: null,
    on: function () {
      if (this.depth++ > 0) return;
      var saved = (this.saved = {});
      ["log", "info", "warn", "error", "debug"].forEach(function (k) {
        saved[k] = console[k];
        console[k] = function (first) {
          if (typeof first === "string" && MEDIAPIPE_CHATTER.some(function (re) { return re.test(first); })) return;
          return saved[k].apply(console, arguments);
        };
      });
    },
    off: function () {
      if (--this.depth > 0 || !this.saved) return;
      var saved = this.saved;
      Object.keys(saved).forEach(function (k) {
        console[k] = saved[k];
      });
      this.saved = null;
    },
  };

  // Nothing leaves the Stash origin: MediaPipe's usage statistics (see Core.createRequestGuard) are refused
  // before they reach the network, also where no CSP would stop them. The guard is installed before
  // MediaPipe is loaded and removed once the detector is closed (Faces.release); the detector reports when
  // created, every 60 s and when closed, so it is closed when no faces have been detected for a while.
  var guardNotice = null, guardTold = {};
  var RequestGuard = Core.createRequestGuard(window, function (host) {
    if (guardTold[host] || !guardNotice) return;
    guardTold[host] = true;
    console.info(PLUGIN_ID + ": " + guardNotice(host));
  });

  var Faces = {
    promise: null,
    detector: function (message) {
      if (this.promise) return this.promise;
      guardNotice = message;
      RequestGuard.install();
      this.promise = loadScript(VENDOR + "mediapipe/vision_bundle.js", "Vision").then(function (Vision) {
        return Vision.FaceDetector.createFromOptions(
          {
            wasmLoaderPath: VENDOR + "mediapipe/vision_wasm_internal.js",
            wasmBinaryPath: VENDOR + "mediapipe/vision_wasm_internal.wasm",
          },
          {
            baseOptions: { modelAssetPath: VENDOR + "mediapipe/blaze_face_short_range.tflite", delegate: "CPU" },
            runningMode: "IMAGE",
            minDetectionConfidence: 0.5,
          }
        );
      });
      return this.promise;
    },
    // closes the detector (its last report is refused while the guard is still there), then removes the guard
    release: function () {
      var self = this, p = this.promise;
      if (!p) return;
      this.promise = null;
      p.then(
        function (d) {
          try {
            if (d) d.close();
          } catch (e) {
            /* already closed */
          }
        },
        function () {}
      ).then(function () {
        if (!self.promise) RequestGuard.uninstall();
      });
    },
  };

  // ------------------------------------------------------------------ view

  var HIGHLIGHT = "#f5a623";
  var HOVER_EDGE = "#ffd27a"; // a hovered edge in the 3D view
  var PATH_COLOR = "#ff6b3d";
  var NODE_MIN = 10, NODE_MAX = 46; // node radius range (vis-network "scaling")
  var HOVER_DELAY_MS = 60;

  // configurePlugin replaces the whole map, so the full set is always sent; defaults are not stored
  function saveSettings(values) {
    var input = Core.settingsInput(values);
    return fetch(GRAPHQL, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "mutation SpnSettings($i: Map!) { configurePlugin(plugin_id: \"" + PLUGIN_ID + "\", input: $i) }", variables: { i: input } }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
        return j.data.configurePlugin;
      });
  }

  // Counting mode: URL parameter ?count=scenes|productions, else the session's last choice, else scenes.
  var COUNT_PARAM = "count", COUNT_KEY = PLUGIN_ID + ":countBy", COUNT_MODES = ["scenes", "productions"];
  function readCountBy(fallback) {
    var v = null;
    try {
      v = new URLSearchParams(location.search).get(COUNT_PARAM);
      if (COUNT_MODES.indexOf(v) < 0) v = sessionStorage.getItem(COUNT_KEY);
    } catch (e) {
      /* no storage */
    }
    return COUNT_MODES.indexOf(v) >= 0 ? v : fallback || "scenes";
  }
  function storeCountBy(v, history) {
    try {
      sessionStorage.setItem(COUNT_KEY, v);
    } catch (e) {
      /* no storage */
    }
    var q = new URLSearchParams(location.search);
    q.set(COUNT_PARAM, v);
    history.replace({ pathname: location.pathname, search: "?" + q.toString() });
  }

  function NetworkView(root, history, i18n) {
    this.root = root;
    this.history = history;
    this.i18n = i18n;
    this.images = {}; // performer id -> {kind: "face" | "fallback" | "plain", url, canvas} (cards, cache)
    this.f = {
      studio: "",
      tags: [],
      tagMode: "any",
      minStrength: 1,
      maxCast: 12,
      countBy: "scenes",
      favOn: false,
      favMode: "partners",
      sceneStars: 0,
      watchedOnly: false,
      orgasmOnly: false,
      perfStars: 0,
      perfStarsPartners: true,
      perfOrgasm: false,
      perfOrgasmPartners: true,
      sizeBy: "scenes",
      edgeByOrgasm: false,
      showIsolated: false,
      genders: {},
      yearFrom: 0, // 0 = open end
      yearTo: 0,
    };
    this.pics = {}; // performer id -> canvas or <img> drawn in the node (see drawNode)
    this.imageItems = {}; // performer id -> image job (see pumpImages)
    this.wanted = {}; // performer id -> on-screen radius, for nodes drawn large enough for an image
    this.frame = { scale: 1, radii: [], imgMin: IMG_MIN_PX, wanted: {} };
    this.nodeAlpha = {};
    this.drawMode = null;
    this.mode = null; // null | {kind: "focus", pid} | {kind: "path", nodes: [...]}
    this.pathStart = null;
    this.timing = { start: performance.now() };
    this.destroyed = false;
    var self = this;
    this.onKey = function (e) {
      if (e.key !== "Escape" || self.modal || e.defaultPrevented || e.cancelBubble) return;
      if (self.sideOpen && self.narrow()) self.setSidebar(false); // the overlay first
      else self.clearMode();
    };
    document.addEventListener("keydown", this.onKey);
    this.onHide = function () {
      self.flushWrites();
    };
    window.addEventListener("pagehide", this.onHide);
    window[DEBUG_HANDLE] = this;
  }

  NetworkView.prototype.t = function (key, params) {
    return this.i18n.t(key, params);
  };

  // All scenes in pages (QUERY_SCENES): the first page tells the total, the rest follow a few at a time.
  NetworkView.prototype.loadScenes = function () {
    var self = this, pages = [];
    function page(n) {
      return gql(QUERY_SCENES, { page: n, per: SCENE_PAGE }).then(function (d) {
        pages[n - 1] = d.findScenes.scenes;
        return d.findScenes.count;
      });
    }
    function progress(total) {
      var done = pages.reduce(function (sum, p) { return sum + (p ? p.length : 0); }, 0);
      if (!self.destroyed && total > SCENE_PAGE) self.setStatus(self.t("loadingScenePages", { done: Math.min(done, total), total: total }));
    }
    return page(1).then(function (total) {
      var last = Math.max(1, Math.ceil(total / SCENE_PAGE)), next = 2;
      progress(total);
      function worker() {
        if (next > last || self.destroyed) return null;
        return page(next++).then(function () {
          progress(total);
          return worker();
        });
      }
      var workers = [];
      for (var i = 0; i < SCENE_PAGES_AT_ONCE; i++) workers.push(worker());
      return Promise.all(workers).then(function () {
        // a scene added or removed while loading can shift a page: keep each id once
        var seen = {}, all = [];
        pages.forEach(function (p) {
          (p || []).forEach(function (sc) {
            if (!seen[sc.id]) all.push((seen[sc.id] = sc));
          });
        });
        return all;
      });
    });
  };

  NetworkView.prototype.loadOrgasms = function () {
    var self = this;
    if (!this.orgasmsPromise)
      this.orgasmsPromise = this.base.orgasmsLoaded
        ? Promise.resolve()
        : gql(QUERY_ORGASMS)
            .then(function (d) {
              if (self.destroyed) return;
              Core.attachOrgasms(self.base, d.findPerformers.performers);
              self.timing.orgasms = Math.round(performance.now() - self.timing.start);
            })
            .catch(function (e) {
              console.error(PLUGIN_ID + ":", e);
              self.base.orgasmsLoaded = true; // without counts rather than waiting for ever
            })
            .then(function () {
              if (!self.destroyed && self.orgasmsArrived) self.orgasmsArrived();
            });
    return this.orgasmsPromise;
  };

  NetworkView.prototype.start = function () {
    var self = this;
    this.buildLayout();
    this.setStatus(this.t("loading"));
    Promise.all([gql(QUERY), this.loadScenes(), loadScript(VENDOR + "vis-network/vis-network.min.js", "vis")])
      .then(function (res) {
        if (self.destroyed) return;
        self.timing.data = Math.round(performance.now() - self.timing.start);
        res[0].findScenes = { scenes: res[1] };
        self.base = prepareData(res[0]);
        self.base.genders.forEach(function (g) {
          self.f.genders[g] = true;
        });
        self.settings = readSettings(self.base.settings, { hasFaceData: self.hasFaceData() });
        self.defaultColors = Object.assign({}, self.base.genderColors);
        self.applySettings();
        self.applyDefaults();
        self.buildFilters();
        var tags = self.loadTags();
        // a tag filter from the URL or the defaults needs the tags of the scenes: wait for them instead
        // of drawing a network that the filter would change a moment later
        if (self.f.tags.length && !self.base.tagsLoaded) {
          self.setStatus(self.t("loadingTags"));
          tags.then(function () {
            if (self.destroyed) return;
            self.draw();
            self.prepareImages();
          });
          return;
        }
        self.draw();
        self.prepareImages();
        whenIdle(function () {
          if (!self.destroyed) self.loadOrgasms();
        });
      })
      .catch(function (e) {
        console.error(PLUGIN_ID + ":", e);
        self.setStatus(self.t("error", { message: e.message }), true);
      });
  };

  // Tags per scene, loaded once in the background after the main data (see QUERY_TAGS). If they fail, the
  // tag field says so; nothing else depends on them.
  NetworkView.prototype.loadTags = function () {
    var self = this;
    if (this.tagsPromise) return this.tagsPromise;
    if (this.base.tagsLoaded) return (this.tagsPromise = Promise.resolve());
    function page(n) {
      return gql(QUERY_TAGS, { page: n, per: TAG_PAGE }).then(function (d) {
        if (self.destroyed) return;
        var scenes = d.findScenes.scenes, last = scenes.length < TAG_PAGE;
        Core.attachTags(self.base, scenes, last);
        if (last) self.timing.tags = Math.round(performance.now() - self.timing.start);
        else return page(n + 1);
      });
    }
    this.tagsPromise = page(1)
      .catch(function (e) {
        self.tagsError = e.message || String(e);
        console.error(PLUGIN_ID + ":", e);
      })
      .then(function () {
        if (!self.destroyed && self.onTagsLoaded) self.onTagsLoaded();
      });
    return this.tagsPromise;
  };

  // Title, date, screenshot and galleries of the given scenes, fetched once per scene when an edge or a
  // path step is opened.
  NetworkView.prototype.ensureDetails = function (scenes) {
    var self = this;
    var missing = scenes.filter(function (sc) { return !sc.detail; }).map(function (sc) { return sc.id; });
    if (!missing.length) return Promise.resolve();
    return gql(QUERY_DETAILS, { ids: missing }).then(function (d) {
      Core.attachSceneDetails(self.base, d.findScenes.scenes);
    });
  };

  NetworkView.prototype.hasFaceData = function () {
    var p = this.base.performers;
    return Object.keys(p).some(function (id) {
      return !!readFaceField(p[id]);
    });
  };

  // display settings (colours of genders) -- also used after saving the dialog
  NetworkView.prototype.applySettings = function () {
    var self = this, custom = this.settings.genderColors || {};
    this.base.genderColors = Object.assign({}, this.defaultColors);
    Object.keys(custom).forEach(function (g) {
      if (self.base.genderColors[g] && /^#[0-9a-f]{6}$/i.test(custom[g])) self.base.genderColors[g] = custom[g];
    });
  };

  // Filter defaults from the settings; URL parameters override them for the current view:
  // ?count= ?maxCast= ?favMode= ?size= ?studio= ?tags=1,2 ?tagMode=any|all ?sceneStars= ?perfStars= ?watched=1 ?orgasms=1
  // (older names still accepted: ?o=1, ?size=o; see Core.queryParam)
  NetworkView.prototype.applyDefaults = function () {
    var q;
    try {
      q = new URLSearchParams(location.search);
    } catch (e) {
      q = new URLSearchParams("");
    }
    var v = Core.readView(q, this.settings, this.base);
    var f = this.f;
    ["maxCast", "favMode", "favOn", "minStrength", "sizeBy", "studio", "tags", "tagMode", "sceneStars", "perfStars", "watchedOnly", "orgasmOnly", "genders", "yearFrom", "yearTo"].forEach(function (k) {
      f[k] = v[k];
    });
    f.countBy = readCountBy(this.settings.defaultCountBy);
    this.showAll = v.showAll; // no reduced start view (see Core.limitGraph)
    this.view3d = v.view === "3d" && webglAvailable(); // 3D view (beta)
    this.initialView = v.focus || v.path || v.edge ? { focus: v.focus, path: v.path, edge: v.edge } : null; // opened once the layout is done
    // comparing and measuring: ?spnLayout=page (vis-network on the page) or worker, regardless of size
    this.layoutMode = ["page", "worker"].indexOf(q.get("spnLayout")) >= 0 ? q.get("spnLayout") : null;
  };

  // The current view as a link (Core.writeView), with the highlighted performer or path.
  NetworkView.prototype.viewLink = function () {
    var m = this.mode || {};
    var query = Core.writeView(this.f, this.settings, this.base, {
      showAll: this.showAll,
      view: this.view3d ? "3d" : null,
      focus: m.kind === "focus" ? m.pid : null,
      path: m.kind === "path" ? [m.nodes[0], m.nodes[m.nodes.length - 1]] : null,
      edge: m.kind === "edge" ? [this.edgeIndex[m.id].from, this.edgeIndex[m.id].to] : null,
    });
    return location.origin + location.pathname + (query ? "?" + query : "");
  };

  NetworkView.prototype.copyLink = function () {
    var self = this, url = this.viewLink();
    function done() {
      self.setStatus(self.t("linkCopied"));
    }
    function manual() {
      window.prompt(self.t("copyLinkManual"), url);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, manual);
    else manual();
  };

  // Large networks start reduced (setting startLimit); the status line says so and offers "Show all",
  // which holds for this page (and is kept in the URL as ?all=1). After "Show all", the same place offers
  // the way back.
  NetworkView.prototype.updateLimitBox = function () {
    var self = this, lim = this.graph.limited, box = this.limitBox;
    var limit = this.settings.startLimit, reducible = this.showAll && limit > 0 && this.fullGraph.nodes.length > limit;
    box.innerHTML = "";
    box.hidden = !lim && !reducible;
    function setAll(on) {
      self.showAll = on;
      var q = new URLSearchParams(location.search);
      if (on) q.set("all", "1");
      else q.delete("all");
      var search = q.toString();
      self.history.replace({ pathname: location.pathname, search: search ? "?" + search : "" });
      self.draw();
    }
    if (reducible) {
      box.appendChild(
        el("button", { type: "button", class: "btn btn-sm btn-secondary " + CSS + "-show-reduced", id: CSS + "-show-reduced", text: this.t("showReduced"), onclick: function () {
          setAll(false);
        } })
      );
      return;
    }
    if (!lim) return;
    var text = this.t("limitNotice", { shown: lim.shown, total: lim.total, reason: this.t(lim.by === "favorites" ? "limitByFavorites" : "limitByConnected") });
    box.appendChild(el("span", { class: CSS + "-limit-text", title: text, text: text }));
    box.appendChild(
      el("button", { type: "button", class: "btn btn-sm btn-warning " + CSS + "-show-all", id: CSS + "-show-all", text: this.t("showAll"), onclick: function () {
        setAll(true);
      } })
    );
  };

  NetworkView.prototype.destroy = function () {
    this.destroyed = true;
    document.removeEventListener("keydown", this.onKey);
    window.removeEventListener("pagehide", this.onHide);
    clearTimeout(this.hoverTimer);
    clearTimeout(this.redrawTimer);
    this.quiet(false);
    this.releaseDetector();
    this.stopLayoutWorker();
    if (this.writeQueue && this.writeQueue.length) this.flushWrites(); // send what was collected before leaving
    if (this.network) this.network.destroy();
    if (window[DEBUG_HANDLE] === this) window[DEBUG_HANDLE] = null;
  };

  NetworkView.prototype.buildLayout = function () {
    this.dark = isDark();
    this.root.classList.add(CSS + (this.dark ? "-dark" : "-light"));
    this.root.setAttribute("lang", this.i18n.locale);
    this.sidebar = el("aside", { class: CSS + "-sidebar" });
    this.canvas = el("div", { class: CSS + "-canvas", role: "region", "aria-label": this.t("canvasLabel") });
    // status line: the note on a reduced start view (with "Show all") and the status text
    this.limitBox = el("span", { class: CSS + "-limit", hidden: "" });
    this.statusText = el("span", { class: CSS + "-status-text", role: "status", "aria-live": "polite" });
    this.statusLine = el("div", { class: CSS + "-status" }, [this.limitBox, this.statusText]);
    this.detail = el("div", { class: CSS + "-detail", hidden: "" });
    this.card = el("div", { class: CSS + "-card", hidden: "" });
    var self = this;
    this.sidebar.id = CSS + "-sidebar";
    this.sideOpenButton = el("button", {
      type: "button", class: "btn btn-sm btn-secondary " + CSS + "-side-open", "aria-controls": this.sidebar.id, "aria-expanded": "false",
      onclick: function () { self.setSidebar(true); },
    }, [svgIcon("filter"), el("span", { text: " " + this.t("filters") })]);
    this.root.appendChild(this.sidebar);
    this.root.appendChild(el("div", { class: CSS + "-main" }, [this.canvas, this.sideOpenButton, this.detail, this.card, this.statusLine]));
    this.setSidebar(Sidebar.get(this.narrow()), true);
  };

  // The sidebar can be closed (a "Filters" button over the network opens it again). On narrow screens it
  // starts closed and opens over the network; the choice is remembered per screen class in this browser.
  var Sidebar = {
    key: function (narrow) {
      return PLUGIN_ID + ":sidebar:" + (narrow ? "narrow" : "wide");
    },
    get: function (narrow) {
      try {
        var v = localStorage.getItem(this.key(narrow));
        if (v === "1" || v === "0") return v === "1";
      } catch (e) {
        /* no storage */
      }
      return !narrow;
    },
    set: function (narrow, open) {
      try {
        localStorage.setItem(this.key(narrow), open ? "1" : "0");
      } catch (e) {
        /* no storage */
      }
    },
  };
  var NARROW = "(max-width: 767px)";
  NetworkView.prototype.narrow = function () {
    return !!(window.matchMedia && window.matchMedia(NARROW).matches);
  };
  NetworkView.prototype.setSidebar = function (open, initial) {
    this.sideOpen = open;
    this.root.classList.toggle(CSS + "-side-closed", !open);
    this.sideOpenButton.setAttribute("aria-expanded", open ? "true" : "false");
    if (this.sideCloseButton) this.sideCloseButton.setAttribute("aria-expanded", open ? "true" : "false");
    if (initial) return;
    Sidebar.set(this.narrow(), open);
    if (open && this.sideCloseButton) this.sideCloseButton.focus();
    else if (!open) this.sideOpenButton.focus();
  };
  // after picking a performer, edge or path in the sidebar: on a narrow screen show the network again
  NetworkView.prototype.revealNetwork = function () {
    if (this.sideOpen && this.narrow()) this.setSidebar(false);
  };

  NetworkView.prototype.setStatus = function (text, isError) {
    this.statusText.textContent = text;
    this.statusLine.classList.toggle(CSS + "-error", !!isError);
  };

  NetworkView.prototype.findPerformer = function (text) {
    text = String(text || "").trim().toLowerCase();
    if (!text) return null;
    var b = this.base, hit = null;
    var ids = Object.keys(b.performers);
    ids.some(function (id) {
      if (b.performers[id].name.toLowerCase() === text) return (hit = id);
    });
    if (!hit)
      ids.some(function (id) {
        if (b.performers[id].name.toLowerCase().indexOf(text) >= 0) return (hit = id);
      });
    return hit;
  };

  // why a performer found by name is not drawn: filtered out, or only left out of the reduced start view
  NetworkView.prototype.missingText = function (pid) {
    var name = this.base.performers[pid].name;
    var inFull = this.graph.limited && this.fullGraph.nodes.indexOf(pid) >= 0;
    return this.t(inFull ? "notInView" : "filteredOut", { name: name });
  };

  NetworkView.prototype.buildFilters = function () {
    var self = this, f = this.f, b = this.base, t = this.t.bind(this);
    var collator = (this.collator = new Intl.Collator(this.i18n.locale));
    function byName(x, y) {
      return collator.compare(b.studios[x].name, b.studios[y].name);
    }

    // -- search and "path to"
    var names = el("datalist", { id: CSS + "-names" });
    Object.keys(b.performers)
      .map(function (id) {
        return b.performers[id].name;
      })
      .sort(collator.compare)
      .forEach(function (n) {
        names.appendChild(el("option", { value: n }));
      });
    var search = el("input", { type: "search", class: "form-control form-control-sm", id: CSS + "-search", list: CSS + "-names", placeholder: t("searchPlaceholder"), autocomplete: "off" });
    var pathTo = el("input", { type: "search", class: "form-control form-control-sm mt-1", id: CSS + "-path-to", list: CSS + "-names", placeholder: t("pathPlaceholder"), autocomplete: "off" });
    var searchMsg = el("div", { class: CSS + "-hint", id: CSS + "-search-msg" });
    function runSearch() {
      searchMsg.textContent = "";
      if (!search.value.trim()) return;
      var hit = self.findPerformer(search.value);
      if (!hit) return (searchMsg.textContent = t("notFound", { text: search.value.trim() }));
      if (!self.nodes.get(hit)) return (searchMsg.textContent = self.missingText(hit));
      if (pathTo.value.trim()) return runPath();
      self.focusPerformer(hit, true);
      self.revealNetwork();
    }
    function runPath() {
      searchMsg.textContent = "";
      if (!pathTo.value.trim()) return;
      var from = self.findPerformer(search.value);
      if (!from) return (searchMsg.textContent = t("pathNeedsStart"));
      var to = self.findPerformer(pathTo.value);
      if (!to) return (searchMsg.textContent = t("notFound", { text: pathTo.value.trim() }));
      [from, to].forEach(function (id) {
        if (!self.nodes.get(id)) searchMsg.textContent = self.missingText(id);
      });
      if (searchMsg.textContent) return;
      if (!self.showPath(from, to)) searchMsg.textContent = t("noPath", { from: b.performers[from].name, to: b.performers[to].name });
      else self.revealNetwork();
    }
    [[search, runSearch], [pathTo, runPath]].forEach(function (pair) {
      pair[0].addEventListener("change", pair[1]);
      pair[0].addEventListener("keydown", function (e) {
        if (e.key === "Enter") pair[1]();
      });
    });

    // -- studio / network as a tree, only branches that have scenes
    var select = el("select", { class: "form-control form-control-sm", id: CSS + "-studio" });
    select.appendChild(el("option", { value: "", text: t("allStudios") }));
    var roots = Object.keys(b.studios)
      .filter(function (id) {
        var s = b.studios[id];
        return !s.parent || !b.studios[s.parent];
      })
      .sort(byName);
    (function addOptions(ids, depth) {
      ids.forEach(function (id) {
        var s = b.studios[id];
        if (!s.scenes) return;
        var isNetwork = s.children.some(function (k) {
          return b.studios[k].scenes > 0;
        });
        var label = new Array(depth + 1).join("\u2003") + t(isNetwork ? "studioNetworkOption" : "studioOption", { name: s.name, count: s.scenes });
        select.appendChild(el("option", { value: id, text: label }));
        addOptions(s.children.slice().sort(byName), depth + 1);
      });
    })(roots, 0);
    select.value = f.studio;
    select.addEventListener("change", function () {
      f.studio = select.value;
      self.draw();
    });

    // -- tags: chips plus an autocomplete list (substring of name or alias, case-insensitive). Counts are
    // scenes of the current selection that carry the tag: studio filter, and in "all" mode also the
    // tags chosen so far (adding one narrows further); in "any" mode the studio filter only.
    var tagInput = el("input", {
      type: "text", class: "form-control form-control-sm", id: CSS + "-tag", placeholder: t("tagPlaceholder"), autocomplete: "off",
      role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": CSS + "-tag-list",
    });
    var tagList = el("ul", { class: CSS + "-suggest", id: CSS + "-tag-list", role: "listbox", hidden: "" });
    var tagBox = el("div", { class: CSS + "-combo" }, [tagInput, tagList]);
    var chips = el("div", { class: CSS + "-chips" });
    var suggestions = [], active = -1;
    function lower(x) {
      return String(x).toLocaleLowerCase(self.i18n.locale);
    }
    function tagCounts() {
      var counts = {};
      selectScenes(b, f, f.tagMode === "all").forEach(function (sc) {
        Object.keys(sc.tagIds).forEach(function (id) {
          counts[id] = (counts[id] || 0) + 1;
        });
      });
      return counts;
    }
    function computeSuggestions(text) {
      if (!b.tagsLoaded) return [];
      var q = lower(text.trim()), counts = tagCounts(), out = [];
      Object.keys(counts).forEach(function (id) {
        if (f.tags.indexOf(id) >= 0) return;
        var tag = b.tags[id], rank = -1, alias = null;
        if (!q) rank = 2;
        else {
          var n = lower(tag.name);
          if (n.indexOf(q) === 0) rank = 0;
          else if (n.indexOf(q) > 0) rank = 1;
          else
            tag.aliases.some(function (a) {
              if (lower(a).indexOf(q) >= 0) {
                alias = a;
                rank = 1;
                return true;
              }
            });
        }
        if (rank >= 0) out.push({ id: id, name: tag.name, alias: alias, count: counts[id], rank: rank });
      });
      out.sort(function (x, y) {
        return x.rank - y.rank || y.count - x.count || collator.compare(x.name, y.name);
      });
      return out.slice(0, q ? 30 : 15);
    }
    function renderSuggestions() {
      tagList.innerHTML = "";
      if (!b.tagsLoaded)
        tagList.appendChild(el("li", { class: CSS + "-suggest-empty", text: self.tagsError ? t("tagsFailed", { message: self.tagsError }) : t("loadingTags") }));
      else if (!suggestions.length && tagInput.value.trim())
        tagList.appendChild(el("li", { class: CSS + "-suggest-empty", text: t("noTagMatch") }));
      suggestions.forEach(function (sg, i) {
        tagList.appendChild(
          el("li", {
            id: CSS + "-tag-opt-" + i, role: "option", class: i === active ? "active" : null, "aria-selected": i === active ? "true" : "false",
            onmousedown: function (ev) {
              ev.preventDefault(); // keep focus in the input
              pickTag(sg.id);
            },
          }, [
            el("span", { class: CSS + "-suggest-name", text: sg.name }),
            sg.alias ? el("span", { class: CSS + "-suggest-alias", text: t("tagAlias", { alias: sg.alias }) }) : null,
            el("span", { class: CSS + "-suggest-count", text: t("tagSceneCount", { count: sg.count }) }),
          ])
        );
      });
      tagList.hidden = !tagList.children.length;
      tagInput.setAttribute("aria-expanded", tagList.hidden ? "false" : "true");
      if (active >= 0) tagInput.setAttribute("aria-activedescendant", CSS + "-tag-opt-" + active);
      else tagInput.removeAttribute("aria-activedescendant");
      var cur = tagList.children[active];
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
    }
    function openSuggestions() {
      suggestions = computeSuggestions(tagInput.value);
      active = tagInput.value.trim() && suggestions.length ? 0 : -1;
      renderSuggestions();
    }
    function closeSuggestions() {
      tagList.hidden = true;
      tagInput.setAttribute("aria-expanded", "false");
      tagInput.removeAttribute("aria-activedescendant");
      active = -1;
    }
    function pickTag(id) {
      tagInput.value = "";
      if (f.tags.indexOf(id) < 0) {
        f.tags.push(id);
        renderChips();
        self.draw();
      }
      openSuggestions();
    }
    // suggestions opened while the tags were still loading are refreshed once they are there
    this.onTagsLoaded = function () {
      if (document.activeElement === tagInput) openSuggestions();
    };
    tagInput.addEventListener("input", openSuggestions);
    tagInput.addEventListener("focus", openSuggestions);
    tagInput.addEventListener("blur", function () {
      setTimeout(function () {
        if (document.activeElement !== tagInput) closeSuggestions();
      }, 0);
    });
    tagInput.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (tagList.hidden) return openSuggestions();
        if (!suggestions.length) return;
        active = e.key === "ArrowDown" ? (active + 1) % suggestions.length : (active <= 0 ? suggestions.length : active) - 1;
        renderSuggestions();
      } else if (e.key === "Enter") {
        e.preventDefault();
        var sg = suggestions[active >= 0 ? active : 0];
        if (!tagList.hidden && sg) pickTag(sg.id);
      } else if (e.key === "Escape") {
        e.stopPropagation(); // do not reset the network highlight as well
        closeSuggestions();
      }
    });
    function renderChips() {
      chips.innerHTML = "";
      f.tags.forEach(function (id) {
        chips.appendChild(
          el("span", { class: CSS + "-chip" }, [
            b.tags[id].name,
            el("button", {
              type: "button",
              class: CSS + "-chip-x",
              title: t("removeTag", { name: b.tags[id].name }),
              "aria-label": t("removeTag", { name: b.tags[id].name }),
              text: "\u00d7",
              onclick: function () {
                f.tags = f.tags.filter(function (x) { return x !== id; });
                renderChips();
                self.draw();
              },
            }),
          ])
        );
      });
    }
    function radio(name, id, label, checked, onPick) {
      var r = el("input", { type: "radio", name: name, id: id, class: "custom-control-input" });
      r.checked = checked;
      r.addEventListener("change", function () {
        if (r.checked) onPick();
      });
      return el("div", { class: "custom-control custom-radio" }, [r, el("label", { class: "custom-control-label", for: id, text: label })]);
    }
    renderChips(); // tags preset by defaults or URL
    var tagMode = el("div", { class: CSS + "-sub" }, [
      el("span", { class: CSS + "-hint", text: t("tagMatch") }),
      radio(CSS + "-tagmode", CSS + "-tagmode-any", t("tagModeAny"), f.tagMode !== "all", function () { f.tagMode = "any"; if (f.tags.length) self.draw(); }),
      radio(CSS + "-tagmode", CSS + "-tagmode-all", t("tagModeAll"), f.tagMode === "all", function () { f.tagMode = "all"; if (f.tags.length) self.draw(); }),
    ]);

    function slider(id, label, min, max, value, set) {
      var shown = el("span", { class: CSS + "-value", text: String(value) });
      var r = el("input", { type: "range", class: "custom-range", id: id, min: min, max: max, value: value });
      r.addEventListener("input", function () {
        shown.textContent = r.value;
      });
      r.addEventListener("change", function () {
        set(Number(r.value));
        self.draw();
      });
      return el("div", { class: CSS + "-field" }, [el("label", { for: id }, [label + " ", shown]), r]);
    }

    function checkbox(id, label, value, set, color) {
      var c = el("input", { type: "checkbox", id: id, class: "custom-control-input" });
      c.checked = value;
      c.addEventListener("change", function () {
        set(c.checked);
        self.draw();
      });
      var content = color ? [el("span", { class: CSS + "-dot", style: "background:" + color }), label] : [label];
      return el("div", { class: "custom-control custom-checkbox" }, [c, el("label", { class: "custom-control-label", for: id }, content)]);
    }

    // -- favourites: on/off plus mode
    var favModes = el("div", { class: CSS + "-sub" }, [
      radio(CSS + "-favmode", CSS + "-fav-partners", t("favPartners"), f.favMode !== "only", function () { f.favMode = "partners"; if (f.favOn) self.draw(); }),
      radio(CSS + "-favmode", CSS + "-fav-only", t("favOnly"), f.favMode === "only", function () { f.favMode = "only"; if (f.favOn) self.draw(); }),
    ]);
    function syncFavModes() {
      favModes.querySelectorAll("input").forEach(function (i) {
        i.disabled = !f.favOn;
      });
    }

    // -- gender legend with filter
    var genderCount = {};
    Object.keys(b.performers).forEach(function (id) {
      var g = genderOf(b, b.performers[id]);
      genderCount[g] = (genderCount[g] || 0) + 1;
    });

    var s = this.sidebar;
    s.appendChild(
      el("div", { class: CSS + "-head" }, [
        el("h4", { text: t("title") }),
        webglAvailable()
          ? el("button", {
            type: "button", class: "btn btn-sm btn-secondary " + CSS + "-gear " + CSS + "-view-toggle", id: CSS + "-view-toggle",
            title: t(this.view3d ? "view2d" : "view3d"), "aria-label": t(this.view3d ? "view2d" : "view3d"),
            text: this.view3d ? "2D" : "3D", onclick: function () { self.switchView(!self.view3d); },
          })
          : null,
        el("button", {
          type: "button", class: "btn btn-sm btn-secondary " + CSS + "-gear", id: CSS + "-copy-link",
          title: t("copyLink"), "aria-label": t("copyLink"),
          onclick: function () { self.copyLink(); },
        }, [svgIcon("copy")]),
        el("button", {
          type: "button", class: "btn btn-sm btn-secondary " + CSS + "-gear", id: CSS + "-settings-open",
          title: t("settings"), "aria-label": t("settings"), "aria-haspopup": "dialog",
          onclick: function () { self.openSettings(); },
        }, [svgIcon("gear")]),
        (this.sideCloseButton = el("button", {
          type: "button", class: "btn btn-sm btn-secondary " + CSS + "-gear " + CSS + "-side-close", id: CSS + "-side-close",
          title: t("hideFilters"), "aria-label": t("hideFilters"), "aria-controls": this.sidebar.id, "aria-expanded": this.sideOpen ? "true" : "false",
          text: "\u00d7", onclick: function () { self.setSidebar(false); },
        })),
      ])
    );
    s.appendChild(el("div", { class: CSS + "-field" }, [el("label", { for: CSS + "-search", text: t("searchLabel") }), search, pathTo, names, searchMsg]));
    this.rankBox = el("details", { class: CSS + "-field " + CSS + "-rank", id: CSS + "-rank" }, [el("summary", { text: t("rankings") })]);
    this.rankBox.open = OpenState.get("rank");
    this.rankBox.addEventListener("toggle", function () {
      OpenState.set("rank", self.rankBox.open);
      self.fillRankings();
    });
    s.appendChild(this.rankBox);
    s.appendChild(el("div", { class: CSS + "-field" }, [el("label", { for: CSS + "-studio", text: t("studio") }), select]));
    if (b.years.min != null) s.appendChild(this.yearField());
    s.appendChild(el("div", { class: CSS + "-field" }, [el("label", { for: CSS + "-tag", text: t("tags") }), tagBox, chips, tagMode]));
    this.strengthSlider = slider(CSS + "-min", t("minStrength"), 1, 10, f.minStrength, function (v) { f.minStrength = v; });
    s.appendChild(this.strengthSlider);
    s.appendChild(
      el("div", { class: CSS + "-field" }, [
        el("span", { class: CSS + "-label", text: t("countBy") }),
        el("div", { class: CSS + "-sub" }, [
          radio(CSS + "-countby", CSS + "-count-scenes", t("countScenes"), f.countBy === "scenes", function () { f.countBy = "scenes"; storeCountBy("scenes", self.history); self.draw(); }),
          radio(CSS + "-countby", CSS + "-count-productions", t("countProductions"), f.countBy === "productions", function () { f.countBy = "productions"; storeCountBy("productions", self.history); self.draw(); }),
        ]),
      ])
    );
    s.appendChild(slider(CSS + "-max", t("maxCast"), 2, 40, f.maxCast, function (v) { f.maxCast = v; }));
    s.appendChild(
      el("div", { class: CSS + "-field" }, [
        checkbox(CSS + "-fav", t("favorites"), f.favOn, function (v) { f.favOn = v; syncFavModes(); }),
        favModes,
      ])
    );
    syncFavModes();
    // -- ratings and activity; filters without any data are disabled with a hint
    var ratedScenes = b.scenes.filter(function (sc) { return sc.rating != null; }).length;
    var watched = b.scenes.filter(function (sc) { return sc.plays > 0; }).length;
    var withOrgasm = b.scenes.filter(function (sc) { return sc.orgasmCount > 0; }).length;
    var ratedPerformers = Object.keys(b.performers).filter(function (id) { return b.performers[id].rating100 != null; }).length;
    function starSelect(id, value, set, disabled) {
      var sel = el("select", { class: "form-control form-control-sm " + CSS + "-stars", id: id });
      [0, 1, 2, 3, 4, 5].forEach(function (n) {
        sel.appendChild(el("option", { value: n, text: n ? t("starsAtLeast", { count: n }) : t("starsAny") }));
      });
      sel.value = String(value);
      sel.disabled = !!disabled;
      sel.addEventListener("change", function () {
        set(Number(sel.value));
        self.draw();
      });
      return sel;
    }
    function disable(node, hint) {
      if (!hint) return node;
      node.querySelectorAll("input,select").forEach(function (i) {
        i.disabled = true;
      });
      node.classList.add(CSS + "-disabled");
      node.appendChild(el("div", { class: CSS + "-hint", text: hint }));
      return node;
    }
    var perfPartners = checkbox(CSS + "-perfstars-partners", t("plusPartners"), f.perfStarsPartners, function (v) { f.perfStarsPartners = v; });
    function syncPerfPartners() {
      perfPartners.querySelector("input").disabled = !f.perfStars || !ratedPerformers;
    }
    var activity = el("fieldset", { class: CSS + "-field" }, [el("legend", { text: t("ratingsActivity") })]);
    activity.appendChild(
      disable(el("div", { class: CSS + "-row" }, [
        el("label", { for: CSS + "-scenestars", text: t("sceneStars") }),
        starSelect(CSS + "-scenestars", f.sceneStars, function (v) { f.sceneStars = v; }),
      ]), ratedScenes ? null : t("noRatings"))
    );
    activity.appendChild(disable(el("div", null, [checkbox(CSS + "-watched", t("watchedOnly"), f.watchedOnly, function (v) { f.watchedOnly = v; })]), watched ? null : t("noPlays")));
    activity.appendChild(disable(el("div", null, [checkbox(CSS + "-orgasm-only", t("orgasmOnly"), f.orgasmOnly, function (v) { f.orgasmOnly = v; })]), withOrgasm ? null : t("noOrgasmCounts")));
    activity.appendChild(
      disable(el("div", null, [
        el("div", { class: CSS + "-row" }, [
          el("label", { for: CSS + "-perfstars", text: t("performerStars") }),
          starSelect(CSS + "-perfstars", f.perfStars, function (v) { f.perfStars = v; syncPerfPartners(); }),
        ]),
        el("div", { class: CSS + "-sub" }, [perfPartners]),
      ]), ratedPerformers ? null : t("noRatings"))
    );
    syncPerfPartners();
    // performer orgasm count: Stash's performer.o_counter (sum over the performer's scenes and images);
    // null while it is still loading (see loadOrgasms), then the controls are updated (orgasmsArrived)
    var perfWithOrgasm = b.orgasmsLoaded ? Object.keys(b.performers).filter(function (id) { return b.performers[id].o_counter > 0; }).length : null;
    var perfOrgasmPartners = checkbox(CSS + "-perf-orgasm-partners", t("plusPartners"), f.perfOrgasmPartners, function (v) { f.perfOrgasmPartners = v; });
    function syncPerfOrgasmPartners() {
      perfOrgasmPartners.querySelector("input").disabled = !f.perfOrgasm || perfWithOrgasm === 0;
    }
    var perfOrgasmBox = el("div", null, [
      checkbox(CSS + "-perf-orgasm", t("performerOrgasm"), f.perfOrgasm, function (v) { f.perfOrgasm = v; syncPerfOrgasmPartners(); }),
      el("div", { class: CSS + "-sub" }, [perfOrgasmPartners]),
    ]);
    activity.appendChild(disable(perfOrgasmBox, perfWithOrgasm === 0 ? t("noOrgasmCounts") : null));
    syncPerfOrgasmPartners();
    var sizeBox = el("div", null, [
      el("span", { class: CSS + "-label", text: t("sizeBy") }),
      el("div", { class: CSS + "-sub" }, [
        radio(CSS + "-sizeby", CSS + "-size-scenes", t("sizeScenes"), f.sizeBy === "scenes", function () { f.sizeBy = "scenes"; self.draw(); }),
        radio(CSS + "-sizeby", CSS + "-size-orgasms", t("sizeOrgasm"), f.sizeBy === "orgasms", function () { f.sizeBy = "orgasms"; self.draw(); }),
      ]),
    ]);
    activity.appendChild(disable(sizeBox, perfWithOrgasm === 0 ? t("noOrgasmCounts") : null));
    activity.appendChild(disable(el("div", null, [checkbox(CSS + "-edge-orgasm", t("edgeByOrgasm"), f.edgeByOrgasm, function (v) { f.edgeByOrgasm = v; })]), withOrgasm ? null : t("noOrgasmCounts")));
    var activityHint = el("div", { class: CSS + "-hint" });
    function activityText(perfOrgasm) {
      activityHint.textContent = t("activityCounts", { rated: ratedScenes, watched: watched, orgasm: withOrgasm, performers: ratedPerformers, perfOrgasm: perfOrgasm == null ? "\u2026" : perfOrgasm });
    }
    activityText(perfWithOrgasm);
    activity.appendChild(activityHint);
    // once the performers' orgasm counts are there: the count in the hint, and controls off if there are none
    this.orgasmsArrived = function () {
      perfWithOrgasm = Object.keys(b.performers).filter(function (id) { return b.performers[id].o_counter > 0; }).length;
      activityText(perfWithOrgasm);
      if (!perfWithOrgasm) [perfOrgasmBox, sizeBox].forEach(function (n) { disable(n, t("noOrgasmCounts")); });
      syncPerfOrgasmPartners();
    };
    s.appendChild(activity);
    s.appendChild(el("div", { class: CSS + "-field" }, [checkbox(CSS + "-isolated", t("showIsolated"), f.showIsolated, function (v) { f.showIsolated = v; })]));
    var legend = el("fieldset", { class: CSS + "-field " + CSS + "-legend" }, [el("legend", { text: t("gender") })]);
    b.genders.forEach(function (g) {
      var label = t("genderCount", { label: t("gender_" + g), count: genderCount[g] || 0 });
      legend.appendChild(checkbox(CSS + "-g-" + g, label, f.genders[g], function (v) { f.genders[g] = v; }, b.genderColors[g]));
    });
    s.appendChild(legend);
    s.appendChild(el("p", { class: CSS + "-hint", text: t("help") }));
  };

  NetworkView.prototype.colors = function () {
    return this.dark
      ? { text: "#e8ecef", textFaded: "rgba(232,236,239,0.25)", edge: "#9fb3c8", stroke: "#202b33" }
      : { text: "#1d2329", textFaded: "rgba(29,35,41,0.25)", edge: "#55697d", stroke: "#ffffff" };
  };

  // Nodes are drawn by drawNode (vis-network shape "custom"): vis-network keeps layout, hit testing and
  // culling; the look depends on the zoom level instead of being stored per node, so neither images
  // nor highlighting need a DataSet update (which made vis-network redraw and re-process every node).
  // Sizes and widths are passed ready-made (same linear scaling as vis-network's "value"/"scaling"): with
  // a "value", vis-network rescales every node and edge on each data change, which made adding edges in
  // batches cost the whole set each time.
  NetworkView.prototype.nodeValue = function (pid) {
    var p = this.base.performers[pid];
    return this.f.sizeBy === "orgasms" ? Math.sqrt(p.o_counter || 0) : Math.sqrt(this.graph.scenesPerPerformer[pid] || 0);
  };

  NetworkView.prototype.nodeData = function (pid) {
    return { id: pid, size: this.nodeRadius[pid], shape: "custom", ctxRenderer: this.renderNode };
  };

  // Level of detail, decided per node and frame from its size on screen:
  //   below IMG_MIN_PX radius: a dot in the gender colour; else the face crop (initials until it is there)
  //   with a border in the gender colour. With more than MAX_IMG_NODES such nodes on screen, only the
  //   MAX_IMG_NODES largest get an image, the others stay dots (frame.imgMin, Core.imageMinRadius).
  // Names follow the labelZoom setting (on-screen font size), hearts and rating badges appear from
  // EXTRAS_MIN_PX. Only nodes drawn with an image ask for one (see pumpImages).
  var IMG_MIN_PX = 8, MAX_IMG_NODES = 800, EXTRAS_MIN_PX = 5, INITIALS_MIN_PX = 14;
  var LABEL_MIN = 12, LABEL_MAX = 22, LABEL_MAX_PX = 26;

  NetworkView.prototype.makeRenderer = function () {
    var self = this;
    this.renderNode = function (o) {
      var r = o.style.size, sr = r * self.frame.scale;
      self.frame.radii.push(sr);
      return {
        drawNode: function () {
          self.drawNode(o.ctx, o.id, o.x, o.y, r, sr, o.state);
        },
        drawExternalLabel: function () {
          self.drawNodeExtras(o.ctx, o.id, o.x, o.y, r, sr, o.state);
        },
        nodeDimensions: { width: 2 * r, height: 2 * r },
      };
    };
  };

  NetworkView.prototype.layoutFinished = function () {
    this.timing.layout = Math.round(performance.now() - this.layoutStart);
    if (this.timing.firstReady == null) this.timing.firstReady = Math.round(performance.now() - this.timing.start);
    this.network.setOptions({ physics: { enabled: false } });
    this.showSummary();
    this.ready = true;
    this.root.setAttribute("data-ready", "1");
    var iv = this.initialView;
    this.initialView = null;
    if (!iv) return;
    var ids = iv.path || iv.edge || [iv.focus];
    var missing = ids.filter(function (id) {
      return !this.nodes.get(id);
    }, this)[0];
    if (missing != null) return this.setStatus(this.missingText(missing));
    if (iv.path) {
      if (!this.showPath(iv.path[0], iv.path[1])) this.showNoPath(iv.path[0], iv.path[1]);
    } else if (iv.edge) {
      var b = this.base.performers, id = pairKey(iv.edge[0], iv.edge[1]);
      if (this.edgeIndex[id]) this.focusEdge(id);
      else this.setStatus(this.t("noEdge", { from: b[iv.edge[0]].name, to: b[iv.edge[1]].name }));
    } else this.focusPerformer(iv.focus, true);
  };

  // Large networks are laid out in a Web Worker (Core.runLayout, the same force model as vis-network's
  // forceAtlas2Based): one step of vis-network takes ~37 ms for 4,581 nodes, so main-thread batches
  // could not stay under 50 ms, and the layout took 20 s; the worker needs ~13 ms per step and leaves the
  // page responsive. The worker is a blob: URL (Stash's CSP allows worker-src blob:). If it cannot be
  // started, vis-network lays out on the main thread in measured batches (LAYOUT_SLICE_MS).
  var LAYOUT_WORKER_MIN = 150, LAYOUT_SLICE_MS = 35, EDGE_BATCH = 2000;
  var LayoutWorker = {
    url: null,
    failed: false,
    create: function () {
      if (this.failed || !window.Worker || !window.Blob || !window.URL || !URL.createObjectURL) return null;
      try {
        if (!this.url) {
          var src =
            "var runLayout = " + Core.runLayout.toString() + ";\n" +
            "self.onmessage = function (e) {\n" +
            "  runLayout(e.data, function (x, y, iterations, done) {\n" +
            "    var px = new Float32Array(x), py = new Float32Array(y);\n" +
            "    self.postMessage({ x: px, y: py, iterations: iterations, done: done }, [px.buffer, py.buffer]);\n" +
            "  });\n" +
            "};\n";
          this.url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        }
        return new Worker(this.url);
      } catch (e) {
        this.failed = true;
        return null;
      }
    },
  };

  // The 3D layout (Core.runLayout3D) in its own worker, same message shape plus z.
  var LayoutWorker3D = {
    url: null,
    create: function () {
      if (LayoutWorker.failed || !window.Worker || !window.Blob || !window.URL || !URL.createObjectURL) return null;
      try {
        if (!this.url) {
          var src =
            "var runLayout3D = " + Core.runLayout3D.toString() + ";\n" +
            "self.onmessage = function (e) {\n" +
            "  runLayout3D(e.data, function (x, y, z, iterations, done) {\n" +
            "    var px = new Float32Array(x), py = new Float32Array(y), pz = new Float32Array(z);\n" +
            "    self.postMessage({ x: px, y: py, z: pz, iterations: iterations, done: done }, [px.buffer, py.buffer, pz.buffer]);\n" +
            "  });\n" +
            "};\n";
          this.url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        }
        return new Worker(this.url);
      } catch (e) {
        return null;
      }
    },
  };

  NetworkView.prototype.stopLayoutWorker = function () {
    if (this.layoutWorker) this.layoutWorker.terminate();
    this.layoutWorker = null;
  };

  NetworkView.prototype.layoutInWorker = function () {
    var self = this, ids = this.graph.nodes, index = {};
    var w = LayoutWorker.create();
    if (!w) return false;
    ids.forEach(function (id, i) {
      index[id] = i;
    });
    var edges = new Int32Array(this.graph.edges.length * 2);
    this.graph.edges.forEach(function (e, k) {
      edges[2 * k] = index[e.from];
      edges[2 * k + 1] = index[e.to];
    });
    var radius = new Float64Array(ids.length);
    ids.forEach(function (id, i) {
      radius[i] = self.nodeRadius[id];
    });
    this.layoutWorker = w;
    w.onmessage = function (e) {
      if (self.layoutWorker !== w || self.destroyed) return;
      var d = e.data;
      self.placeNodes(ids, d.x, d.y);
      if (!d.done) return;
      self.stopLayoutWorker();
      self.timing.layoutSteps = d.iterations;
      self.layoutFinished();
    };
    w.onerror = function (ev) {
      if (self.layoutWorker !== w) return;
      if (ev && ev.preventDefault) ev.preventDefault();
      self.stopLayoutWorker();
      LayoutWorker.failed = true;
      console.warn(PLUGIN_ID + ": layout worker unavailable, laying out on the page instead", ev && ev.message ? ev.message : "");
      self.network.setOptions({ physics: { enabled: true } });
      self.network.stabilize(Core.LAYOUT_PARAMS.iterations);
    };
    w.postMessage({ n: ids.length, edges: edges, radius: radius, params: Core.LAYOUT_PARAMS }, [edges.buffer, radius.buffer]);
    return true;
  };

  // Positions from the worker are written straight into vis-network's node objects (network.body.nodes,
  // vis-network 10.1.2 is bundled and pinned): a DataSet update of every node would cost more than the
  // layout step itself. One redraw, then a fit once the nodes are drawn.
  NetworkView.prototype.placeNodes = function (ids, x, y) {
    var bn = this.network.body.nodes;
    for (var i = 0; i < ids.length; i++) {
      var nd = bn[ids[i]];
      if (nd) {
        nd.x = x[i];
        nd.y = y[i];
      }
    }
    this.fitAfterDraw = true;
    this.network.redraw();
  };
  // ------------------------------------------------------------------ 3D view (beta, ?view=3d)
  // Drawn with three.js (vendor/three, loaded with import() when 3D is opened): every performer is one
  // instance of a camera-facing quad (face from an atlas texture, gender ring in the shader), all edges
  // are one LineSegments, so the whole network is two draw calls whatever its size. Graph3D answers the
  // calls NetworkView makes on vis-network (selectNodes, fit, focus, redraw, ...), so filters, panels,
  // rankings and paths work unchanged.
  var threePromise = null;
  function loadThree() {
    if (!threePromise)
      threePromise = import(VENDOR + "three/three.module.js").catch(function (e) {
        threePromise = null;
        throw e;
      });
    return threePromise;
  }
  function webglAvailable() {
    try {
      var c = document.createElement("canvas");
      return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
    } catch (e) {
      return false;
    }
  }
  var ATLAS_CELL = 128, ATLAS_MIN_CELL = 48, LAYOUT3D_MAX_STEPS_LARGE = 300;
  var NODE_SHAPES = { flat: 0, chip: 1, sphere: 2 }; // setting nodeShape3d

  function Graph3D(view, T) {
    var self = this;
    this.is3d = true;
    this.view = view;
    this.T = T;
    this.box = view.canvas;
    this.renderer = new T.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.className = CSS + "-gl";
    this.box.appendChild(this.renderer.domElement);
    this.scene = new T.Scene();
    this.scene.fog = new T.Fog(0x000000, 1, 2); // colour and range set in background() and render()
    this.camera = new T.PerspectiveCamera(55, 1, 1, 200000);
    this.target = new T.Vector3();
    this.orbit = { theta: 0.6, phi: 1.2, radius: 2000 };
    this.ids = [];
    this.index = {};
    this.selected = {};
    this.alpha = null;
    this.atlasDirty = true;
    this.handlers = {};
    this.background();
    this.resize();
    if (window.ResizeObserver) {
      this.observer = new ResizeObserver(function () {
        self.resize();
      });
      this.observer.observe(this.box);
    }
    this.bindControls();
    this.renderer.domElement.addEventListener("webglcontextlost", function (ev) {
      ev.preventDefault();
      view.lost3d();
    });
  }
  Graph3D.prototype.background = function () {
    var bg = getComputedStyle(this.view.root).getPropertyValue("--spn-bg").trim() || (this.view.dark ? "#1b252c" : "#f6f7f9");
    this.renderer.setClearColor(new this.T.Color(bg), 1);
    this.scene.fog.color.set(bg);
  };
  Graph3D.prototype.resize = function () {
    var w = this.box.clientWidth || 300, h = this.box.clientHeight || 300;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + "px";
    this.renderer.domElement.style.height = h + "px";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.redraw();
  };

  // Nodes and edges of the current graph; positions follow with setPositions.
  Graph3D.prototype.setGraph = function (ids, edges, radius, nodeColor, edgeColor) {
    var T = this.T, self = this, n = ids.length, m = edges.length;
    this.clearMeshes();
    this.ids = ids.slice();
    this.index = {};
    ids.forEach(function (id, i) {
      self.index[id] = i;
    });
    this.edges = edges;
    this.radius = radius;
    this.pos = new Float32Array(n * 3);
    // atlas: the largest nodes first get a cell
    var order = ids.map(function (id, i) { return i; }).sort(function (a, b) { return radius[b] - radius[a]; });
    this.grid = Core.atlasGrid(n, this.renderer.capabilities.maxTextureSize, ATLAS_CELL, ATLAS_MIN_CELL);
    this.cellOf = new Int32Array(n).fill(-1);
    order.slice(0, this.grid.count).forEach(function (i, c) {
      self.cellOf[i] = c;
    });
    this.atlas = document.createElement("canvas");
    this.atlas.width = this.atlas.height = this.grid.side;
    this.texture = new T.CanvasTexture(this.atlas);
    this.texture.colorSpace = T.SRGBColorSpace;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = T.LinearMipmapLinearFilter;

    var geo = new T.InstancedBufferGeometry().copy(new T.PlaneGeometry(2, 2));
    geo.instanceCount = n;
    var size = new Float32Array(n), ring = new Float32Array(n * 3), cell = new Float32Array(n * 2), alpha = new Float32Array(n).fill(1);
    var col = new T.Color();
    ids.forEach(function (id, i) {
      size[i] = radius[i];
      col.set(nodeColor(id));
      ring.set([col.r, col.g, col.b], i * 3);
      var c = self.cellOf[i];
      cell.set(c < 0 ? [-1, -1] : [(c % self.grid.per) / self.grid.per, 1 - (Math.floor(c / self.grid.per) + 1) / self.grid.per], i * 2);
    });
    this.attr = {
      offset: new T.InstancedBufferAttribute(this.pos, 3),
      size: new T.InstancedBufferAttribute(size, 1),
      ring: new T.InstancedBufferAttribute(ring, 3),
      cell: new T.InstancedBufferAttribute(cell, 2),
      alpha: new T.InstancedBufferAttribute(alpha, 1),
    };
    Object.keys(this.attr).forEach(function (k) {
      geo.setAttribute(k, self.attr[k]);
    });
    this.nodeMaterial = new T.ShaderMaterial({
      uniforms: {
        map: { value: this.texture }, per: { value: this.grid.per }, fill: { value: col.set(this.view.dark ? "#3a4853" : "#c9d1d8").clone() }, depthFade: { value: 0 },
        shape: { value: NODE_SHAPES[this.view.settings.nodeShape3d] || 0 },
      },
      transparent: true,
      depthWrite: true,
      vertexShader:
        "attribute vec3 offset; attribute float size; attribute vec3 ring; attribute vec2 cell; attribute float alpha;" +
        "uniform float depthFade; varying vec2 vUv; varying vec2 vCell; varying vec3 vRing; varying float vAlpha;" +
        "void main() { vUv = uv; vCell = cell; vRing = ring;" +
        "  vec4 mv = modelViewMatrix * vec4(offset, 1.0); mv.xy += position.xy * size;" +
        "  vAlpha = alpha * (depthFade > 0.0 ? clamp(1.35 - (-mv.z) / depthFade, 0.18, 1.0) : 1.0);" +
        "  gl_Position = projectionMatrix * mv; }",
      // shape 0 flat: face and gender ring; 1 chip: a coin, the face inside a bevelled rim; 2 sphere: a lit
      // ball, the face on its front. All three are drawn on the same flat quad (an impostor), so the cost
      // does not change.
      fragmentShader:
        "uniform sampler2D map; uniform float per; uniform vec3 fill; uniform float shape; varying vec2 vUv; varying vec2 vCell; varying vec3 vRing; varying float vAlpha;" +
        "const vec3 L = vec3(-0.42, 0.52, 0.74);" +
        "void main() { vec2 p = vUv * 2.0 - 1.0; float d = length(p); if (d > 1.0) discard;" +
        "  float inner = shape > 0.5 ? 0.78 : 0.84;" +
        "  vec2 fuv = shape > 0.5 ? 0.5 + 0.5 * p / inner : vUv;" +
        "  vec4 c = vCell.x < 0.0 ? vec4(fill, 1.0) : texture2D(map, vCell + clamp(fuv, 0.0, 1.0) / per);" +
        "  if (d > inner) c = vec4(vRing, 1.0);" +
        "  if (shape > 1.5) {" +
        "    vec3 n = vec3(p, sqrt(max(0.0, 1.0 - d * d))); float diff = 0.55 + 0.5 * max(dot(n, normalize(L)), 0.0);" +
        "    float spec = pow(max(dot(reflect(-normalize(L), n), vec3(0.0, 0.0, 1.0)), 0.0), 40.0) * smoothstep(0.45, 0.8, d);" +
        "    c.rgb = c.rgb * diff + vec3(0.4) * spec; c.rgb *= 0.8 + 0.2 * n.z;" +
        "  } else if (shape > 0.5) {" +
        "    float t = clamp((d - inner) / (1.0 - inner), 0.0, 1.0);" +
        "    if (d > inner) { vec3 n = normalize(vec3(p * (t - 0.5) * 2.2, 1.0)); c.rgb *= 0.7 + 0.55 * max(dot(n, normalize(L)), 0.0); }" +
        "    else c.rgb *= 0.86 + 0.14 * smoothstep(inner, inner - 0.12, d);" +
        "  }" +
        "  gl_FragColor = vec4(c.rgb, c.a * vAlpha); if (gl_FragColor.a < 0.02) discard; }",
    });
    this.points = new T.Mesh(geo, this.nodeMaterial);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1; // after the edges, so faces cover the lines that end in them
    this.scene.add(this.points);

    var lineGeo = new T.BufferGeometry();
    this.linePos = new Float32Array(m * 6);
    this.lineCol = new Float32Array(m * 8);
    // the more edges, the fainter each one, so a large network is not a white cloud (0.32 up to ~1,500
    // edges, 0.06 at about 40,000)
    this.edgeAlpha = Math.max(0.06, Math.min(0.32, 0.32 * Math.sqrt(1500 / Math.max(m, 1))));
    this.edgeBase = edges.map(function (e) {
      col.set(edgeColor(e));
      return [col.r, col.g, col.b];
    });
    lineGeo.setAttribute("position", new T.BufferAttribute(this.linePos, 3));
    lineGeo.setAttribute("color", new T.BufferAttribute(this.lineCol, 4));
    this.lines = new T.LineSegments(lineGeo, new T.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 0;
    this.scene.add(this.lines);
    this.emphasize(null);
    this.atlasDirty = true;
    this.redraw();
  };
  Graph3D.prototype.clearMeshes = function () {
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
      this.nodeMaterial.dispose();
      this.texture.dispose();
      this.points = null;
    }
    if (this.lines) {
      this.scene.remove(this.lines);
      this.lines.geometry.dispose();
      this.lines.material.dispose();
      this.lines = null;
    }
  };
  Graph3D.prototype.setPositions = function (x, y, z) {
    var n = this.ids.length, P = this.pos, L = this.linePos, idx = this.index;
    for (var i = 0; i < n; i++) {
      P[3 * i] = x[i];
      P[3 * i + 1] = y[i];
      P[3 * i + 2] = z[i];
    }
    this.edges.forEach(function (e, k) {
      var a = idx[e.from], b = idx[e.to];
      L.set([P[3 * a], P[3 * a + 1], P[3 * a + 2], P[3 * b], P[3 * b + 1], P[3 * b + 2]], 6 * k);
    });
    this.attr.offset.needsUpdate = true;
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.computeBoundingSphere();
    this.redraw();
  };

  // Faces into the atlas: the node's picture (crop, image or initials, NetworkView.pics) per cell. All
  // cells after setGraph, afterwards only those of performers whose picture changed (picChanged).
  Graph3D.prototype.picChanged = function (id) {
    if (this.index[id] == null) return;
    (this.dirtyPics = this.dirtyPics || {})[id] = true;
  };
  Graph3D.prototype.paintAtlas = function () {
    if (!this.atlas || (!this.atlasDirty && !this.dirtyPics)) return;
    var ctx = this.atlas.getContext("2d"), g = this.grid, pics = this.view.pics, self = this;
    var only = this.atlasDirty ? null : this.dirtyPics;
    this.atlasDirty = false;
    this.dirtyPics = null;
    if (!only) ctx.clearRect(0, 0, g.side, g.side);
    (only ? Object.keys(only) : this.ids).forEach(function (id) {
      var i = self.index[id], c = i == null ? -1 : self.cellOf[i];
      if (c < 0) return;
      var x = (c % g.per) * g.cell, y = Math.floor(c / g.per) * g.cell, pic = pics[id];
      if (!pic) pic = self.view.initialsPic(id);
      if (only) ctx.clearRect(x, y, g.cell, g.cell);
      try {
        ctx.drawImage(pic, x, y, g.cell, g.cell);
      } catch (e) {
        /* picture not decodable: the cell stays empty and the node shows the fill colour */
      }
    });
    this.texture.needsUpdate = true;
  };

  // Emphasis like the 2D view: nodes outside keep.nodes faded, accented edges in keep.color.
  Graph3D.prototype.emphasize = function (keep) {
    if (!this.attr) return;
    var self3 = this, a = this.attr.alpha.array, C = this.lineCol, base = this.edgeBase, ids = this.ids, T = this.T;
    var accent = keep && new T.Color(keep.color);
    for (var i = 0; i < ids.length; i++) a[i] = !keep || keep.nodes[ids[i]] ? 1 : 0.12;
    this.edges.forEach(function (e, k) {
      var id = e.from + "-" + e.to, rgb = base[k], al = keep && keep.edges[id] ? 0.45 : self3.edgeAlpha;
      if (keep) {
        if (keep.accent[id]) {
          rgb = [accent.r, accent.g, accent.b];
          al = 0.95;
        } else if (!keep.edges[id]) al = 0.03;
      }
      C.set([rgb[0], rgb[1], rgb[2], al, rgb[0], rgb[1], rgb[2], al], 8 * k);
    });
    this.attr.alpha.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
    this.redraw();
  };

  // -- the calls NetworkView makes on vis-network
  Graph3D.prototype.selectNodes = function (ids) {
    var self = this;
    this.selected = {};
    (ids || []).forEach(function (id) {
      self.selected[id] = true;
    });
    this.redraw();
  };
  Graph3D.prototype.selectEdges = function () {};
  Graph3D.prototype.unselectAll = function () {
    this.selected = {};
    this.redraw();
  };
  Graph3D.prototype.setOptions = function () {};
  Graph3D.prototype.stabilize = function () {};
  Graph3D.prototype.on = function () {};
  Graph3D.prototype.getScale = function () {
    return 1;
  };
  Graph3D.prototype.redraw = function () {
    var self = this;
    if (this.frame || this.destroyed) return;
    this.frame = requestAnimationFrame(function () {
      self.frame = null;
      self.render();
    });
  };
  Graph3D.prototype.render = function () {
    if (this.destroyed) return;
    this.paintAtlas();
    var o = this.orbit, sp = Math.sin(o.phi);
    this.camera.position.set(this.target.x + o.radius * sp * Math.sin(o.theta), this.target.y + o.radius * Math.cos(o.phi), this.target.z + o.radius * sp * Math.cos(o.theta));
    this.camera.lookAt(this.target);
    // depth: lines fade into the background by the scene fog, nodes by depthFade in their shader
    this.scene.fog.near = o.radius * 0.7;
    this.scene.fog.far = o.radius * 2.4;
    if (this.nodeMaterial) this.nodeMaterial.uniforms.depthFade.value = o.radius * 1.3;
    this.renderer.render(this.scene, this.camera);
    if (this.animation) this.step();
  };
  // fit: the bounding sphere of the given nodes (all if none) fills the view
  Graph3D.prototype.fit = function (opts) {
    var ids = opts && opts.nodes && opts.nodes.length ? opts.nodes : this.ids, P = this.pos, self = this;
    if (!ids.length) return;
    var cx = 0, cy = 0, cz = 0, r = 0, k = 0;
    ids.forEach(function (id) {
      var i = self.index[id];
      if (i == null) return;
      cx += P[3 * i];
      cy += P[3 * i + 1];
      cz += P[3 * i + 2];
      k++;
    });
    if (!k) return;
    cx /= k;
    cy /= k;
    cz /= k;
    ids.forEach(function (id) {
      var i = self.index[id];
      if (i == null) return;
      r = Math.max(r, Math.hypot(P[3 * i] - cx, P[3 * i + 1] - cy, P[3 * i + 2] - cz) + (self.radius[i] || 0));
    });
    var dist = Math.max(200, r / Math.sin((this.camera.fov * Math.PI) / 360) * 1.05);
    this.flyTo(cx, cy, cz, dist, opts && opts.animation);
  };
  Graph3D.prototype.focus = function (id, opts) {
    var i = this.index[id];
    if (i == null) return;
    var P = this.pos;
    this.flyTo(P[3 * i], P[3 * i + 1], P[3 * i + 2], Math.max(250, (this.radius[i] || 20) * 14), opts && opts.animation);
  };
  Graph3D.prototype.flyTo = function (x, y, z, dist, animate) {
    var from = { x: this.target.x, y: this.target.y, z: this.target.z, r: this.orbit.radius };
    if (!animate) {
      this.target.set(x, y, z);
      this.orbit.radius = dist;
      this.animation = null;
      return this.redraw();
    }
    this.animation = { from: from, to: { x: x, y: y, z: z, r: dist }, start: performance.now(), ms: 600 };
    this.redraw();
  };
  Graph3D.prototype.step = function () {
    var a = this.animation, t = Math.min(1, (performance.now() - a.start) / a.ms), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    this.target.set(a.from.x + (a.to.x - a.from.x) * e, a.from.y + (a.to.y - a.from.y) * e, a.from.z + (a.to.z - a.from.z) * e);
    this.orbit.radius = a.from.r + (a.to.r - a.from.r) * e;
    if (t >= 1) this.animation = null;
    this.redraw();
  };

  // nearest node under a point of the canvas (CSS px), within its drawn radius plus a few px
  Graph3D.prototype.pick = function (sx, sy) {
    var P = this.pos, v = new this.T.Vector3(), best = null, bd = Infinity, w = this.width, h = this.height;
    var a = this.attr && this.attr.alpha.array;
    var pxPerUnit = h / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    for (var i = 0; i < this.ids.length; i++) {
      if (a && a[i] < 0.5) continue; // faded nodes are not hit while something is emphasized
      v.set(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
      var dist = v.distanceTo(this.camera.position);
      v.project(this.camera);
      if (v.z > 1 || v.z < -1) continue;
      var dx = (v.x + 1) * 0.5 * w - sx, dy = (1 - v.y) * 0.5 * h - sy, d = Math.sqrt(dx * dx + dy * dy);
      var rr = Math.max(6, (this.radius[i] * pxPerUnit) / dist) + 3;
      if (d <= rr && dist < bd) {
        bd = dist;
        best = this.ids[i];
      }
    }
    return best;
  };

  // edge under a point: the visible edge whose drawn line passes closest, within EDGE_PICK_PX
  // above EDGE_HOVER_MAX edges an edge is found on click only (one search over 26,841 edges takes ~19 ms
  // with software rendering, too much for every pointer move)
  var EDGE_PICK_PX = 6, EDGE_HOVER_MAX = 8000;
  Graph3D.prototype.pickEdge = function (sx, sy) {
    var n = this.ids.length, P = this.pos, v = new this.T.Vector3(), w = this.width, h = this.height;
    var X = (this.screenX = this.screenX && this.screenX.length === n ? this.screenX : new Float32Array(n));
    var Y = (this.screenY = this.screenY && this.screenY.length === n ? this.screenY : new Float32Array(n));
    var ok = (this.screenOk = this.screenOk && this.screenOk.length === n ? this.screenOk : new Uint8Array(n));
    for (var i = 0; i < n; i++) {
      v.set(P[3 * i], P[3 * i + 1], P[3 * i + 2]).project(this.camera);
      ok[i] = v.z < 1 && v.z > -1 ? 1 : 0;
      X[i] = (v.x + 1) * 0.5 * w;
      Y[i] = (1 - v.y) * 0.5 * h;
    }
    var best = null, bd = EDGE_PICK_PX, idx = this.index, C = this.lineCol;
    for (var k = 0; k < this.edges.length; k++) {
      if (C[8 * k + 3] < 0.05) continue; // faded out by the current emphasis
      var e = this.edges[k], a = idx[e.from], b = idx[e.to];
      if (!ok[a] || !ok[b]) continue;
      var dx = X[b] - X[a], dy = Y[b] - Y[a], len2 = dx * dx + dy * dy;
      var t = len2 ? Math.max(0, Math.min(1, ((sx - X[a]) * dx + (sy - Y[a]) * dy) / len2)) : 0;
      var ex = X[a] + t * dx - sx, ey = Y[a] + t * dy - sy, d = Math.sqrt(ex * ex + ey * ey);
      if (d < bd) {
        bd = d;
        best = e.from + "-" + e.to;
      }
    }
    return best;
  };

  // Mouse: drag rotates, right or shift drag pans, wheel zooms; touch: one finger rotates, two pinch and
  // pan; a short tap or click without movement picks.
  Graph3D.prototype.bindControls = function () {
    var self = this, el3 = this.renderer.domElement, pointers = {}, start = null, moved = 0, lastPinch = null, view = this.view;
    el3.style.touchAction = "none";
    function local(ev) {
      var r = el3.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }
    function pan(dx, dy) {
      var o = self.orbit, k = (o.radius * Math.tan((self.camera.fov * Math.PI) / 360) * 2) / self.height;
      var right = new self.T.Vector3().setFromMatrixColumn(self.camera.matrix, 0), up = new self.T.Vector3().setFromMatrixColumn(self.camera.matrix, 1);
      self.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    }
    el3.addEventListener("contextmenu", function (ev) {
      ev.preventDefault();
    });
    el3.addEventListener("pointerdown", function (ev) {
      el3.setPointerCapture(ev.pointerId);
      pointers[ev.pointerId] = local(ev);
      start = { p: local(ev), button: ev.button, shift: ev.shiftKey, time: performance.now(), ctrl: ev.ctrlKey || ev.metaKey };
      moved = 0;
      self.animation = null;
      view.hideCard();
      view.hover3dKey = null; // hovering the same node again after a drag shows its card again
    });
    el3.addEventListener("pointermove", function (ev) {
      var p = local(ev), prev = pointers[ev.pointerId];
      if (!prev) {
        // hover without a button: card for the performer under the pointer
        if (ev.pointerType === "mouse") {
          self.hoverAt = p;
          if (!self.hoverFrame)
            self.hoverFrame = requestAnimationFrame(function () {
              self.hoverFrame = null;
              var q = self.hoverAt, hit = self.pick(q.x, q.y);
              view.hover3d(hit, q, hit == null && self.edges.length <= EDGE_HOVER_MAX ? self.pickEdge(q.x, q.y) : null);
            });
        }
        return;
      }
      var dx = p.x - prev.x, dy = p.y - prev.y;
      pointers[ev.pointerId] = p;
      moved += Math.abs(dx) + Math.abs(dy);
      var ids = Object.keys(pointers);
      if (ids.length === 2) {
        var a = pointers[ids[0]], b = pointers[ids[1]], dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (lastPinch) self.orbit.radius = Math.max(50, self.orbit.radius * (lastPinch / Math.max(dist, 1)));
        lastPinch = dist;
        pan(dx / 2, dy / 2);
      } else if (start && (start.button === 2 || start.shift)) pan(dx, dy);
      else {
        self.orbit.theta -= dx * 0.006;
        self.orbit.phi = Math.max(0.05, Math.min(Math.PI - 0.05, self.orbit.phi - dy * 0.006));
      }
      self.redraw();
    });
    function up(ev) {
      var wasTap = start && moved < 6 && performance.now() - start.time < 600 && Object.keys(pointers).length === 1;
      delete pointers[ev.pointerId];
      lastPinch = null;
      if (wasTap) {
        var p = local(ev);
        var pid = self.pick(p.x, p.y);
        view.click3d(pid, start.ctrl, pid == null ? self.pickEdge(p.x, p.y) : null, ev.pointerType !== "mouse" ? p : null);
      }
      if (!Object.keys(pointers).length) start = null;
    }
    el3.addEventListener("pointerup", up);
    el3.addEventListener("pointercancel", function (ev) {
      delete pointers[ev.pointerId];
      lastPinch = null;
      start = null;
    });
    el3.addEventListener("pointerleave", function (ev) {
      if (ev.pointerType === "mouse" && !pointers[ev.pointerId]) view.hover3d(null);
    });
    el3.addEventListener("wheel", function (ev) {
      ev.preventDefault();
      self.animation = null;
      self.orbit.radius = Math.max(50, self.orbit.radius * Math.exp(ev.deltaY * 0.0012));
      view.hideCard();
      self.redraw();
    }, { passive: false });
    el3.addEventListener("dblclick", function (ev) {
      var p = local(ev), id = self.pick(p.x, p.y);
      if (id != null) view.history.push("/performers/" + id);
    });
  };
  Graph3D.prototype.destroy = function () {
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.hoverFrame) cancelAnimationFrame(this.hoverFrame);
    if (this.observer) this.observer.disconnect();
    this.clearMeshes();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
  };


  NetworkView.prototype.drawNode = function (ctx, id, x, y, r, sr, state) {
    var p = this.base.performers[id];
    var color = this.base.genderColors[genderOf(this.base, p)];
    var alpha = this.nodeAlpha[id] == null ? 1 : this.nodeAlpha[id];
    var mode = this.drawMode;
    var withImage = mode === "images" || (mode !== "dots" && sr >= this.frame.imgMin);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    var pic = withImage ? this.pics[id] : null;
    if (withImage && this.imageItems[id]) this.frame.wanted[id] = sr;
    if (pic) {
      ctx.save();
      ctx.clip();
      ctx.drawImage(pic, x - r, y - r, 2 * r, 2 * r);
      ctx.restore();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
      if (withImage) {
        ctx.fillStyle = "rgba(0,0,0,0.18)";
        ctx.fill();
        if (sr >= INITIALS_MIN_PX) {
          ctx.fillStyle = "#ffffff";
          ctx.font = "600 " + Math.round(r * 0.8) + "px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(initials(p.name), x, y + r * 0.05);
        }
      }
    }
    if (withImage || state.selected) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.lineWidth = state.selected ? 5 : 3;
      ctx.strokeStyle = !withImage ? this.colors().text : color;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  // drawn after all nodes (vis-network's external labels), so names, hearts and badges stay on top
  NetworkView.prototype.drawNodeExtras = function (ctx, id, x, y, r, sr, state) {
    var p = this.base.performers[id], scale = this.frame.scale;
    var alpha = this.nodeAlpha[id] == null ? 1 : this.nodeAlpha[id];
    if (sr >= EXTRAS_MIN_PX && this.drawMode !== "dots") {
      if (p.favorite) drawHeart(ctx, x + r * 0.72, y - r * 0.72, Math.max(9, r * 0.6), alpha);
      if (p.rating100 != null) drawBadge(ctx, x - r * 0.72, y + r * 0.72, this.i18n.n(Math.round(p.rating100 / 2) / 10), Math.max(8, r * 0.42), alpha);
    }
    var f = this.nodeRadius[id] == null ? 0.5 : (this.nodeRadius[id] - NODE_MIN) / (NODE_MAX - NODE_MIN);
    var size = LABEL_MIN + f * (LABEL_MAX - LABEL_MIN);
    var zoom = this.settings.labelZoom;
    if (zoom && size * scale < zoom) return;
    if (size * scale > LABEL_MAX_PX) size = LABEL_MAX_PX / scale;
    var c = this.colors(), on = alpha === 1;
    ctx.save();
    ctx.font = (state.selected || state.hover ? "bold " : "") + Math.round(size * 10) / 10 + "px system-ui, sans-serif"; // as vis-network did
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    var ty = y + r + 4 + size * 0.42;
    if (on) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = c.stroke;
      ctx.lineJoin = "round";
      ctx.strokeText(p.name, x, ty);
    }
    ctx.fillStyle = on ? c.text : c.textFaded;
    ctx.fillText(p.name, x, ty);
    ctx.restore();
  };

  // debugging and measuring (window.performerNetwork.setDrawMode): "dots", "images" or null = by zoom
  NetworkView.prototype.setDrawMode = function (mode) {
    this.drawMode = mode || null;
    if (this.network) this.network.redraw();
  };

  // Optional edge colour by the summed orgasm count of the shared scenes (log scale, 0 = normal colour).
  var ORGASM_COLOR = [255, 61, 127];
  function hexRgb(hx) {
    var v = parseInt(hx.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  NetworkView.prototype.colorEdgesByOrgasm = function () {
    var c = this.colors(), maxSum = 0, on = this.f.edgeByOrgasm;
    this.graph.edges.forEach(function (e) {
      maxSum = Math.max(maxSum, e.orgasmSum);
    });
    var from = hexRgb(c.edge);
    this.graph.edges.forEach(function (e) {
      if (!on || !e.orgasmSum || !maxSum) return (e.baseColor = null);
      var k = 0.35 + 0.65 * (Math.log(1 + e.orgasmSum) / Math.log(1 + maxSum));
      var rgb = from.map(function (x, i) { return Math.round(x + (ORGASM_COLOR[i] - x) * k); });
      e.baseColor = "#" + rgb.map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    });
  };

  NetworkView.prototype.edgeData = function (e) {
    var c = this.colors();
    var n = e.weight;
    var b = this.base.performers;
    return {
      id: e.from + "-" + e.to,
      from: e.from,
      to: e.to,
      width: scaleLinear(n, this.weightRange, EDGE_MIN, EDGE_MAX),
      title: b[e.from].name + " & " + b[e.to].name + ": " + this.sharedSummary(e) + (this.f.edgeByOrgasm ? " · " + this.t("orgasmSum", { count: e.orgasmSum }) : ""),
      color: { color: e.baseColor || c.edge, highlight: HIGHLIGHT, hover: HIGHLIGHT, opacity: 0.55 },
    };
  };

  NetworkView.prototype.draw = function () {
    var self = this, vis = window.vis;
    // node size by orgasm count and the performer orgasm filter need the counts: load them first
    if ((this.f.sizeBy === "orgasms" || this.f.perfOrgasm) && !this.base.orgasmsLoaded) {
      this.setStatus(this.t("loadingOrgasms"));
      this.loadOrgasms().then(function () {
        if (!self.destroyed) self.draw();
      });
      return;
    }
    this.layoutStart = performance.now();
    this.ready = false;
    this.root.removeAttribute("data-ready");
    this.fullGraph = computeGraph(this.base, this.f);
    this.graph = this.showAll ? this.fullGraph : Core.limitGraph(this.fullGraph, this.base, this.settings.startLimit);
    this.updateLimitBox();
    this.edgeIndex = {};
    this.graph.edges.forEach(function (e) {
      self.edgeIndex[e.from + "-" + e.to] = e;
    });
    this.mode = null;
    this.pathStart = null;
    this.nodeAlpha = {};
    this.edgeLook = {};
    this.closeDetail();
    this.hideCard();

    var strongest = this.graph.edges.reduce(function (m, e) { return Math.max(m, e.weight); }, 1);
    var r = this.strengthSlider && this.strengthSlider.querySelector("input");
    if (r) r.max = Math.max(10, strongest);

    this.colorEdgesByOrgasm();
    this.root.classList.toggle(CSS + "-3d", !!this.view3d); // panels get their 3D look (CSS) only here
    if (this.view3d) return this.draw3d();
    if (!this.renderNode) this.makeRenderer();
    this.stopLayoutWorker();
    var P = Core.LAYOUT_PARAMS;
    var inWorker = !LayoutWorker.failed && this.layoutMode !== "page" && (this.layoutMode === "worker" || this.graph.nodes.length >= LAYOUT_WORKER_MIN);
    this.nodeRadius = this.radii(this.graph.nodes);
    this.weightRange = range(this.graph.edges.map(function (e) { return e.weight; }));
    this.nodes = new vis.DataSet(this.graph.nodes.map(function (pid) { return self.nodeData(pid); }));
    // vis-network builds an object with a label module per edge: 26,841 edges took one 1.5 s task. Large
    // networks laid out in the worker get their edges in batches of EDGE_BATCH, one task each, meanwhile.
    var allEdges = this.graph.edges, first = inWorker && allEdges.length > 2 * EDGE_BATCH ? EDGE_BATCH : allEdges.length;
    this.edges = new vis.DataSet(allEdges.slice(0, first).map(function (e) { return self.edgeData(e); }));
    var drawId = (this.drawId = (this.drawId || 0) + 1), edgeSet = this.edges;
    (function addEdges(from) {
      if (from >= allEdges.length) return;
      setTimeout(function () {
        if (self.destroyed || self.drawId !== drawId) return;
        edgeSet.add(allEdges.slice(from, from + EDGE_BATCH).map(function (e) { return self.edgeData(e); }));
        addEdges(from + EDGE_BATCH);
      }, 0);
    })(first);

    this.stabLast = null;
    var options = {
      autoResize: true,
      nodes: {
        shape: "custom",
        ctxRenderer: this.renderNode,
      },
      edges: { smooth: false, selectionWidth: 2, hoverWidth: 1.5 },
      physics: {
        enabled: !inWorker,
        solver: "forceAtlas2Based",
        forceAtlas2Based: {
          gravitationalConstant: P.gravitationalConstant, centralGravity: P.centralGravity, springLength: P.springLength,
          springConstant: P.springConstant, avoidOverlap: P.avoidOverlap,
        },
        // the first batch is small; later ones follow the measured time per step (stabilizationProgress)
        stabilization: { enabled: true, iterations: P.iterations, updateInterval: 5, fit: true },
      },
      interaction: { hover: true, tooltipDelay: 250, multiselect: false, keyboard: false, selectConnectedEdges: false },
      layout: { improvedLayout: this.graph.nodes.length < 150, randomSeed: 7 },
    };

    if (!this.network) {
      this.network = new vis.Network(this.canvas, { nodes: this.nodes, edges: this.edges }, options);
      this.bindEvents();
    } else {
      this.network.setOptions(options);
      this.network.setData({ nodes: this.nodes, edges: this.edges });
    }
    // nothing to lay out (every performer filtered out): vis-network never reports a finished layout
    if (!this.graph.nodes.length)
      setTimeout(function () {
        if (!self.destroyed && self.drawId === drawId) self.layoutFinished();
      }, 0);
    else if (inWorker && !this.layoutInWorker()) {
      this.network.setOptions({ physics: { enabled: true } });
      this.network.stabilize(P.iterations);
    }
    this.setStatus(
      [this.t("statusPeople", { count: this.graph.nodes.length }), this.t("statusEdges", { count: this.graph.edges.length }), this.t("layouting")].join(" · ")
    );    this.fillRankings();
  };

  // Node radius as vis-network derives it from "value" with the default linear scaling (used for the hearts).
  // vis-network's default scaling: linear between the smallest and the largest value, 0.5 if all are equal
  var EDGE_MIN = 1, EDGE_MAX = 14;
  function range(values) {
    var lo = Infinity, hi = -Infinity;
    values.forEach(function (v) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    });
    return { lo: lo, hi: hi };
  }
  function scaleLinear(v, r, min, max) {
    var f = r.hi === r.lo ? 0.5 : (v - r.lo) / (r.hi - r.lo);
    return min + f * (max - min);
  }

  NetworkView.prototype.radii = function (ids) {
    var self = this, values = {}, out = {};
    ids.forEach(function (id) {
      values[id] = self.nodeValue(id);
    });
    var r = range(ids.map(function (id) { return values[id]; }));
    ids.forEach(function (id) {
      out[id] = scaleLinear(values[id], r, NODE_MIN, NODE_MAX);
    });
    return out;
  };

  NetworkView.prototype.showSummary = function () {
    var g = this.graph, tm = this.timing, t = this.t.bind(this);
    var parts = [
      t("statusPeople", { count: g.nodes.length }) + (g.limited ? " (" + t("statusLimited", { shown: g.limited.shown, total: g.limited.total }) + ")" : ""),
      t("statusEdges", { count: g.edges.length }),
      t("statusScenes", { scenes: g.sceneCount, units: g.unitCount }),
    ];
    if (!g.nodes.length) parts.unshift(t("emptyNetwork"));
    if (g.tooBig) parts.push(t(g.countBy === "productions" ? "statusTooBig" : "statusTooBigScenes", { count: g.tooBig, max: this.f.maxCast }));
    parts.push(t(g.countBy === "productions" ? "statusCountProductions" : "statusCountScenes"));
    parts.push(t("statusTiming", { data: tm.data, layout: tm.layout }));
    this.setStatus(parts.join(" · "));
  };

  NetworkView.prototype.bindEvents = function () {
    var self = this;
    this.network.on("stabilizationIterationsDone", function () {
      self.layoutFinished();
    });
    // vis-network runs its stabilization in batches of updateInterval steps per task; the batch size
    // follows the measured time per step, so that no batch takes much longer than LAYOUT_SLICE_MS
    this.network.on("stabilizationProgress", function (p) {
      var now = performance.now(), last = self.stabLast;
      self.stabLast = { t: now, it: p.iterations };
      var st = self.network.physics && self.network.physics.options && self.network.physics.options.stabilization;
      if (!st || !last || p.iterations <= last.it) return;
      var perStep = (now - last.t) / (p.iterations - last.it);
      st.updateInterval = Math.max(1, Math.min(200, Math.floor(LAYOUT_SLICE_MS / Math.max(perStep, 0.05))));
    });
    // Hover emphasis is debounced (HOVER_DELAY_MS): sweeping the pointer across many nodes no longer
    // restyles the whole network for every node passed; the card follows immediately.
    this.network.on("hoverNode", function (p) {
      clearTimeout(self.hoverTimer);
      self.hoverTimer = setTimeout(function () {
        if (!self.mode && !self.destroyed) self.emphasize(self.neighbourhood(p.node));
      }, HOVER_DELAY_MS);
      self.showCard(p.node, p.pointer && p.pointer.DOM);
    });
    this.network.on("blurNode", function () {
      clearTimeout(self.hoverTimer);
      self.hoverTimer = setTimeout(function () {
        if (!self.mode && !self.destroyed) self.emphasize(null);
      }, HOVER_DELAY_MS);
      self.hideCard();
    });
    ["dragStart", "zoom"].forEach(function (ev) {
      self.network.on(ev, function () {
        self.hideCard();
      });
    });
    this.network.on("click", function (p) {
      var ev = p.event && p.event.srcEvent;
      var multi = !!(ev && (ev.ctrlKey || ev.metaKey));
      if (p.nodes.length) {
        var pid = p.nodes[0];
        if (multi) {
          if (self.pathStart && self.pathStart !== pid) {
            var from = self.pathStart;
            if (!self.showPath(from, pid)) self.showNoPath(from, pid);
          } else {
            self.focusPerformer(pid, false);
            self.pathStart = pid;
            self.showNodeDetail(pid);
          }
        } else if (self.pathFrom && self.pathFrom !== pid) {
          self.pathTo(pid);
        } else if (self.mode && self.mode.kind === "focus" && self.mode.pid === pid) {
          self.clearMode();
        } else {
          self.focusPerformer(pid, false);
        }
      } else if (p.edges.length) {
        self.clearMode();
        self.showEdgeDetail(p.edges[0]);
      } else {
        self.clearMode();
      }
    });
    // native dblclick (more reliable than vis-network's doubletap recognition)
    this.canvas.addEventListener("dblclick", function (ev) {
      var r = self.canvas.getBoundingClientRect();
      var pid = self.network.getNodeAt({ x: ev.clientX - r.left, y: ev.clientY - r.top });
      if (pid != null) self.history.push("/performers/" + pid);
    });
    // per frame: the zoom level for the renderer, and which nodes were drawn large enough for an image;
    // after the worker placed the nodes, fit once they have been drawn (fit uses their drawn boxes)
    this.network.on("beforeDrawing", function () {
      var fr = self.frame;
      fr.scale = self.network.getScale();
      fr.radii = [];
      fr.wanted = {};
    });
    this.network.on("afterDrawing", function () {
      var fr = self.frame;
      self.wanted = fr.wanted;
      // the image threshold for the next frame; if it fell, the nodes that now qualify are drawn and
      // asked for in one more frame
      var imgMin = Core.imageMinRadius(fr.radii, MAX_IMG_NODES, IMG_MIN_PX);
      if (imgMin < fr.imgMin && !self.fitAfterDraw)
        setTimeout(function () {
          if (!self.destroyed && self.network) self.network.redraw();
        }, 0);
      fr.imgMin = imgMin;
      if (self.fitAfterDraw) {
        self.fitAfterDraw = false;
        self.network.fit();
      }
      self.pumpImages();
    });
  };

  // -- emphasis: keep = {nodes: {...}, edges: {...}, accent: {...}, color} or null for "all normal"
  NetworkView.prototype.neighbourhood = function (pid) {
    var nodes = {}, edges = {}, accent = {};
    nodes[pid] = true;
    Object.keys(this.graph.neighbours[pid] || {}).forEach(function (n) {
      nodes[n] = true;
      accent[pairKey(pid, n)] = true;
    });
    // bands among the neighbourhood stay fully visible, the performer's own bands are accented
    this.graph.edges.forEach(function (e) {
      if (nodes[e.from] && nodes[e.to]) edges[e.from + "-" + e.to] = true;
    });
    return { nodes: nodes, edges: edges, accent: accent, color: HIGHLIGHT };
  };

  // -- 3D view (beta): drawing, layout, pointer, switching
  NetworkView.prototype.draw3d = function () {
    var self = this, t = this.t.bind(this), drawId = this.drawId = (this.drawId || 0) + 1;
    this.stopLayoutWorker();
    this.setStatus(t("loading3d"));
    loadThree()
      .then(function (T) {
        if (self.destroyed || self.drawId !== drawId) return;
        if (!self.network) self.network = new Graph3D(self, T);
        var g = self.graph, ids = g.nodes, c = self.colors(), b = self.base;
        self.nodeRadius = self.radii(ids);
        var radius = ids.map(function (id) { return self.nodeRadius[id]; });
        self.nodes = { get: function (id) { return self.network.index[id] != null ? { id: id } : null; } };
        self.network.setGraph(ids, g.edges, radius, function (id) {
          return b.genderColors[genderOf(b, b.performers[id])];
        }, function (e) {
          return e.baseColor || c.edge;
        });
        // pictures: the nodes with an atlas cell want theirs, the largest first
        self.wanted = {};
        ids.forEach(function (id, i) {
          if (self.network.cellOf[i] >= 0) self.wanted[id] = radius[i];
        });
        self.pumpImages();
        self.layout3d(ids, g.edges, radius, drawId);
        self.setStatus([t("statusPeople", { count: ids.length }), t("statusEdges", { count: g.edges.length }), t("layouting")].join(" · "));
        self.fillRankings();
      })
      .catch(function (e) {
        console.warn(PLUGIN_ID + ": 3D view unavailable", e);
        self.lost3d(e && e.message ? e.message : String(e));
      });
  };

  NetworkView.prototype.layout3d = function (ids, edges, radius, drawId) {
    var self = this, index = {}, n = ids.length;
    ids.forEach(function (id, i) {
      index[id] = i;
    });
    var E = new Int32Array(edges.length * 2);
    edges.forEach(function (e, k) {
      E[2 * k] = index[e.from];
      E[2 * k + 1] = index[e.to];
    });
    var params = Object.assign({}, Core.LAYOUT_PARAMS, n > 1500 ? { iterations: LAYOUT3D_MAX_STEPS_LARGE } : {});
    var input = { n: n, edges: E, radius: Float64Array.from(radius), params: params };
    var fitted = false, start = this.initialView ? null : this.startNodes3d();
    function place(x, y, z, done, iterations) {
      if (self.destroyed || self.drawId !== drawId || !self.network || !self.network.is3d) return;
      self.network.setPositions(x, y, z);
      if (!fitted || done) self.network.fit({ animation: fitted, nodes: done ? start : null });
      fitted = true;
      if (!done) return;
      self.timing.layoutSteps = iterations;
      self.layoutFinished();
    }
    var w = LayoutWorker3D.create();
    if (!w) {
      // no worker: lay out on the page in one go (fewer steps), after the status line had a chance to show
      return setTimeout(function () {
        input.params = Object.assign({}, params, { iterations: Math.min(params.iterations, 150) });
        var r = Core.runLayout3D(input);
        place(r.x, r.y, r.z, true, r.iterations);
      }, 30);
    }
    this.layoutWorker = w;
    w.onmessage = function (ev) {
      if (self.layoutWorker !== w) return;
      var d = ev.data;
      if (d.done) self.stopLayoutWorker();
      place(d.x, d.y, d.z, d.done, d.iterations);
    };
    w.onerror = function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      if (self.layoutWorker !== w) return;
      self.stopLayoutWorker();
      var r = Core.runLayout3D(Object.assign({}, input, { params: Object.assign({}, params, { iterations: 150 }) }));
      place(r.x, r.y, r.z, true, r.iterations);
    };
    w.postMessage(input);
  };

  // Where the camera looks once a large 3D network is laid out: the favorites and their partners (an
  // overview of thousands of performers is a cloud); null = the whole network.
  var START3D_MIN_NODES = 150;
  NetworkView.prototype.startNodes3d = function () {
    var g = this.graph, b = this.base.performers, out = {};
    if (g.nodes.length < START3D_MIN_NODES) return null;
    g.nodes.forEach(function (id) {
      if (!b[id].favorite) return;
      out[id] = true;
      Object.keys(g.neighbours[id] || {}).forEach(function (n) {
        out[n] = true;
      });
    });
    var ids = Object.keys(out);
    return ids.length ? ids : null;
  };

  // pointer events of the 3D view, the same reactions as the 2D view's click and hover handlers; edges
  // are hit by their drawn line. On touch a tap also shows the performer's card next to the node.
  NetworkView.prototype.click3d = function (pid, multi, edgeId, touchPos) {
    if (pid == null) {
      this.clearMode();
      if (edgeId) this.selectEdge(edgeId);
      return;
    }
    if (multi) {
      if (this.pathStart && this.pathStart !== pid) {
        var from = this.pathStart;
        if (!this.showPath(from, pid)) this.showNoPath(from, pid);
      } else {
        this.focusPerformer(pid, false);
        this.pathStart = pid;
        this.showNodeDetail(pid);
      }
    } else if (this.pathFrom && this.pathFrom !== pid) this.pathTo(pid);
    else if (this.mode && this.mode.kind === "focus" && this.mode.pid === pid) return this.clearMode();
    else this.focusPerformer(pid, false);
    if (touchPos) this.showTapCard(pid, touchPos);
  };
  // the card after a tap: next to the node, but never over the detail panel (on a phone the panel sits
  // at the bottom), and gone again after TAP_CARD_MS or with the next touch
  var TAP_CARD_MS = 3500;
  NetworkView.prototype.showTapCard = function (pid, pos) {
    var self = this;
    this.showCard(pid, pos);
    var card = this.card, det = this.detail;
    if (!det.hidden) {
      // layout boxes (offset*), not the drawn ones: the panel may still be in its entrance animation
      var cTop = card.offsetTop, cH = card.offsetHeight, cL = card.offsetLeft, cW = card.offsetWidth;
      var dTop = det.offsetTop, dH = det.offsetHeight, dL = det.offsetLeft, dW = det.offsetWidth;
      if (cTop + cH > dTop && cTop < dTop + dH && cL + cW > dL && cL < dL + dW) {
        var top = dTop - cH - 8;
        if (top < 8) return this.hideCard();
        card.style.top = top + "px";
      }
    }
    clearTimeout(this.tapCardTimer);
    this.tapCardTimer = setTimeout(function () {
      if (!self.destroyed) self.hideCard();
    }, TAP_CARD_MS);
  };
  // an edge as clicked in 2D: the pair emphasized and the edge detail, without moving the camera
  NetworkView.prototype.selectEdge = function (edgeId) {
    var e = this.edgeIndex[edgeId];
    if (!e) return;
    var nodes = {}, accent = {};
    nodes[e.from] = nodes[e.to] = true;
    accent[edgeId] = true;
    this.mode = { kind: "edge", id: edgeId };
    this.emphasize({ nodes: nodes, edges: {}, accent: accent, color: HIGHLIGHT });
    this.showEdgeDetail(edgeId);
  };
  NetworkView.prototype.hover3d = function (pid, pos, edgeId) {
    var self = this, key = pid != null ? "n" + pid : edgeId ? "e" + edgeId : null;
    if (key === this.hover3dKey) return;
    this.hover3dKey = key;
    this.hover3dPid = pid;
    clearTimeout(this.hoverTimer);
    var el3 = this.network && this.network.renderer && this.network.renderer.domElement;
    if (el3) el3.style.cursor = key ? "pointer" : "";
    if (key == null) {
      this.hideCard();
      this.hoverTimer = setTimeout(function () {
        if (!self.mode && !self.destroyed) self.emphasize(null);
      }, HOVER_DELAY_MS);
      return;
    }
    if (pid != null) {
      this.hoverTimer = setTimeout(function () {
        if (!self.mode && !self.destroyed) self.emphasize(self.neighbourhood(pid));
      }, HOVER_DELAY_MS);
      return this.showCard(pid, pos);
    }
    var e = this.edgeIndex[edgeId];
    this.hoverTimer = setTimeout(function () {
      if (self.mode || self.destroyed) return;
      var nodes = {}, accent = {};
      nodes[e.from] = nodes[e.to] = true;
      accent[edgeId] = true;
      self.emphasize({ nodes: nodes, edges: {}, accent: accent, color: HOVER_EDGE });
    }, HOVER_DELAY_MS);
    this.showEdgeCard(edgeId, pos);
  };
  // small card for a hovered edge: the two names, what they share and when
  NetworkView.prototype.showEdgeCard = function (edgeId, pos) {
    var e = this.edgeIndex[edgeId], b = this.base.performers;
    if (!e) return;
    this.card.innerHTML = "";
    this.card.classList.add(CSS + "-card-mini");
    this.card.appendChild(
      el("div", { class: CSS + "-card-text" }, [
        el("div", { class: CSS + "-card-name", text: b[e.from].name + " & " + b[e.to].name }),
        el("div", { text: this.sharedSummary(e) }),
        this.spanText(e.scenes) ? el("div", { class: CSS + "-card-span", text: this.spanText(e.scenes) }) : null,
      ])
    );
    this.card.hidden = false;
    var main = this.card.parentNode.getBoundingClientRect(), cv = this.canvas.getBoundingClientRect();
    var x = cv.left - main.left + pos.x + 14, y = cv.top - main.top + pos.y + 14;
    this.card.style.left = Math.max(8, Math.min(x, main.width - this.card.offsetWidth - 8)) + "px";
    this.card.style.top = Math.max(8, Math.min(y, main.height - this.card.offsetHeight - 40)) + "px";
  };
  NetworkView.prototype.initialsPic = function (pid) {
    var cache = (this.initialsCache = this.initialsCache || {});
    if (!cache[pid]) {
      var p = this.base.performers[pid];
      cache[pid] = initialsCanvas(p.name, this.base.genderColors[genderOf(this.base, p)]);
    }
    return cache[pid];
  };

  // 2D <-> 3D: the drawing is replaced, filters, selection of the sidebar and URL stay
  NetworkView.prototype.switchView = function (to3d, quiet) {
    if (to3d && !webglAvailable()) return;
    this.stopLayoutWorker();
    if (this.network) this.network.destroy();
    this.network = null;
    this.nodes = null;
    this.edges = null;
    this.renderNode = null;
    this.canvas.innerHTML = "";
    this.view3d = !!to3d;
    var q = new URLSearchParams(location.search);
    if (this.view3d) q.set("view", "3d");
    else q.delete("view");
    var search = q.toString();
    this.history.replace({ pathname: location.pathname, search: search ? "?" + search : "" });
    var btn = this.root.querySelector("#" + CSS + "-view-toggle");
    if (btn) {
      btn.textContent = this.view3d ? "2D" : "3D";
      btn.title = this.t(this.view3d ? "view2d" : "view3d");
      btn.setAttribute("aria-label", this.t(this.view3d ? "view2d" : "view3d"));
    }
    this.draw();
    if (!quiet) this.prepareImages();
  };
  // WebGL missing, three.js not loadable or the context lost: back to 2D with a note
  NetworkView.prototype.lost3d = function (message) {
    var self = this;
    if (!this.view3d) return;
    setTimeout(function () {
      if (self.destroyed) return;
      self.switchView(false, true);
      self.setStatus(self.t("no3d", { message: message || "WebGL" }), true);
    }, 0);
  };

  // Node opacity is read by drawNode (nodeAlpha); only edges whose look actually changes are updated
  // (state remembered in edgeLook).
  NetworkView.prototype.emphasize = function (keep) {
    if (this.network && this.network.is3d) return this.network.emphasize(keep);
    var self = this, c = this.colors();
    var edgeUpd = [], nodesChanged = false;
    this.edgeLook = this.edgeLook || {};
    this.graph.nodes.forEach(function (id) {
      var alpha = !keep || keep.nodes[id] ? 1 : 0.15;
      if ((self.nodeAlpha[id] == null ? 1 : self.nodeAlpha[id]) === alpha) return;
      self.nodeAlpha[id] = alpha;
      nodesChanged = true;
    });
    this.edges.getIds().forEach(function (id) {
      var base = (self.edgeIndex[id] && self.edgeIndex[id].baseColor) || c.edge;
      var color = base, opacity = 0.55;
      if (keep) {
        if (keep.accent[id]) {
          color = keep.color;
          opacity = 0.95;
        } else if (!keep.edges[id]) opacity = 0.06;
      }
      var look = color + "|" + opacity;
      if ((self.edgeLook[id] || base + "|0.55") === look) return;
      self.edgeLook[id] = look;
      edgeUpd.push({ id: id, color: { color: color, highlight: keep && keep.accent[id] ? keep.color : HIGHLIGHT, hover: HIGHLIGHT, opacity: opacity } });
    });
    if (edgeUpd.length) this.edges.update(edgeUpd);
    else if (nodesChanged) this.network.redraw();
  };

  NetworkView.prototype.clearMode = function () {
    this.mode = null;
    this.pathStart = null;
    this.pathFrom = null;
    if (this.network) this.network.unselectAll();
    if (this.nodes) this.emphasize(null);
    this.closeDetail();
  };

  // -- years: from / to, from the years that occur in the library; a range leaves out undated scenes
  NetworkView.prototype.yearField = function () {
    var self = this, f = this.f, y = this.base.years, t = this.t.bind(this);
    var hint = el("div", { class: CSS + "-hint", id: CSS + "-years-hint" });
    function sync() {
      hint.textContent = (f.yearFrom || f.yearTo) && y.undated ? t("yearsUndated", { count: y.undated }) : "";
    }
    function yearSelect(id, value, label, set) {
      var sel = el("select", { class: "form-control form-control-sm " + CSS + "-year", id: id, "aria-label": label });
      sel.appendChild(el("option", { value: 0, text: t("yearAny") }));
      for (var n = y.max; n >= y.min; n--) sel.appendChild(el("option", { value: n, text: String(n) }));
      sel.value = String(value && value >= y.min && value <= y.max ? value : 0);
      sel.addEventListener("change", function () {
        set(Number(sel.value));
        sync();
        self.draw();
      });
      return sel;
    }
    var from = yearSelect(CSS + "-year-from", f.yearFrom, t("yearFrom"), function (v) { f.yearFrom = v; });
    var to = yearSelect(CSS + "-year-to", f.yearTo, t("yearTo"), function (v) { f.yearTo = v; });
    sync();
    return el("div", { class: CSS + "-field" }, [
      el("label", { for: CSS + "-year-from", text: t("years") }),
      el("div", { class: CSS + "-row " + CSS + "-years" }, [from, el("span", { text: t("yearRangeTo") }), to]),
      hint,
    ]);
  };

  // "together from ... to ..." for the scenes of an edge
  NetworkView.prototype.spanText = function (scenes) {
    var span = Core.dateSpan(scenes), i = this.i18n;
    if (!span) return null;
    return span.first === span.last ? this.t("togetherOn", { date: i.date(span.first) }) : this.t("togetherSpan", { first: i.date(span.first), last: i.date(span.last) });
  };

  // Rankings in the sidebar (Core.rankings over the shown network), rebuilt after every draw while open.
  var RANK_LIMIT = 10;
  NetworkView.prototype.fillRankings = function () {
    var self = this, box = this.rankBox, b = this.base.performers, t = this.t.bind(this);
    if (!box || !box.open || !this.graph) return;
    while (box.children.length > 1) box.removeChild(box.lastChild);
    var r = Core.rankings(this.graph, b, RANK_LIMIT, this.collator.compare);
    function item(content, count, onClick) {
      return el("li", null, [
        el("button", { type: "button", class: CSS + "-rank-item", title: content.join("") + ": " + count, onclick: onClick }, [
          el("span", { class: CSS + "-rank-name" }, content),
          el("span", { class: CSS + "-rank-count", text: count }),
        ]),
      ]);
    }
    var pairs = el("ol", { class: CSS + "-rank-list" });
    r.pairs.forEach(function (p) {
      pairs.appendChild(item([b[p.from].name, " & ", b[p.to].name], self.weightLabel(p.weight), function () { self.focusEdge(p.id); self.revealNetwork(); }));
    });
    var partners = el("ol", { class: CSS + "-rank-list" });
    r.partners.forEach(function (p) {
      partners.appendChild(item([b[p.id].name], t("partners", { count: p.count }), function () { self.focusPerformer(p.id, true); self.revealNetwork(); }));
    });
    if (!r.pairs.length) return box.appendChild(el("div", { class: CSS + "-hint", text: t("rankEmpty") }));
    box.appendChild(el("div", { class: CSS + "-rank-head", text: t("rankPairs") }));
    box.appendChild(pairs);
    box.appendChild(el("div", { class: CSS + "-rank-head", text: t("rankPartners") }));
    box.appendChild(partners);
  };

  // An edge as if it had been clicked, plus emphasis on the pair and a zoom to both performers.
  NetworkView.prototype.focusEdge = function (edgeId) {
    var e = this.edgeIndex[edgeId];
    if (!e) return;
    this.clearMode();
    var nodes = {}, accent = {};
    nodes[e.from] = nodes[e.to] = true;
    accent[edgeId] = true;
    this.mode = { kind: "edge", id: edgeId };
    this.network.selectEdges([edgeId]);
    this.emphasize({ nodes: nodes, edges: {}, accent: accent, color: HIGHLIGHT });
    this.network.fit({ nodes: [e.from, e.to], animation: { duration: 600, easingFunction: "easeInOutQuad" } });
    this.showEdgeDetail(edgeId);
  };

  NetworkView.prototype.focusPerformer = function (pid, centre) {
    this.pathStart = null;
    this.mode = { kind: "focus", pid: pid };
    this.network.selectNodes([pid], false);
    this.emphasize(this.neighbourhood(pid));
    this.showNodeDetail(pid);
    if (centre) this.network.focus(pid, { scale: 1.6, animation: { duration: 600, easingFunction: "easeInOutQuad" } });
  };

  NetworkView.prototype.showPath = function (from, to) {
    var path = shortestPath(this.graph, from, to);
    if (!path) return false;
    var nodes = {}, edges = {}, accent = {};
    path.forEach(function (id, i) {
      nodes[id] = true;
      if (i) accent[pairKey(path[i - 1], id)] = true;
    });
    this.pathStart = null;
    this.pathFrom = null;
    this.mode = { kind: "path", nodes: path };
    this.network.selectNodes(path, false);
    this.emphasize({ nodes: nodes, edges: edges, accent: accent, color: PATH_COLOR });
    this.network.fit({ nodes: path, animation: { duration: 600, easingFunction: "easeInOutQuad" } });
    this.showPathDetail(path);
    return true;
  };

  // "Path from here" / "Path to here" in the person detail: the way to a path without Ctrl/Cmd (touch).
  NetworkView.prototype.pathTo = function (pid) {
    var from = this.pathFrom;
    this.pathFrom = null;
    if (!this.showPath(from, pid)) this.showNoPath(from, pid);
  };

  NetworkView.prototype.showNoPath = function (from, to) {
    var b = this.base.performers;
    this.clearMode();
    this.openDetail(el("strong", { text: b[from].name + " \u2192 " + b[to].name }), [
      el("div", { class: CSS + "-hint " + CSS + "-nopath", text: this.t("noPath", { from: b[from].name, to: b[to].name }) }),
    ]);
  };

  // -- detail panel
  NetworkView.prototype.link = function (path, text, onClick) {
    var self = this;
    return el("a", {
      href: path,
      text: text,
      onclick: function (ev) {
        if (ev.ctrlKey || ev.metaKey || ev.button !== 0) return;
        ev.preventDefault();
        if (onClick) onClick();
        else self.history.push(path);
      },
    });
  };

  NetworkView.prototype.closeDetail = function () {
    if (this.detail) this.detail.hidden = true;
  };

  NetworkView.prototype.openDetail = function (head, body) {
    var self = this;
    this.detail.innerHTML = "";
    this.detail.appendChild(
      el("div", { class: CSS + "-detail-head" }, [
        head,
        el("button", { type: "button", class: "btn btn-sm btn-secondary", title: this.t("close"), "aria-label": this.t("close"), text: "\u00d7", onclick: function () { self.clearMode(); } }),
      ])
    );
    body.forEach(function (n) {
      if (n) self.detail.appendChild(n);
    });
    this.detail.hidden = false;
  };

  // Shared content: a flat grid of the shared scenes (newest first, small tiles; the group is a small
  // link under the tile), then ONE collapsed section with all galleries of those scenes (no duplicates).
  // Images load lazily; gallery tiles are only built when the section is opened.
  NetworkView.prototype.tile = function (path, img, title, sub, kind, extra) {
    var self = this;
    var a = el("a", {
      class: CSS + "-tile-link",
      href: path,
      title: title,
      onclick: function (ev) {
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button !== 0) return; // new tab stays native
        ev.preventDefault();
        self.history.push(path);
      },
    }, [
      el("span", { class: CSS + "-tile-img" }, [img ? el("img", { src: img, alt: "", loading: "lazy", decoding: "async" }) : null]),
      el("span", { class: CSS + "-tile-title", text: title }),
      sub ? el("span", { class: CSS + "-tile-sub", text: sub }) : null,
    ]);
    return el("div", { class: CSS + "-tile " + CSS + "-tile-" + kind }, [a, extra || null]);
  };

  // Open/closed state of collapsible sections, remembered for the browser session.
  var OpenState = {
    key: PLUGIN_ID + ":open",
    read: function () {
      try {
        return JSON.parse(sessionStorage.getItem(this.key) || "{}") || {};
      } catch (e) {
        return {};
      }
    },
    get: function (id) {
      return !!this.read()[id];
    },
    set: function (id, open) {
      try {
        var all = this.read();
        if (open) all[id] = 1;
        else delete all[id];
        sessionStorage.setItem(this.key, JSON.stringify(all));
      } catch (e) {
        /* storage unavailable: state is simply not remembered */
      }
    },
  };

  // <details> whose content is built on first opening; state per id in OpenState.
  NetworkView.prototype.collapsible = function (id, label, cls, build) {
    var box = el("details", { class: cls }, [el("summary", { text: label })]);
    function fill() {
      if (box.open && box.children.length === 1) box.appendChild(build());
    }
    box.addEventListener("toggle", function () {
      OpenState.set(id, box.open);
      fill();
    });
    if (OpenState.get(id)) {
      box.open = true;
      fill();
    }
    return box;
  };

  NetworkView.prototype.sharedSummary = function (e) {
    return this.t("scenes", { count: e.scenes.length }) + " · " + this.t("productions", { count: e.units.length });
  };

  // strength label of the chosen counting mode
  NetworkView.prototype.weightLabel = function (n) {
    return this.t(this.f.countBy === "productions" ? "productions" : "scenes", { count: n });
  };

  // The tiles need scene details (title, screenshot, galleries), which are loaded on first use.
  NetworkView.prototype.unitList = function (e, key) {
    var self = this;
    var box = el("div", { class: CSS + "-units" });
    if (e.scenes.every(function (sc) { return sc.detail; })) {
      self.fillUnits(box, e, key);
      return box;
    }
    box.appendChild(el("div", { class: CSS + "-hint", text: this.t("loadingScenes") }));
    this.ensureDetails(e.scenes).then(
      function () {
        box.innerHTML = "";
        self.fillUnits(box, e, key);
      },
      function (err) {
        box.innerHTML = "";
        box.appendChild(el("div", { class: CSS + "-hint " + CSS + "-error", text: self.t("error", { message: err.message || String(err) }) }));
      }
    );
    return box;
  };

  NetworkView.prototype.fillUnits = function (box, e, key) {
    var self = this, t = this.t.bind(this);
    var unitOf = {};
    e.units.forEach(function (u) {
      u.scenes.forEach(function (sc) {
        unitOf[sc.id] = u;
      });
    });
    var items = e.scenes.map(function (sc) {
      return { scene: sc, unit: unitOf[sc.id] };
    });
    items.sort(function (x, y) {
      return (y.scene.date || "").localeCompare(x.scene.date || "") || byNumber(y.scene.id, x.scene.id);
    });
    var grid = el("div", { class: CSS + "-tiles" });
    var seen = {}, galleries = [];
    items.forEach(function (it) {
      var sc = it.scene, u = it.unit;
      var groupLink = u && u.kind === "group" ? el("div", { class: CSS + "-tile-group" }, [self.link("/groups/" + u.id, u.name)]) : null;
      if (groupLink) groupLink.firstChild.setAttribute("title", t("group") + ": " + u.name);
      grid.appendChild(self.tile("/scenes/" + sc.id, sc.screenshot, sc.title || t("untitledScene", { id: sc.id }), self.i18n.date(sc.date), "scene", groupLink));
      sc.galleries.forEach(function (g) {
        if (seen[g.id]) return;
        seen[g.id] = true;
        galleries.push(g);
      });
    });
    var sets = null;
    if (galleries.length) {
      sets = self.collapsible("sets:" + key, t("imageSets", { count: galleries.length }), CSS + "-sets", function () {
        var g2 = el("div", { class: CSS + "-tiles" });
        galleries.forEach(function (g) {
          g2.appendChild(
            self.tile("/galleries/" + g.id, g.cover, g.title || t("untitledGallery", { id: g.id }), t("galleryImages", { count: g.images }), "gallery")
          );
        });
        return g2;
      });
    }
    box.appendChild(grid);
    if (sets) box.appendChild(sets);
  };

  NetworkView.prototype.edgeBetween = function (a, b) {
    return this.edgeIndex[pairKey(a, b)];
  };

  // A button that navigates inside Stash; Ctrl/Cmd or middle click keep the browser's own behaviour.
  NetworkView.prototype.navButton = function (path, text, cls) {
    var self = this;
    return el("a", {
      class: "btn btn-sm " + cls,
      href: path,
      text: text,
      onclick: function (ev) {
        if (ev.ctrlKey || ev.metaKey || ev.button !== 0) return;
        ev.preventDefault();
        self.history.push(path);
      },
    });
  };

  NetworkView.prototype.showEdgeDetail = function (edgeId) {
    var e = this.edgeIndex[edgeId];
    if (!e) return;
    var a = this.base.performers[e.from], b = this.base.performers[e.to];
    this.openDetail(el("strong", null, [this.link("/performers/" + a.id, a.name), " & ", this.link("/performers/" + b.id, b.name)]), [
      el("div", { class: CSS + "-hint", text: this.sharedSummary(e) }),
      this.spanText(e.scenes) ? el("div", { class: CSS + "-hint " + CSS + "-span", text: this.spanText(e.scenes) }) : null,
      el("div", { class: CSS + "-actions" }, [this.navButton(Core.scenesUrl([a, b]), this.t("openScenesBoth"), "btn-secondary")]),
      this.unitList(e, edgeId),
    ]);
  };

  NetworkView.prototype.showNodeDetail = function (pid) {
    var self = this, t = this.t.bind(this);
    var p = this.base.performers[pid];
    var nb = this.graph.neighbours[pid] || {};
    var n = this.graph.scenesPerPerformer[pid] || 0;
    var partners = Object.keys(nb).sort(function (x, y) {
      return nb[y] - nb[x] || self.collator.compare(self.base.performers[x].name, self.base.performers[y].name);
    });
    var list = el("ul", { class: CSS + "-partners" });
    partners.forEach(function (id) {
      var q = self.base.performers[id];
      var g = genderOf(self.base, q);
      var label = t("gender_" + g);
      var a = self.link("/performers/" + id, q.name, function () {
        self.focusPerformer(id, true);
      });
      var li = el("li", null, [
        el("span", { class: CSS + "-gender", style: "color:" + self.base.genderColors[g], title: label, "aria-label": label, role: "img", text: GENDER_SYMBOLS[g] || "\u2022" }),
        a,
        el("span", { class: CSS + "-extra", text: " " + self.weightLabel(nb[id]) }),
      ]);
      function show() {
        self.showPartnerCard(id, pid, li);
      }
      li.addEventListener("mouseenter", show);
      a.addEventListener("focus", show);
      li.addEventListener("mouseleave", function () { self.hideCard(); });
      a.addEventListener("blur", function () { self.hideCard(); });
      list.appendChild(li);
    });
    this.openDetail(el("strong", null, [p.name, favIcon(p, t)]), [
      el("div", { class: CSS + "-hint", text: t("scenesInSelection", { count: n, total: p.scene_count }) + " · " + t("partners", { count: partners.length }) + (p.o_counter ? " · " + t("orgasmCount", { count: p.o_counter }) : "") }),
      this.pathStart === pid ? el("div", { class: CSS + "-hint " + CSS + "-pathhint", text: t("pathStartHint", { name: p.name }) }) : null,
      this.pathFrom === pid ? el("div", { class: CSS + "-hint " + CSS + "-pathhint", text: t("pathFromHint", { name: p.name }) }) : null,
      el("div", { class: CSS + "-actions" }, [
        this.navButton("/performers/" + pid, t("openPage"), "btn-primary"),
        this.navButton(Core.scenesUrl([{ id: pid, name: p.name }]), t("openScenesOne"), "btn-secondary"),
        this.pathFrom && this.pathFrom !== pid
          ? el("button", { type: "button", class: "btn btn-sm btn-secondary", text: t("pathToHere", { name: this.base.performers[this.pathFrom].name }), onclick: function () { self.pathTo(pid); } })
          : el("button", { type: "button", class: "btn btn-sm btn-secondary", text: t("pathFromHere"), "aria-pressed": this.pathFrom === pid ? "true" : "false", onclick: function () {
            self.pathFrom = self.pathFrom === pid ? null : pid;
            self.showNodeDetail(pid);
          } }),
      ]),
      partners.length ? el("div", { class: CSS + "-subhead", text: t("partnersHeading") }) : null,
      partners.length ? list : null,
    ]);
  };

  NetworkView.prototype.showPathDetail = function (path) {
    var self = this, b = this.base.performers;
    var list = el("ol", { class: CSS + "-path" });
    path.forEach(function (id, i) {
      var item = el("li", null, [
        el("strong", null, [self.link("/performers/" + id, b[id].name, function () { self.focusPerformer(id, true); })]),
      ]);
      if (i < path.length - 1) {
        var e = self.edgeBetween(id, path[i + 1]);
        // built on first opening only (keeps long paths cheap)
        item.appendChild(
          self.collapsible("step:" + pairKey(id, path[i + 1]), "\u2193 " + self.sharedSummary(e), CSS + "-step", function () {
            return self.unitList(e, pairKey(id, path[i + 1]));
          })
        );
      }
      list.appendChild(item);
    });
    this.openDetail(el("strong", { text: b[path[0]].name + " \u2192 " + b[path[path.length - 1]].name }), [
      el("div", { class: CSS + "-hint", text: this.t("pathTitle", { count: path.length - 1 }) }),
      list,
    ]);
  };

  // -- hover card
  NetworkView.prototype.showCard = function (pid, pos) {
    var t = this.t.bind(this), b = this.base.performers;
    var p = b[pid];
    var nb = this.graph.neighbours[pid] || {};
    var strongest = null;
    Object.keys(nb).forEach(function (id) {
      if (!strongest || nb[id] > nb[strongest] || (nb[id] === nb[strongest] && b[id].name < b[strongest].name)) strongest = id;
    });
    var color = this.base.genderColors[genderOf(this.base, p)];
    this.card.innerHTML = "";
    this.card.classList.remove(CSS + "-card-mini");
    this.card.appendChild(this.cardImg(pid, color));
    this.card.appendChild(
      el("div", { class: CSS + "-card-text" }, [
        el("div", { class: CSS + "-card-name" }, [p.name, favIcon(p, t)]),
        el("div", { text: t("scenesInSelection", { count: this.graph.scenesPerPerformer[pid] || 0, total: p.scene_count }) }),
        el("div", { text: t("partners", { count: Object.keys(nb).length }) }),
        p.o_counter ? el("div", { text: t("orgasmCount", { count: p.o_counter }) }) : null,
        strongest ? el("div", { text: t("strongest", { name: b[strongest].name, label: this.weightLabel(nb[strongest]) }) }) : null,
      ])
    );
    this.card.hidden = false;
    var main = this.card.parentNode.getBoundingClientRect();
    var w = this.card.offsetWidth, ht = this.card.offsetHeight;
    var x = (pos ? pos.x : 20) + 18, y = (pos ? pos.y : 20) + 18;
    if (x + w > main.width - 8) x = Math.max(8, x - w - 36);
    if (y + ht > main.height - 40) y = Math.max(8, y - ht - 36);
    this.card.style.left = x + "px";
    this.card.style.top = y + "px";
  };

  // Mini card for a partner in the person detail: face, name, scenes in total, partners, and what the
  // partner shares with the selected performer (in the chosen counting mode). Shown left of the panel.
  NetworkView.prototype.showPartnerCard = function (id, selected, anchor) {
    var t = this.t.bind(this), b = this.base.performers, p = b[id];
    var nb = this.graph.neighbours[id] || {};
    var color = this.base.genderColors[genderOf(this.base, p)];
    this.card.innerHTML = "";
    this.card.classList.add(CSS + "-card-mini");
    this.card.appendChild(this.cardImg(id, color));
    this.card.appendChild(
      el("div", { class: CSS + "-card-text" }, [
        el("div", { class: CSS + "-card-name" }, [p.name, favIcon(p, t)]),
        el("div", { text: t("scenesTotal", { count: p.scene_count || 0 }) }),
        el("div", { text: t("partners", { count: Object.keys(nb).length }) }),
        p.o_counter ? el("div", { text: t("orgasmCount", { count: p.o_counter }) }) : null,
        el("div", { class: CSS + "-card-shared", text: t("sharedWith", { name: b[selected].name, label: this.weightLabel(nb[selected] || 0) }) }),
        this.edgeIndex[pairKey(id, selected)] ? el("div", { class: CSS + "-card-span", text: this.spanText(this.edgeIndex[pairKey(id, selected)].scenes) }) : null,
      ])
    );
    this.card.hidden = false;
    var main = this.card.parentNode.getBoundingClientRect();
    var panel = this.detail.getBoundingClientRect();
    var r = anchor.getBoundingClientRect();
    var w = this.card.offsetWidth, ht = this.card.offsetHeight;
    var x = panel.left - main.left - w - 10;
    var y = Math.max(8, Math.min(main.height - ht - 40, r.top - main.top + r.height / 2 - ht / 2));
    this.card.style.left = Math.max(8, x) + "px";
    this.card.style.top = y + "px";
  };

  NetworkView.prototype.hideCard = function () {
    if (this.card) this.card.hidden = true;
    this.cardPid = this.cardWant = null;
  };

  // -- images: only for nodes drawn large enough for one (this.wanted, see drawNode), the largest on screen
  // first, a few in flight at once (pumpImages). Per performer: the crop cached in this browser, else the
  // image with shared face data (spn_face), else face detection (MediaPipe, loaded on first need), else
  // the fallback crop (fallbackCrop). Finished crops are drawn together, in one redraw at most every
  // IMAGE_REDRAW_MS.
  var IMAGE_REDRAW_MS = 500;
  NetworkView.prototype.setImage = function (pid, pic, kind, url) {
    var self = this;
    this.pics[pid] = pic;
    this.images[pid] = { kind: kind, url: url || null, canvas: url ? null : pic };
    if (this.network && this.network.is3d) this.network.picChanged(pid);
    if (this.cardPid === pid && this.cardPic) this.cardPic.src = this.cardImage(pid); // the open card gets the crop
    if (this.redrawTimer) return;
    this.redrawTimer = setTimeout(function () {
      self.redrawTimer = null;
      if (!self.destroyed && self.network) self.network.redraw();
    }, IMAGE_REDRAW_MS);
  };

  // image for the hover and partner cards: the crop if there is one; else the performer image while its
  // crop is made, first in line (cardWant, see nextImage), whatever the node is drawn as; else initials
  NetworkView.prototype.cardImage = function (pid) {
    var im = this.images[pid];
    if (im && !im.url && im.canvas) im.url = toUrl(im.canvas);
    if (im && im.url) return im.url;
    var item = this.imageItems[pid];
    if (item) {
      this.cardWant = pid;
      this.pumpImages();
      return item.url;
    }
    var p = this.base.performers[pid];
    return initialsImage(p.name, this.base.genderColors[genderOf(this.base, p)]);
  };

  NetworkView.prototype.cardImg = function (pid, color) {
    this.cardPid = null;
    var img = el("img", { class: CSS + "-card-img", src: this.cardImage(pid), alt: "", style: "border-color:" + color });
    this.cardPid = pid;
    this.cardPic = img;
    return img;
  };

  // -- shared face data: the detection result is stored on the performer as custom field FACE_FIELD
  // (JSON string {v, h, b}: detector version, image hash, face box normalised to 0..1 or null for "no
  // face"), so other browsers and devices crop without running MediaPipe. Only custom_fields are sent,
  // as a partial update. Writing is controlled by the setting storeFaces (off by default) and
  // tried without writing with ?spnFaceWrite=dry.
  var WRITE_BATCH = 10, WRITE_DELAY_MS = 3000;

  NetworkView.prototype.writeMode = function () {
    if (!this.settings.storeFaces || this.settings.disableFaceCrops) return "off";
    try {
      if (new URLSearchParams(location.search).get("spnFaceWrite") === "dry") return "dry";
    } catch (e) {
      /* ignore */
    }
    return "on";
  };

  NetworkView.prototype.queueFaceWrite = function (pid, value) {
    var self = this, w = this.timing.writes;
    var mode = this.writeMode();
    if (mode === "off") return;
    if (mode === "dry") {
      w.dry++;
      (this.dryWrites = this.dryWrites || {})[pid] = JSON.stringify(value); // inspectable, never sent
      return;
    }
    (this.writeQueue = this.writeQueue || []).push({ id: pid, value: JSON.stringify(value) });
    if (this.writeQueue.length >= WRITE_BATCH) return this.flushWrites();
    clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(function () {
      self.flushWrites();
    }, WRITE_DELAY_MS);
  };

  // one request per batch (aliased performerUpdate calls), one request in flight at a time
  NetworkView.prototype.flushWrites = function () {
    var self = this, w = this.timing.writes;
    clearTimeout(this.writeTimer);
    if (this.writing || !this.writeQueue || !this.writeQueue.length) return;
    var batch = this.writeQueue.splice(0, WRITE_BATCH);
    var vars = {}, defs = [], calls = [];
    batch.forEach(function (it, i) {
      var cf = {};
      cf[FACE_FIELD] = it.value;
      vars["i" + i] = { id: it.id, custom_fields: { partial: cf } };
      defs.push("$i" + i + ": PerformerUpdateInput!");
      calls.push("u" + i + ": performerUpdate(input: $i" + i + ") { id }");
    });
    this.writing = true;
    fetch(GRAPHQL, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true, // still delivered when the page is left right after
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "mutation SpnFaces(" + defs.join(", ") + ") { " + calls.join(" ") + " }", variables: vars }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        if (j.errors && j.errors.length) throw new Error(j.errors[0].message);
        w.written += batch.length;
      })
      .catch(function (e) {
        w.failed += batch.length;
        console.warn(PLUGIN_ID + ": " + self.t("faceWriteFailed"), e && e.message ? e.message : e);
      })
      .then(function () {
        self.writing = false;
        if (self.writeQueue.length) self.flushWrites();
      });
  };

  // (Re)starts the image jobs. redetect: undefined = normal; "missing" = detect again where Stash has no
  // face data (local cache ignored for those); "all" = ignore local cache and shared data for everyone.
  // With "use face crops" off, images are only cropped square (fallbackCrop): no cache, no MediaPipe.
  // Crops already drawn stay until a new one replaces them.
  NetworkView.prototype.prepareImages = function (redetect) {
    var self = this, b = this.base, items = {};
    this.imageRun = (this.imageRun || 0) + 1; // jobs of an earlier run are dropped when they finish
    this.redetect = redetect || null;
    this.plain = !!this.settings.disableFaceCrops;
    this.busy = 0;
    Object.keys(b.performers).forEach(function (pid) {
      var t = imageStamp(b.performers[pid].image_path);
      if (t != null) items[pid] = { pid: pid, key: pid + ":" + t, url: "performer/" + pid + "/image?t=" + encodeURIComponent(t), shared: readFaceField(b.performers[pid]), state: null };
    });
    if (redetect === "all")
      Object.keys(items).forEach(function (pid) {
        items[pid].shared = null;
      });
    this.imageItems = items;
    this.timing.images = { total: Object.keys(items).length, cached: 0, shared: 0, detected: 0, face: 0, fallback: 0, plain: 0, failed: 0, retried: 0, retryFace: 0 };
    this.timing.writes = { mode: this.writeMode(), written: 0, dry: 0, failed: 0 };
    this.pumpImages();
  };

  // the detector (and with it the request guard) is closed after DETECTOR_IDLE_MS without image jobs and
  // created again when faces are needed later
  var PARALLEL_IMAGES = 4, DETECTOR_IDLE_MS = 10000;
  NetworkView.prototype.pumpImages = function () {
    var self = this, run = this.imageRun;
    if (!run || this.destroyed || this.imagesStopped) return;
    while (this.busy < PARALLEL_IMAGES) {
      var o = this.nextImage();
      if (!o) break;
      o.state = "busy";
      this.busy++;
      this.processImage(o, run)
        .catch(function () {
          self.timing.images.failed++;
        })
        .then(this.jobDone(o, run));
    }
    if (!this.busy) {
      this.quiet(false);
      this.flushWrites();
      if (this.detectorPromise && !this.detectorIdle)
        this.detectorIdle = setTimeout(function () {
          self.detectorIdle = null;
          if (!self.busy) self.releaseDetector();
        }, DETECTOR_IDLE_MS);
    } else if (this.detectorIdle) {
      clearTimeout(this.detectorIdle);
      this.detectorIdle = null;
    }
  };

  NetworkView.prototype.jobDone = function (o, run) {
    var self = this;
    return function () {
      o.state = "done";
      if (run !== self.imageRun) return; // a newer run has its own count
      self.busy--;
      whenIdle(function () {
        self.pumpImages();
      });
    };
  };

  // the performer of the open card, else the wanted performer with the largest node on screen that has
  // not been processed yet
  NetworkView.prototype.nextImage = function () {
    var best = null, size = -1, w = this.wanted, items = this.imageItems;
    var card = this.cardWant && items[this.cardWant];
    if (card && !card.state) return card;
    for (var id in w) {
      var o = items[id];
      if (o && !o.state && w[id] > size) {
        best = o;
        size = w[id];
      }
    }
    return best;
  };

  // how many of the performers drawn large enough for an image have one (for measuring and screenshots)
  NetworkView.prototype.faceProgress = function () {
    var wanted = 0, done = 0;
    for (var id in this.wanted) {
      var o = this.imageItems[id];
      if (!o) continue;
      wanted++;
      if (o.state === "done") done++;
    }
    return { wanted: wanted, done: done, busy: this.busy || 0 };
  };

  // measuring: stop image jobs (window.performerNetwork.stopImages())
  NetworkView.prototype.stopImages = function () {
    this.imagesStopped = true;
    this.imageRun = (this.imageRun || 0) + 1;
  };

  // MediaPipe's status lines are dropped while it works (quietConsole), not longer
  NetworkView.prototype.quiet = function (on) {
    if (!!this.quietOn === on) return;
    this.quietOn = on;
    if (on) quietConsole.on();
    else quietConsole.off();
  };

  NetworkView.prototype.getDetector = function () {
    var self = this;
    if (!this.detectorPromise) {
      this.quiet(true);
      var p = (this.detectorPromise = Faces.detector(function (host) {
        return self.t("requestBlocked", { host: host });
      })
        .catch(function (e) {
          self.timing.images.detectorFailed = true;
          console.warn(PLUGIN_ID + ": " + self.t("faceUnavailable"), e && e.message ? e.message : e);
          return null;
        })
        .then(function (d) {
          if (self.detectorPromise === p) self.detectorReady = !!d;
          return d;
        }));
    }
    return this.detectorPromise;
  };

  NetworkView.prototype.releaseDetector = function () {
    clearTimeout(this.detectorIdle);
    this.detectorIdle = null;
    if (!this.detectorPromise) return;
    this.detectorPromise = null;
    this.detectorReady = false;
    Faces.release();
  };

  function closeImage(img) {
    if (img && img.close) img.close();
  }

  NetworkView.prototype.processImage = function (o, run) {
    var self = this, m = this.timing.images, plain = this.plain, redetect = this.redetect;
    function current() {
      return run === self.imageRun && !self.destroyed;
    }
    var lookup = plain || redetect === "all" ? Promise.resolve({}) : Cache.getMany([o.key]);
    return lookup.then(function (stored) {
      if (!current()) return;
      var v = stored[o.key], known = null;
      if (v && !(redetect === "missing" && !o.shared)) {
        // no face, but found by an earlier detector version or cropped with another fallbackCrop: the image
        // is loaded again and then cropped again or, if faceStillValid says so, detected again
        if (v.kind === "fallback" && (v.v !== FACE_VERSION || v.crop !== self.settings.fallbackCrop)) known = { v: v.v, h: v.h, b: null };
        else {
          m.cached++;
          // detected here earlier but not (yet) stored on the performer: share it now
          if (v.h && (!o.shared || o.shared.h !== v.h)) self.queueFaceWrite(o.pid, { v: FACE_VERSION, h: v.h, b: v.b || null });
          return loadImage(v.url).then(function (img) {
            if (current()) self.setImage(o.pid, img, v.kind, v.url);
          });
        }
      }
      return loadBitmap(o.url)
        .then(function (res) {
          return new Promise(function (resolve) {
            whenIdle(function () {
              resolve(res);
            });
          });
        })
        .then(function (res) {
          var img = res.img;
          if (!current()) return closeImage(img);
          if (plain) return self.finishImage(o, img, null, null, true);
          var dm = dims(img), shared = !!(o.shared && res.hash && o.shared.h === res.hash);
          if (known && faceStillValid(known, dm.w, dm.h)) {
            m.cached++;
            return self.finishImage(o, img, null, res.hash, shared);
          }
          if (shared && faceStillValid(o.shared, dm.w, dm.h)) {
            m.shared++;
            return self.finishImage(o, img, o.shared.b, res.hash, true);
          }
          // while MediaPipe is still loading, show the fallback crop meanwhile
          if (!self.detectorReady && !self.pics[o.pid]) self.setImage(o.pid, fallbackCrop(img, self.settings.fallbackCrop), "fallback");
          return self.getDetector().then(function (d) {
            if (!current() || !d) return closeImage(img); // no detector: keep the fallback, nothing cached or shared
            self.quiet(true);
            m.detected++;
            var largest = largestBox(d.detect(img));
            var box = largest ? boxToNormal(img, largest) : self.detectTop(d, img);
            return self.finishImage(o, img, box, res.hash, false);
          });
        });
    });
  };

  function largestBox(result) {
    var largest = null;
    ((result && result.detections) || []).forEach(function (det) {
      var bb = det.boundingBox;
      if (bb && (!largest || bb.width * bb.height > largest.width * largest.height)) largest = bb;
    });
    return largest;
  }

  // Second attempt for tall images (Core.tallRegion): in a full-body photo the face is small, and BlazeFace
  // short range, which sees the whole image at DETECT_PX, often misses it. The top square alone, scaled to
  // the same size, shows the face several times larger. Returns the box normalised to the whole image.
  var DETECT_PX = 128; // input size of blaze_face_short_range
  NetworkView.prototype.detectTop = function (d, img) {
    var dm = dims(img), r = tallRegion(dm.w, dm.h), m = this.timing.images;
    if (!r) return null;
    m.retried++;
    var c = document.createElement("canvas");
    c.width = c.height = DETECT_PX;
    var g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(img, r.x, r.y, r.side, r.side, 0, 0, DETECT_PX, DETECT_PX);
    var bb = largestBox(d.detect(c));
    if (!bb) return null;
    m.retryFace++;
    return boxToNormal(img, regionBoxToImage(bb, r, DETECT_PX));
  };

  NetworkView.prototype.finishImage = function (o, img, box, hash, viaShared) {
    var m = this.timing.images;
    if (this.plain) {
      m.plain++;
      this.setImage(o.pid, fallbackCrop(img, this.settings.fallbackCrop), "plain");
      return closeImage(img);
    }
    var mode = this.settings.fallbackCrop;
    var pic = box ? faceCrop(img, boxToPixels(img, box)) : fallbackCrop(img, mode);
    var kind = box ? "face" : "fallback";
    m[kind]++;
    closeImage(img);
    var url = toUrl(pic);
    this.setImage(o.pid, pic, kind, url);
    if (!viaShared && hash) this.queueFaceWrite(o.pid, { v: FACE_VERSION, h: hash, b: box });
    // h and b kept so a later visit can still share it; crop = the fallbackCrop the crop was made with
    return Cache.put(o.key, { url: url, kind: kind, h: hash, b: box, v: FACE_VERSION, crop: box ? null : mode });
  };

  // ------------------------------------------------------------------ settings dialog
  NetworkView.prototype.filterSummary = function (df) {
    var t = this.t.bind(this), b = this.base, parts = [];
    if (df.studio && b.studios[df.studio]) parts.push(t("sumStudio", { name: b.studios[df.studio].name }));
    var tags = (df.tags || []).filter(function (id) { return b.tags[id]; }).map(function (id) { return b.tags[id].name; });
    if (tags.length) parts.push(t(df.tagMode === "all" ? "sumTagsAll" : "sumTagsAny", { names: tags.join(", ") }));
    if (df.sceneStars) parts.push(t("sumSceneStars", { count: df.sceneStars }));
    if (df.perfStars) parts.push(t("sumPerfStars", { count: df.perfStars }));
    if (df.watchedOnly) parts.push(t("watchedOnly"));
    if (df.orgasmOnly) parts.push(t("orgasmOnly"));
    return parts.length ? parts.join(" · ") : t("setDefaultFiltersNone");
  };

  NetworkView.prototype.openSettings = function () {
    var self = this, t = this.t.bind(this), b = this.base;
    if (this.modal || !b) return;
    var draft = JSON.parse(JSON.stringify(this.settings));
    var opener = document.activeElement;
    var msg = el("div", { class: CSS + "-hint " + CSS + "-modal-msg", role: "status", "aria-live": "polite" });

    function control(d) {
      var id = CSS + "-set-" + d.key, row;
      if (d.type === "BOOLEAN") {
        var c = el("input", { type: "checkbox", id: id, class: "custom-control-input" });
        c.checked = d.invert ? !draft[d.key] : !!draft[d.key];
        c.addEventListener("change", function () {
          draft[d.key] = d.invert ? !c.checked : c.checked;
        });
        row = el("div", { class: "custom-control custom-checkbox" }, [c, el("label", { class: "custom-control-label", for: id, text: t(d.label) })]);
      } else if (d.options) {
        var sel = el("select", { class: "form-control form-control-sm", id: id });
        Object.keys(d.options).forEach(function (v) {
          sel.appendChild(el("option", { value: v, text: t(d.options[v]) }));
        });
        sel.value = draft[d.key];
        sel.addEventListener("change", function () {
          draft[d.key] = sel.value;
        });
        row = el("div", { class: CSS + "-row" }, [el("label", { for: id, text: t(d.label) }), sel]);
      } else if (d.type === "NUMBER") {
        var shown = el("span", { class: CSS + "-value", text: String(draft[d.key]) });
        var r = el("input", { type: "range", class: "custom-range", id: id, min: d.min, max: d.max, step: d.step, value: draft[d.key] });
        r.addEventListener("input", function () {
          shown.textContent = r.value;
          draft[d.key] = Number(r.value);
        });
        row = el("div", null, [el("label", { for: id }, [t(d.label) + " ", shown]), r]);
      } else if (d.editor === "colors") {
        var list = el("div", { class: CSS + "-colors" });
        var render = function () {
          list.innerHTML = "";
          b.genders.forEach(function (g) {
            var cid = id + "-" + g;
            var cur = (draft.genderColors || {})[g] || self.defaultColors[g];
            var inp = el("input", { type: "color", id: cid, value: cur });
            inp.addEventListener("input", function () {
              draft.genderColors = Object.assign({}, draft.genderColors);
              draft.genderColors[g] = inp.value;
            });
            list.appendChild(
              el("div", { class: CSS + "-color" }, [
                inp,
                el("label", { for: cid, text: t("gender_" + g) }),
                el("button", { type: "button", class: "btn btn-link btn-sm", text: t("setReset"), onclick: function () {
                  draft.genderColors = Object.assign({}, draft.genderColors);
                  delete draft.genderColors[g];
                  render();
                } }),
              ])
            );
          });
        };
        render();
        row = el("div", null, [
          el("div", { class: CSS + "-label", text: t(d.label) }),
          list,
          el("button", { type: "button", class: "btn btn-link btn-sm p-0", text: t("setResetAll"), onclick: function () { draft.genderColors = {}; render(); } }),
        ]);
      } else if (d.editor === "filters") {
        var sum = el("div", { class: CSS + "-hint", id: id + "-summary", text: self.filterSummary(draft.defaultFilters || {}) });
        row = el("div", null, [
          el("div", { class: CSS + "-label", text: t(d.label) }),
          sum,
          el("div", { class: CSS + "-actions" }, [
            el("button", { type: "button", class: "btn btn-sm btn-secondary", id: id + "-current", text: t("setUseCurrent"), onclick: function () {
              var f = self.f;
              draft.defaultFilters = { studio: f.studio, tags: f.tags.slice(), tagMode: f.tagMode, sceneStars: f.sceneStars, perfStars: f.perfStars, watchedOnly: f.watchedOnly, orgasmOnly: f.orgasmOnly };
              sum.textContent = self.filterSummary(draft.defaultFilters);
            } }),
            el("button", { type: "button", class: "btn btn-sm btn-link", text: t("setClear"), onclick: function () {
              draft.defaultFilters = {};
              sum.textContent = self.filterSummary({});
            } }),
          ]),
        ]);
      }
      var legacy = d.key === "storeFaces" && self.settings.storeFacesSource === "existingData"
        ? el("div", { class: CSS + "-hint " + CSS + "-pathhint", text: t("setStoreFacesExisting") }) : null;
      return el("div", { class: CSS + "-set" }, [row, d.help ? el("div", { class: CSS + "-hint", text: t(d.help) }) : null, legacy]);
    }

    function section(name, title, extra) {
      var box = el("section", { class: CSS + "-set-section", "aria-labelledby": CSS + "-sec-" + name }, [el("h5", { id: CSS + "-sec-" + name, text: t(title) })]);
      SETTINGS.filter(function (d) { return d.section === name; }).forEach(function (d) {
        box.appendChild(control(d));
      });
      (extra || []).forEach(function (x) {
        box.appendChild(x);
      });
      return box;
    }

    // face actions act immediately (they are not settings)
    var confirmBox = el("div", { class: CSS + "-confirm", hidden: "" });
    var faceActions = el("div", { class: CSS + "-set" }, [
      el("div", { class: CSS + "-actions" }, [
        el("button", { type: "button", class: "btn btn-sm btn-secondary", id: CSS + "-clear-cache", text: t("setClearCache"), onclick: function () {
          Cache.clear().then(function (n) {
            msg.textContent = t("setClearDone", { count: n });
          });
        } }),
      ]),
      el("div", { class: CSS + "-actions" }, [
        el("span", { class: CSS + "-label", text: t("setRedetect") }),
        el("button", { type: "button", class: "btn btn-sm btn-secondary", id: CSS + "-redetect-missing", text: t("setRedetectMissing"), onclick: function () {
          self.prepareImages("missing");
          msg.textContent = t("setRedetectStarted");
        } }),
        el("button", { type: "button", class: "btn btn-sm btn-secondary", id: CSS + "-redetect-all", text: t("setRedetectAll"), onclick: function () {
          confirmBox.hidden = false;
          confirmBox.querySelector("button").focus();
        } }),
      ]),
      confirmBox,
    ]);
    var total = Object.keys(b.performers).filter(function (id) { return imageStamp(b.performers[id].image_path) != null; }).length;
    confirmBox.appendChild(el("div", { text: t("setRedetectAllConfirm", { count: total }) }));
    confirmBox.appendChild(
      el("div", { class: CSS + "-actions" }, [
        el("button", { type: "button", class: "btn btn-sm btn-danger", id: CSS + "-redetect-yes", text: t("setYes"), onclick: function () {
          confirmBox.hidden = true;
          self.prepareImages("all");
          msg.textContent = t("setRedetectStarted");
        } }),
        el("button", { type: "button", class: "btn btn-sm btn-secondary", text: t("setNo"), onclick: function () { confirmBox.hidden = true; } }),
      ])
    );

    var dialog = el("div", { class: CSS + "-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": CSS + "-settings-title" }, [
      el("div", { class: CSS + "-modal-head" }, [
        el("h4", { id: CSS + "-settings-title", text: t("settings") }),
        el("button", { type: "button", class: "btn btn-sm btn-secondary", "aria-label": t("close"), title: t("close"), text: "\u00d7", onclick: close }),
      ]),
      el("div", { class: CSS + "-modal-body" }, [
        section("faces", "setFaces", [faceActions]),
        section("display", "setDisplay"),
        section("defaults", "setDefaults", [el("div", { class: CSS + "-hint", text: t("setDefaultsHint") })]),
        el("div", { class: CSS + "-hint", text: t("setStashHint") }),
      ]),
      el("div", { class: CSS + "-modal-foot" }, [
        msg,
        el("button", { type: "button", class: "btn btn-secondary", id: CSS + "-settings-cancel", text: t("setCancel"), onclick: close }),
        el("button", { type: "button", class: "btn btn-primary", id: CSS + "-settings-save", text: t("setSave"), onclick: save }),
      ]),
    ]);
    var backdrop = el("div", { class: CSS + "-backdrop" }, [dialog]);
    backdrop.addEventListener("mousedown", function (e) {
      if (e.target === backdrop) close();
    });
    dialog.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        if (!confirmBox.hidden) confirmBox.hidden = true;
        else close();
      } else if (e.key === "Tab") {
        // keep the focus inside the dialog
        var f = [].slice.call(dialog.querySelectorAll("button, input, select")).filter(function (x) { return !x.disabled && x.offsetParent; });
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    });

    function close() {
      if (!self.modal) return;
      self.modal = null;
      backdrop.remove();
      if (opener && opener.focus) opener.focus();
    }

    function save() {
      var before = self.settings;
      msg.textContent = "";
      saveSettings(draft)
        .then(function (stored) {
          self.settings = readSettings(stored, { hasFaceData: self.hasFaceData() });
          self.applySettings();
          var st = self.settings;
          if (st.nodeSizeBy !== before.nodeSizeBy) self.f.sizeBy = st.nodeSizeBy;
          self.sidebar.innerHTML = "";
          self.buildFilters();
          self.draw();
          if (st.disableFaceCrops !== before.disableFaceCrops || st.fallbackCrop !== before.fallbackCrop) self.prepareImages();
          close();
          self.setStatus(t("setSaved"));
        })
        .catch(function (e) {
          msg.textContent = t("setSaveFailed", { message: e.message });
        });
    }

    this.modal = { close: close };
    this.root.appendChild(backdrop);
    var first = dialog.querySelector("." + CSS + "-modal-body input, ." + CSS + "-modal-body select") || dialog.querySelector("button");
    if (first) first.focus();
  };

  // ------------------------------------------------------------------ React wrapper, route, navbar

  // A render error in our components must not reach Stash: its own error boundary sits outside the
  // IntlProvider and fails itself, which leaves the whole UI black. fallback(error) renders instead.
  function ErrorBoundary(props) {
    React.Component.call(this, props);
    this.state = { error: null };
  }
  ErrorBoundary.prototype = Object.create(React.Component.prototype);
  ErrorBoundary.prototype.constructor = ErrorBoundary;
  ErrorBoundary.getDerivedStateFromError = function (error) {
    return { error: error };
  };
  ErrorBoundary.prototype.componentDidCatch = function (error) {
    console.error(PLUGIN_ID + ":", error);
  };
  ErrorBoundary.prototype.render = function () {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  };

  function guarded(Component, fallback) {
    function Guarded(props) {
      return h(ErrorBoundary, { fallback: fallback }, h(Component, props));
    }
    Guarded.displayName = "SPN" + (Component.name || "Component");
    return Guarded;
  }

  function errorMessage(e) {
    return (e && e.message) || String(e);
  }

  function PageError(props) {
    var i18n = useI18n();
    var message = errorMessage(props.error);
    return h(
      "div",
      { className: CSS + "-page" },
      h("div", { className: CSS + "-status " + CSS + "-error", role: "alert" }, i18n ? i18n.t("pageError", { message: message }) : "Performer Network: " + message)
    );
  }

  function NetworkPage() {
    var ref = React.useRef(null);
    var history = RRD.useHistory();
    var i18n = useI18n();
    var failed = React.useState(null);
    React.useEffect(
      function () {
        if (!i18n) return;
        document.title = i18n.t("title") + " | Stash";
        var view;
        try {
          view = new NetworkView(ref.current, history, i18n);
          view.start();
        } catch (e) {
          console.error(PLUGIN_ID + ":", e);
          failed[1](e);
        }
        return function () {
          try {
            if (view) view.destroy();
          } catch (e) {
            console.error(PLUGIN_ID + ":", e);
          }
          if (ref.current) ref.current.innerHTML = "";
        };
      },
      [i18n]
    );
    if (failed[0]) return h(PageError, { error: failed[0] });
    return h("div", { className: CSS + "-page", ref: ref });
  }

  PluginApi.register.route(
    ROUTE,
    guarded(NetworkPage, function (error) {
      return h(PageError, { error: error });
    })
  );

  // Entry point for use outside Stash's UI (demo/ and the README screenshots); in Stash the route above
  // mounts the page. opts: {locale, history: {push, replace}}.
  window.SPNMount = function (root, opts) {
    opts = opts || {};
    return loadI18n(opts.locale).then(function (i18n) {
      var view = new NetworkView(root, opts.history || { push: function () {}, replace: function () {} }, i18n);
      view.start();
      return view;
    });
  };

  // The navbar entry is optional: if a library it needs is missing, the page stays reachable at ROUTE.
  var Nav = Bootstrap && Bootstrap.Nav;
  var Button = Bootstrap && Bootstrap.Button;
  var FA = PluginApi.libraries.FontAwesomeSolid || {};
  // FontAwesomeIcon directly, not PluginApi.components.Icon: that one can be patched by other plugins, and
  // a patch that returns nothing for our icon would break the entry. Stash's Icon only adds "fa-icon".
  var FontAwesomeIcon = PluginApi.libraries.ReactFontAwesome && PluginApi.libraries.ReactFontAwesome.FontAwesomeIcon;
  var icon = FA.faCircleNodes || FA.faProjectDiagram || FA.faShareNodes;

  // Same markup as Stash's own menu items (MainNavBar uses a LinkContainer around a Button, which ends
  // up as <a class="btn ...">); LinkContainer is not exposed to plugins, so Button renders as a Link.
  function NavItem() {
    var active = !!RRD.useRouteMatch({ path: ROUTE, exact: true });
    var i18n = useI18n();
    if (!i18n) return null;
    return h(
      Nav.Link,
      { eventKey: ROUTE, as: "div", className: "col-4 col-sm-3 col-md-2 col-lg-auto" },
      h(
        Button,
        {
          as: RRD.Link,
          to: ROUTE,
          className:
            "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center" +
            (active ? " active" : ""),
        },
        FontAwesomeIcon && icon ? h(FontAwesomeIcon, { icon: icon, className: "fa-icon nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0" }) : null,
        h("span", null, i18n.t("nav"))
      )
    );
  }

  var SafeNavItem = guarded(NavItem, function () {
    return null;
  });

  if (Nav && Button && RRD && RRD.Link && RRD.useRouteMatch && PluginApi.patch && PluginApi.patch.before) {
    PluginApi.patch.before("MainNavBar.MenuItems", function () {
      return Core.withChild(arguments, h(SafeNavItem, { key: PLUGIN_ID }), React.Children.toArray);
    });
  } else {
    console.warn(PLUGIN_ID + ": navbar entry not added, a library is missing; the page is at " + ROUTE);
  }

  // "Show in network" on the performer page, as the last item of the details panel (Stash passes the
  // panel's props, with performer, on to its DetailGroup).
  function PerformerButton(props) {
    var i18n = useI18n();
    var id = props.performer && props.performer.id;
    if (!i18n || id == null) return null;
    return h(
      "div",
      { className: "detail-item " + CSS + "-performer-link" },
      h(
        RRD.Link,
        { to: ROUTE + "?focus=" + encodeURIComponent(id), className: "btn btn-sm btn-secondary" },
        FontAwesomeIcon && icon ? h(FontAwesomeIcon, { icon: icon, className: "fa-icon mr-1" }) : null,
        h("span", null, i18n.t("showInNetwork"))
      )
    );
  }
  var SafePerformerButton = guarded(PerformerButton, function () {
    return null;
  });

  if (RRD && RRD.Link && PluginApi.patch && PluginApi.patch.before) {
    PluginApi.patch.before("PerformerDetailsPanel.DetailGroup", function () {
      var props = arguments[0];
      if (!props || !props.performer) return Array.prototype.slice.call(arguments);
      return Core.withChild(arguments, h(SafePerformerButton, { key: PLUGIN_ID, performer: props.performer }), React.Children.toArray);
    });
  }
})();
