# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## 0.3.0 (3D view)

The 3D view from the beta is now part of the normal release.

- 3D view: the "3D" button next to the title (or `?view=3d`) shows the network in three dimensions; drag
  to turn, wheel or two fingers to zoom, right or Shift drag to move. Filters, rankings, search, paths,
  links and the detail panels work as in 2D.
- Performers as spheres, chips or flat discs with their face (setting "Performers in the 3D view"); all
  three cost the same.
- Cards for a hovered or tapped performer and for a hovered edge; a click on an edge opens its detail.
- The whole network is two draw calls; edges get fainter the more there are, a fog fades the back, and a
  large network starts at the favorites.
- In 3D the detail panel and the cards are slightly tilted, with glass and a shadow (no animation with
  reduced motion).
- Needs WebGL; without it there is no 3D button, and if WebGL fails the page returns to 2D.

Known: with thousands of performers the 3D picture is a dense cloud; filters or the reduced start view
help. Laying out 4,581 performers takes about 11 s. Above 8,000 edges, edges are picked on click only.
three.js (MIT) is bundled and loaded only for 3D.

## 0.2.0 (links, rankings, phones and years)

- Every view has a link: the copy button next to the gear puts the filters, the counting and the
  highlighted performer, edge or path into a URL. New URL parameters `focus`, `edge`, `path`, `fav`, `min`,
  `genders`, `from` and `to` ([settings.md](docs/settings.md#url-parameters)).
- "Show in network" on Stash's performer page opens the network with that performer highlighted.
- Rankings in the sidebar: the strongest pairs and the performers with the most partners in the shown
  network; a click opens the pair or the performer.
- From the network to Stash: "Their scenes together in Stash" on an edge, "Scenes in Stash" on a performer
  (Stash's scene list with a performer filter).
- Years: a from / to filter from the scene dates in the library, and "Together from ... to ..." on edges and
  partner cards.
- Phones and touch screens: the sidebar can be closed and opens over the network on narrow screens, the
  network fills the screen, the detail panel sits at the bottom, and "Path from here" finds a path
  without Ctrl/Cmd-click.
- Large libraries: scenes load in pages with progress in the status line, and the data for 19,500 scenes
  arrives in about 1.0 s instead of 1.3 to 1.5 s.
- When no performer matches the filters, the page says so instead of staying at "laying out".
- Clearer names and texts: "Crop without a face", "Minimum name size on screen (px)", the node size
  default under Defaults (stored settings stay as they are), real plural forms in all five languages.
- Screen readers: the network area is a labelled region and the status line is announced.

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
