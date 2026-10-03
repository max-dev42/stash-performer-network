# Bundled third-party code

All libraries are bundled in `plugin/vendor/` (no CDN) and loaded from the plugin's asset path
(`/plugin/stash-performer-network/assets/vendor/…`) only when the network page is opened. All files are
unmodified copies from the npm registry, except the face model (see below).

| Path | Package | Version | License |
|---|---|---|---|
| `plugin/vendor/vis-network/vis-network.min.js` | `vis-network` (`standalone/umd`) | 10.1.2 | Apache-2.0 OR MIT (`LICENSE-APACHE-2.0`, `LICENSE-MIT`) |
| `plugin/vendor/mediapipe/vision_bundle.js`, `vision_wasm_internal.js`, `vision_wasm_internal.wasm`, `package.json` | `@mediapipe/tasks-vision` | 1.0.1 | Apache-2.0 (`LICENSE`) |
| `plugin/vendor/mediapipe/blaze_face_short_range.tflite` | MediaPipe face detector model, float16 | 1 | Apache-2.0 |

The npm package of `@mediapipe/tasks-vision` ships no license file and no model. `LICENSE` in
`vendor/mediapipe/` is the Apache License 2.0 text. The model is not on npm; it was downloaded from
MediaPipe's model storage
(`https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite`)
and checked against the MD5 published there (`o91uwxclKQdwuXzsDL+UyQ==`). Only the SIMD WASM build is
bundled (all current browsers support WASM SIMD).

## Checksums (SHA-256)

```
fc674cfa6cceb27a3b40ff4ea75c204a2d8570fb39b9a627127cf7039e141ad4  vis-network/vis-network.min.js
98db72469ffb176f5e9f2687be0f70783893aca681f7789c34b872b0a764371a  mediapipe/vision_bundle.js
e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73  mediapipe/vision_wasm_internal.js
8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886  mediapipe/vision_wasm_internal.wasm
b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f  mediapipe/blaze_face_short_range.tflite
```

Check them with `cd plugin/vendor && sha256sum -c` and the lines above.

## Updating a library

The versions are pinned in `package.json`; Dependabot opens a pull request for new releases.

1. Change the version in `package.json` (or check out the Dependabot branch).
2. `npm ci`, then `npm run vendor` to copy the files into `plugin/vendor/`.
3. Update the table and the checksums above.

CI runs `npm run vendor:check`, which fails while `plugin/vendor/` differs from the packages.
