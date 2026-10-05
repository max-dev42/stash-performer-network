// Copies the bundled libraries from node_modules into plugin/vendor/.
// The versions come from package.json (kept current by Dependabot).
//   node scripts/vendor.mjs          copy
//   node scripts/vendor.mjs --check  fail if plugin/vendor/ differs from node_modules
// The face model and vendor/mediapipe/LICENSE are not on npm and are not touched here.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = [
  ["vis-network/standalone/umd/vis-network.min.js", "vis-network/vis-network.min.js"],
  ["vis-network/LICENSE-APACHE-2.0", "vis-network/LICENSE-APACHE-2.0"],
  ["vis-network/LICENSE-MIT", "vis-network/LICENSE-MIT"],
  ["@mediapipe/tasks-vision/vision_bundle.js", "mediapipe/vision_bundle.js"],
  ["@mediapipe/tasks-vision/wasm/vision_wasm_internal.js", "mediapipe/vision_wasm_internal.js"],
  ["@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm", "mediapipe/vision_wasm_internal.wasm"],
  ["@mediapipe/tasks-vision/package.json", "mediapipe/package.json"],
  // three.js for the 3D view (beta): the ES module build, loaded with import() only when 3D is opened;
  // three.module.js imports ./three.core.js from the same folder
  ["three/build/three.module.js", "three/three.module.js"],
  ["three/build/three.core.js", "three/three.core.js"],
  ["three/LICENSE", "three/LICENSE"],
];

const check = process.argv.includes("--check");
let stale = 0;
for (const [from, to] of FILES) {
  const src = join(root, "node_modules", from);
  const dest = join(root, "plugin", "vendor", to);
  if (!existsSync(src)) {
    console.error(`missing ${src} (run npm ci first)`);
    process.exit(2);
  }
  const data = readFileSync(src);
  const same = existsSync(dest) && readFileSync(dest).equals(data);
  if (same) continue;
  if (check) {
    console.error(`out of date: plugin/vendor/${to}`);
    stale++;
  } else {
    writeFileSync(dest, data);
    console.log(`updated plugin/vendor/${to}`);
  }
}
if (stale) {
  console.error("Run `npm run vendor` and commit plugin/vendor/ (and update the table in README.md).");
  process.exit(1);
}
