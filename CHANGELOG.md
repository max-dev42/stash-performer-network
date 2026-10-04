# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.2 (no more black screen)

- An error in the plugin, or another plugin clashing with it, no longer leaves the whole Stash UI black
  (reported as React error #152). The navbar entry then just disappears, and the network page shows a
  short error text instead of an empty page.
- The navbar icon no longer goes through Stash's patchable Icon component, so another plugin's Icon
  patch cannot break the entry.
- The plugin loads only once, even if it is installed twice, and the navbar entry no longer needs every
  UI library to be present: without one, the page is still reachable at `/performer-network`.

## 0.1.1 (tall performer images)

- Tall performer images (more than 1.5 times as high as wide, such as full-body photos in 1:2) no longer
  lose the head in the circle: without a face the square is taken from the top instead of the upper
  third. New setting "Without a face" (`fallbackCrop`: auto, top, upperThird, center).
- Faces in tall images are found more often: when the whole image shows none, the top square is
  searched again on its own. In a test library 10 of 10 images in 1:2 and 1:2.5 got a face, 5 before.
- Detector version `mp-tv1.0.1-bfsr2`. Earlier results stay valid; only tall images without a face are
  detected once more (with storing on, those performers are written once more).

## 0.1.0 (first public release)

- Network page (`/performer-network`) with a navbar entry: performers as nodes with face crops, shared
  scenes as edges, live from Stash's GraphQL API.
- Edge strength counted by shared scenes or by productions (groups); cast limit per scene/production.
- Highlight a performer's network, hover cards, shortest path between two performers, edge detail with
  the shared scenes and image sets as tiles.
- Filters: studio or network, scene tags (any/all), edge strength, favorites, gender, ratings, watched
  scenes, orgasm count; node size and edge colour by orgasm count.
- Face crops detected in the browser (MediaPipe); storing face positions on performers is optional and
  off by default.
- Settings dialog backed by Stash's plugin settings; URL parameters for a view.
- Languages: English, German, French, Spanish, Italian.
- Bundled vis-network and MediaPipe, no CDN; inline SVG icons.
- No request leaves the Stash origin: the usage statistics the bundled MediaPipe library sends to Google
  are refused in the browser (one console info line), also where no CSP would stop them.
- Faster loading of large libraries: the main query fetches each performer once and only the fields the
  network needs (29.6 MB → about 3.5 MB for 19,500 scenes); scene tags load in the background, scene
  titles, screenshots and galleries when an edge is opened.
- Large networks start reduced (setting "Large networks start with at most this many performers",
  default 400): favorites with their strongest partners, or the most connected performers; the status
  line says so and offers "Show all (slow)" (also `?all=1`) and, after that, "Show reduced view".
- Nodes drawn by zoom level: dots when small on screen, images and names when zoomed in; images and
  face detection only for nodes drawn with an image, largest first, applied in one redraw at most every
  half second.
- Layout of large networks (150 performers and more) in a Web Worker; smaller networks are laid out by
  vis-network in batches sized by the measured time per step. Showing all 4,581 performers of a test
  library took 23 s in ~750 ms blocks and now about 9 s without blocking the page.
