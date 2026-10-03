# Contributing

Never use data or images from a real library in tests, demo, screenshots or issues. Test and demo data
are invented (`tests/fixture.js`, `demo/demo-data.js`).

## Demo

`demo/` runs the plugin page without Stash: a mock server (Node, no dependencies) with an invented
library (performers, studios, groups, galleries, tags) and generated placeholder images, answering
exactly the plugin's GraphQL requests.

```sh
node demo/server.js          # http://127.0.0.1:8790/  (?lang=de, fr, es or it for other languages)
```

The demo page stands in for Stash's UI (no navbar integration, a few Bootstrap styles in
`demo/harness.css`); it mounts the page through `window.SPNMount`.

## Tests

```sh
npm test                     # = scripts/test.sh = node --test tests/*.test.js  (Node 20+, no dependencies)
npm run vendor:check         # plugin/vendor/ matches the pinned packages (needs npm ci)
```

The tests cover the logic in `plugin/stash-performer-network-core.js` (graph building for both counting
modes, max performers, filters, shortest path with its tie rule, settings parsing, defaults and renamed
keys, URL parameters, face-data parsing, i18n), the locale files (keys, plural forms, placeholders, no
emoji) and the demo data. Logic that can be tested without a browser belongs in the core file (no
`document`, no `window`, no network); add a test there for every behaviour you change.

## Screenshots

```sh
node scripts/screenshots.mjs # screenshots of the demo into demo/screenshots/ (needs Chromium; CHROME=/path/to/chromium)
```

The script starts the demo server and drives headless Chromium; it fails on page errors.

## Measuring

`window.performerNetwork` exposes `timing` (data, layout, images), `faceProgress()` (nodes drawn with an
image and how many have one), `setDrawMode("dots" | "images" | null)` and `stopImages()`. The URL
parameter `?spnLayout=page` or `?spnLayout=worker` forces the layout on the page (vis-network) or in the
worker regardless of the network size, to compare both.

## Translations

See [docs/translating.md](docs/translating.md). `npm test` checks every file listed in
`plugin/locales/index.json`.

## Code layout

- `plugin/stash-performer-network-core.js` holds the logic without DOM or network access (data → graph,
  shortest path, settings, i18n, face-data format, icon paths); `stash-performer-network.js` holds the
  UI. Stash loads both in this order (see the `.yml`); there is no build step.
- Identifiers that depend on the plugin name are defined once: `PLUGIN_ID` in the core file, `ROUTE`,
  the CSS prefix and the IndexedDB name at the top of `stash-performer-network.js`.
- All settings are defined in one table (`SETTINGS` in the core file: key, type, default, label key,
  section). A new setting is one entry there plus one under `settings` in the `.yml` (Stash only shows
  settings declared there). If a stored key or value is renamed, keep reading the old one (see
  `legacyKeys` and `legacyValues`).
- Icons are small SVG paths in the core file (`ICONS`), drawn in `currentColor`; no emoji in code, CSS or
  texts.
- `window.performerNetwork` holds the current view (graph, timings, vis-network instance) for debugging
  in the browser console.

## Style

- No build step and no runtime dependencies besides the bundled libraries in `plugin/vendor/`. npm is
  only used to fetch those libraries (`npm run vendor`, see [docs/third-party.md](docs/third-party.md));
  the plugin itself never loads anything from `node_modules`.
- Code, comments and commit messages in English; UI texts only through the locale files.

## Versions

The version is in `plugin/stash-performer-network.yml` and `package.json`; changes are listed in
[CHANGELOG.md](CHANGELOG.md). Versions follow [Semantic Versioning](https://semver.org/): a patch release
for fixes, a minor release for new features, a major release only for changes that break existing
settings or behaviour.
