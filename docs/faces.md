# Face crops and privacy

## How faces are found

Nodes that are small on screen are drawn as dots in the gender colour. From a radius of 8 pixels on
screen a node shows its image: coloured initials first, a square crop of the performer image as soon as
it has loaded (see [Without a face](#without-a-face)), and then a face crop once face detection has run. With more than 800 such
nodes in view, the 800 largest show their image and the others stay dots until you zoom in. Detection happens **in the
browser** with MediaPipe's BlazeFace (short range) model, bundled with the plugin; there is no server
component and no request leaves the Stash origin.

- The largest detected face is cropped square with some margin and scaled to 160×160.
- Tall images (height more than 1.5 times the width, such as full-body photos in 1:2) get a second
  attempt when the whole image shows no face: the detector sees its input at 128×128 pixels, where the
  small face of a full-body photo is often too small to be found. The top square of the image (for 1:2
  the upper half) is then detected again on its own, scaled to that size, and the face box is converted
  back to the whole image.
- No face found: the fallback crop stays. Performers without an image keep their initials.
- Results are cached in this browser's IndexedDB (`stash-performer-network-faces`), keyed by performer
  id and the image timestamp, so only new or changed images are processed again.
- Only performers whose node is drawn with an image are processed, the largest on screen first, four
  images at a time during idle time; zooming in or panning brings the next ones. The network is usable
  immediately, and new crops are drawn together, at most every half second.
- MediaPipe prints status lines while it runs; the plugin drops exactly those lines while faces are
  processed. Errors pass through.
- With "Use face crops" switched off ([settings.md](settings.md)), MediaPipe is not loaded at all and
  every node shows the fallback crop.

### Without a face

When no face is found, and for every node with face crops switched off, the node shows a square as wide
as the image. The setting "Without a face" (`fallbackCrop`, [settings.md](settings.md)) decides where:

| Value | Square |
|---|---|
| `auto` (default) | `top` for tall images (height more than 1.5 times the width, such as full-body photos in 1:2), else `upperThird` |
| `top` | from 2 % of the height below the top edge |
| `upperThird` | centred on the upper third (the only behaviour up to 0.1.0) |
| `center` | centred |

For images wider than high the square is as high as the image and centred horizontally. A changed value
crops the cached images again; faces are not detected again for that.

### No requests to other hosts

MediaPipe's tasks-vision library sends usage statistics to `odml.pa.googleapis.com` (every 60 seconds
while the detector is loaded) and has no option to switch that off. The plugin does not change the
bundled file; instead, before MediaPipe is loaded, it wraps `fetch`, `XMLHttpRequest` and
`navigator.sendBeacon` and refuses every request that leaves the Stash origin and comes from the bundled
MediaPipe code. The browser console shows one info line per refused host. Stash's own CSP would block
the request as well; the guard makes sure nothing is sent even where no CSP applies (for example behind
a proxy that drops the header, or in the demo).

The guard exists only as long as the detector: 10 seconds after the last image was processed, the
detector is closed (its last report is refused) and the original functions are put back; when faces are
needed again, both are set up again. Requests to the Stash origin are passed on before anything else is
looked at, and requests of other code are never refused.

## What is stored, and only when switched on

By default nothing leaves the browser: the crops stay in the local cache.

With the setting "Store face positions on performers" (`storeFaces`), the result of the detection is
also stored on the performer as custom field `spn_face`, a JSON string:

```json
{"v": "mp-tv1.0.1-bfsr2", "h": "1a2b3c4d:20480", "b": [0.35, 0.12, 0.25, 0.17]}
```

`v` is the detector version, `h` a checksum of the image file (FNV-1a and byte length), `b` the face box
as fractions of the image (x, y, width, height), or `null` when no face was found. Another browser or
device that finds a matching checksum crops the face directly and does not load MediaPipe; a changed
image or a new detector version leads to a new detection.

### Update from 0.1.0

0.1.1 adds the second attempt on tall images and with it the detector version `mp-tv1.0.1-bfsr2`
(0.1.0 wrote `mp-tv1.0.1-bfsr1`). Results of 0.1.0 are still used where the new version would find the
same: every found face, and "no face" for images that are not tall. Only tall images without a face are
detected once more, in the local cache and in `spn_face` alike; with storing on, those performers get the
new result (and with it a new `updated_at`) once.

- Only these numbers are stored: no image data and nothing that identifies a person.
- The plugin sends only `custom_fields` as a partial update (`performerUpdate`), in batches of up to 10
  performers per request. Stash itself still sets the performer's `updated_at` on every update, so the
  first run touches `updated_at` of every performer with an image (once; later visits find the data
  and do not write again).
- Reading existing `spn_face` data is always on.
- `?spnFaceWrite=dry` on the page URL counts what would be written without writing
  (`window.performerNetwork.dryWrites`).

### Default

Storing is off for new installations. A library in which performers already carry `spn_face` data
(written by a pre-release version, where storing was on by default) keeps storing until the setting is
saved once; the settings dialog says so. An explicit value of the earlier key `disableFaceWriteback` is
honoured as well.

## Content Security Policy

Running the WASM face detector needs the page's CSP to allow WebAssembly compilation (`'unsafe-eval'` or
`'wasm-unsafe-eval'` in `script-src`); the CSP header sent by Stash v0.31.1 contains `'unsafe-eval'`. If
WASM is blocked, the plugin logs one warning and keeps the fallback crops.
