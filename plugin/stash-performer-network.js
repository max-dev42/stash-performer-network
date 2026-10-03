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
  var GENDER_COLORS = Core.GENDER_COLORS, UNKNOWN = Core.UNKNOWN, I18n = Core.I18n, ICONS = Core.ICONS, ICON_BOX = Core.ICON_BOX;
  var byNumber = Core.byNumber, pairKey = Core.pairKey, localUrl = Core.localUrl, bytesHash = Core.bytesHash;
  var dims = Core.dims, boxToPixels = Core.boxToPixels, boxToNormal = Core.boxToNormal;
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
  var QUERY =
    "query PerformerNetwork {" +
    " findScenes(filter: {per_page: -1}) { scenes { id rating100 play_count o_counter" +
    "  performers { id } groups { group { id } } studio { id } } }" +
    " findPerformers(filter: {per_page: -1}) { performers { id name gender favorite rating100 o_counter image_path scene_count custom_fields } }" +
    " findGroups(filter: {per_page: -1}) { groups { id name } }" +
    " findStudios(filter: {per_page: -1}) { studios { id name parent_studio { id } } }" +
    " findTags(filter: {per_page: -1}) { tags { id name aliases } }" +
    ' genders: __type(name: "GenderEnum") { enumValues { name } }' +
    ' configuration { plugins(include: ["' + PLUGIN_ID + '"]) }' +
    "}";
  // in pages: one 5.3 MB answer cost a ~200 ms task (parsing and garbage collection) while faces were
  // detected; pages of TAG_PAGE scenes keep each step small
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
    if (name === "gear") path.setAttribute("fill-rule", "evenodd");
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
    return c.toDataURL("image/png");
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

  // Fallback: full-width square centred on the upper third.
  function upperThirdCrop(img) {
    var d = dims(img), w = d.w, ht = d.h;
    var side = Math.min(w, ht);
    var y = Math.max(0, Math.min(ht - side, ht / 3 - side / 2));
    return crop(img, (w - side) / 2, y, side);
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
      if (e.key === "Escape" && !self.modal && !e.defaultPrevented && !e.cancelBubble) self.clearMode();
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

  NetworkView.prototype.start = function () {
    var self = this;
    this.buildLayout();
    this.setStatus(this.t("loading"));
    Promise.all([gql(QUERY), loadScript(VENDOR + "vis-network/vis-network.min.js", "vis")])
      .then(function (res) {
        if (self.destroyed) return;
        self.timing.data = Math.round(performance.now() - self.timing.start);
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
    var f = this.f, st = this.settings, b = this.base, q;
    try {
      q = new URLSearchParams(location.search);
    } catch (e) {
      q = new URLSearchParams("");
    }
    function num(v, d, lo, hi) {
      var n = Number(v);
      return v != null && v !== "" && isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
    }
    var df = st.defaultFilters || {};
    f.countBy = readCountBy(st.defaultCountBy);
    f.maxCast = num(q.get("maxCast"), st.defaultMaxCast, 2, 40);
    f.favMode = ["partners", "only"].indexOf(q.get("favMode")) >= 0 ? q.get("favMode") : st.defaultFavMode;
    var size = Core.queryParam(q, "size");
    f.sizeBy = ["scenes", "orgasms"].indexOf(size) >= 0 ? size : st.nodeSizeBy;
    var studio = q.has("studio") ? q.get("studio") : df.studio || ""; // ?studio= (empty) = all studios
    f.studio = b.studios[studio] ? studio : "";
    var tags = q.get("tags") != null ? q.get("tags").split(",") : df.tags || [];
    f.tags = tags.map(String).filter(function (id, i, a) {
      return b.tags[id] && a.indexOf(id) === i;
    });
    f.tagMode = (q.get("tagMode") || df.tagMode) === "all" ? "all" : "any";
    f.sceneStars = num(q.get("sceneStars"), num(df.sceneStars, 0, 0, 5), 0, 5);
    f.perfStars = num(q.get("perfStars"), num(df.perfStars, 0, 0, 5), 0, 5);
    f.watchedOnly = q.get("watched") != null ? q.get("watched") === "1" : !!df.watchedOnly;
    var orgasms = Core.queryParam(q, "orgasms");
    f.orgasmOnly = orgasms != null ? orgasms === "1" : !!df.orgasmOnly;
    this.showAll = q.get("all") === "1"; // no reduced start view (see Core.limitGraph)
    // comparing and measuring: ?spnLayout=page (vis-network on the page) or worker, regardless of size
    this.layoutMode = ["page", "worker"].indexOf(q.get("spnLayout")) >= 0 ? q.get("spnLayout") : null;
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
    this.canvas = el("div", { class: CSS + "-canvas" });
    // status line: the note on a reduced start view (with "Show all") and the status text
    this.limitBox = el("span", { class: CSS + "-limit", hidden: "" });
    this.statusText = el("span", { class: CSS + "-status-text" });
    this.statusLine = el("div", { class: CSS + "-status" }, [this.limitBox, this.statusText]);
    this.detail = el("div", { class: CSS + "-detail", hidden: "" });
    this.card = el("div", { class: CSS + "-card", hidden: "" });
    this.root.appendChild(this.sidebar);
    this.root.appendChild(el("div", { class: CSS + "-main" }, [this.canvas, this.detail, this.card, this.statusLine]));
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
    var collator = new Intl.Collator(this.i18n.locale);
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
        el("button", {
          type: "button", class: "btn btn-sm btn-secondary " + CSS + "-gear", id: CSS + "-settings-open",
          title: t("settings"), "aria-label": t("settings"), "aria-haspopup": "dialog",
          onclick: function () { self.openSettings(); },
        }, [svgIcon("gear")]),
      ])
    );
    s.appendChild(el("div", { class: CSS + "-field" }, [el("label", { for: CSS + "-search", text: t("searchLabel") }), search, pathTo, names, searchMsg]));
    s.appendChild(el("div", { class: CSS + "-field" }, [el("label", { for: CSS + "-studio", text: t("studio") }), select]));
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
    // performer orgasm count: Stash's performer.o_counter (sum over the performer's scenes and images)
    var perfWithOrgasm = Object.keys(b.performers).filter(function (id) { return b.performers[id].o_counter > 0; }).length;
    var perfOrgasmPartners = checkbox(CSS + "-perf-orgasm-partners", t("plusPartners"), f.perfOrgasmPartners, function (v) { f.perfOrgasmPartners = v; });
    function syncPerfOrgasmPartners() {
      perfOrgasmPartners.querySelector("input").disabled = !f.perfOrgasm || !perfWithOrgasm;
    }
    activity.appendChild(
      disable(el("div", null, [
        checkbox(CSS + "-perf-orgasm", t("performerOrgasm"), f.perfOrgasm, function (v) { f.perfOrgasm = v; syncPerfOrgasmPartners(); }),
        el("div", { class: CSS + "-sub" }, [perfOrgasmPartners]),
      ]), perfWithOrgasm ? null : t("noOrgasmCounts"))
    );
    syncPerfOrgasmPartners();
    activity.appendChild(
      disable(el("div", null, [
        el("span", { class: CSS + "-label", text: t("sizeBy") }),
        el("div", { class: CSS + "-sub" }, [
          radio(CSS + "-sizeby", CSS + "-size-scenes", t("sizeScenes"), f.sizeBy === "scenes", function () { f.sizeBy = "scenes"; self.draw(); }),
          radio(CSS + "-sizeby", CSS + "-size-orgasms", t("sizeOrgasm"), f.sizeBy === "orgasms", function () { f.sizeBy = "orgasms"; self.draw(); }),
        ]),
      ]), perfWithOrgasm ? null : t("noOrgasmCounts"))
    );
    activity.appendChild(disable(el("div", null, [checkbox(CSS + "-edge-orgasm", t("edgeByOrgasm"), f.edgeByOrgasm, function (v) { f.edgeByOrgasm = v; })]), withOrgasm ? null : t("noOrgasmCounts")));
    activity.appendChild(
      el("div", { class: CSS + "-hint", text: t("activityCounts", { rated: ratedScenes, watched: watched, orgasm: withOrgasm, performers: ratedPerformers, perfOrgasm: perfWithOrgasm }) })
    );
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
    if (inWorker && !this.layoutInWorker()) {
      this.network.setOptions({ physics: { enabled: true } });
      this.network.stabilize(P.iterations);
    }
    this.setStatus(
      [this.t("statusPeople", { count: this.graph.nodes.length }), this.t("statusEdges", { count: this.graph.edges.length }), this.t("layouting")].join(" · ")
    );
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

  // Node opacity is read by drawNode (nodeAlpha); only edges whose look actually changes are updated
  // (state remembered in edgeLook).
  NetworkView.prototype.emphasize = function (keep) {
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
    if (this.network) this.network.unselectAll();
    if (this.nodes) this.emphasize(null);
    this.closeDetail();
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
    this.mode = { kind: "path", nodes: path };
    this.network.selectNodes(path, false);
    this.emphasize({ nodes: nodes, edges: edges, accent: accent, color: PATH_COLOR });
    this.network.fit({ nodes: path, animation: { duration: 600, easingFunction: "easeInOutQuad" } });
    this.showPathDetail(path);
    return true;
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
      grid.appendChild(self.tile("/scenes/" + sc.id, sc.screenshot, sc.title, self.i18n.date(sc.date), "scene", groupLink));
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

  NetworkView.prototype.showEdgeDetail = function (edgeId) {
    var e = this.edgeIndex[edgeId];
    if (!e) return;
    var a = this.base.performers[e.from], b = this.base.performers[e.to];
    this.openDetail(el("strong", null, [this.link("/performers/" + a.id, a.name), " & ", this.link("/performers/" + b.id, b.name)]), [
      el("div", { class: CSS + "-hint", text: this.sharedSummary(e) }),
      this.unitList(e, edgeId),
    ]);
  };

  NetworkView.prototype.showNodeDetail = function (pid) {
    var self = this, t = this.t.bind(this);
    var p = this.base.performers[pid];
    var nb = this.graph.neighbours[pid] || {};
    var n = this.graph.scenesPerPerformer[pid] || 0;
    var partners = Object.keys(nb).sort(function (x, y) {
      return nb[y] - nb[x] || self.base.performers[x].name.localeCompare(self.base.performers[y].name);
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
      el("div", { class: CSS + "-actions" }, [
        el("a", {
          class: "btn btn-sm btn-primary",
          href: "/performers/" + pid,
          text: t("openPage"),
          onclick: function (ev) {
            if (ev.ctrlKey || ev.metaKey || ev.button !== 0) return;
            ev.preventDefault();
            self.history.push("/performers/" + pid);
          },
        }),
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
  // the upper third. Finished crops are drawn together, in one redraw at most every IMAGE_REDRAW_MS.
  var IMAGE_REDRAW_MS = 500;
  NetworkView.prototype.setImage = function (pid, pic, kind, url) {
    var self = this;
    this.pics[pid] = pic;
    this.images[pid] = { kind: kind, url: url || null, canvas: url ? null : pic };
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
  // With "use face crops" off, images are only cropped square (upper third): no cache, no MediaPipe.
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
    this.timing.images = { total: Object.keys(items).length, cached: 0, shared: 0, detected: 0, face: 0, fallback: 0, plain: 0, failed: 0 };
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
      var v = stored[o.key];
      if (v && !(redetect === "missing" && !o.shared)) {
        m.cached++;
        // detected here earlier but not (yet) stored on the performer: share it now
        if (v.h && (!o.shared || o.shared.h !== v.h)) self.queueFaceWrite(o.pid, { v: FACE_VERSION, h: v.h, b: v.b || null });
        return loadImage(v.url).then(function (img) {
          if (current()) self.setImage(o.pid, img, v.kind, v.url);
        });
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
          if (o.shared && res.hash && o.shared.h === res.hash) {
            m.shared++;
            return self.finishImage(o, img, o.shared.b, res.hash, true);
          }
          // while MediaPipe is still loading, show the upper third meanwhile
          if (!self.detectorReady && !self.pics[o.pid]) self.setImage(o.pid, upperThirdCrop(img), "fallback");
          return self.getDetector().then(function (d) {
            if (!current() || !d) return closeImage(img); // no detector: keep the fallback, nothing cached or shared
            self.quiet(true);
            m.detected++;
            var largest = null;
            (d.detect(img).detections || []).forEach(function (det) {
              var bb = det.boundingBox;
              if (bb && (!largest || bb.width * bb.height > largest.width * largest.height)) largest = bb;
            });
            return self.finishImage(o, img, largest ? boxToNormal(img, largest) : null, res.hash, false);
          });
        });
    });
  };

  NetworkView.prototype.finishImage = function (o, img, box, hash, viaShared) {
    var m = this.timing.images;
    if (this.plain) {
      m.plain++;
      this.setImage(o.pid, upperThirdCrop(img), "plain");
      return closeImage(img);
    }
    var pic = box ? faceCrop(img, boxToPixels(img, box)) : upperThirdCrop(img);
    var kind = box ? "face" : "fallback";
    m[kind]++;
    closeImage(img);
    var url = toUrl(pic);
    this.setImage(o.pid, pic, kind, url);
    if (!viaShared && hash) this.queueFaceWrite(o.pid, { v: FACE_VERSION, h: hash, b: box });
    return Cache.put(o.key, { url: url, kind: kind, h: hash, b: box }); // h and b kept so a later visit can still share it
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
          if (st.disableFaceCrops !== before.disableFaceCrops) self.prepareImages();
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

  function NetworkPage() {
    var ref = React.useRef(null);
    var history = RRD.useHistory();
    var i18n = useI18n();
    React.useEffect(
      function () {
        if (!i18n) return;
        document.title = i18n.t("title") + " | Stash";
        var view = new NetworkView(ref.current, history, i18n);
        view.start();
        return function () {
          view.destroy();
          if (ref.current) ref.current.innerHTML = "";
        };
      },
      [i18n]
    );
    return h("div", { className: CSS + "-page", ref: ref });
  }

  PluginApi.register.route(ROUTE, NetworkPage);

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

  var Nav = Bootstrap.Nav;
  var Button = Bootstrap.Button;
  var FA = PluginApi.libraries.FontAwesomeSolid;
  var Icon = PluginApi.components && PluginApi.components.Icon;
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
        Icon && icon ? h(Icon, { icon: icon, className: "nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0" }) : null,
        h("span", null, i18n.t("nav"))
      )
    );
  }

  PluginApi.patch.before("MainNavBar.MenuItems", function (props) {
    var item = h(NavItem, { key: PLUGIN_ID });
    return [Object.assign({}, props, { children: React.Children.toArray(props.children).concat([item]) })];
  });
})();
