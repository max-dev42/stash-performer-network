# Settings and URL parameters

The gear button next to the page title opens the settings dialog (keyboard accessible, Esc closes).
Settings are stored in Stash's plugin settings, so they are the same on every device and also appear in
Stash under Settings → Plugins → Performer Network.

## Settings

| Section | Setting in the dialog | Stash key and type | Default |
|---|---|---|---|
| Faces | Store face positions on performers ([faces.md](faces.md)) | `storeFaces`, boolean: `true` = store | `false` (see [faces.md](faces.md#default)) |
| Faces | Use face crops | `disableFaceCrops`, boolean: `true` = face crops **off** (crop as in `fallbackCrop`, MediaPipe not loaded, nothing stored) | `false` (face crops on) |
| Faces | Without a face ([faces.md](faces.md#without-a-face)) | `fallbackCrop`, string: `auto`, `top`, `upperThird` or `center` | `auto` |
| Display | Node size by | `nodeSizeBy`, string: `scenes` or `orgasms` | `scenes` |
| Display | Names from zoom level (on-screen label size in px, 0 = always) | `labelZoom`, number 0 to 24 | `8` |
| Display | Large networks start with at most this many performers (see below) | `startLimit`, number 50 to 10000 (0 = default) | `400` |
| Display | Colours per gender (colour picker, reset) | `genderColors`, JSON string, e.g. `{"FEMALE": "#e0559a"}` | built-in colours |
| Defaults | Count edge strength by | `defaultCountBy`, string: `scenes` or `productions` | `scenes` |
| Defaults | Max. performers per scene / production | `defaultMaxCast`, number 2 to 40 (0 = default) | `12` |
| Defaults | Favorites filter mode | `defaultFavMode`, string: `partners` or `only` | `partners` |
| Defaults | Filters when the page opens ("Use current filters") | `defaultFilters`, JSON string with `studio`, `tags`, `tagMode`, `sceneStars`, `perfStars`, `watchedOnly`, `orgasmOnly` | none |

Why `disableFaceCrops` and not `useFaceCrops`: Stash shows a boolean that was never saved as off, so a
setting whose default is "on" is stored as its negative. The dialog shows the positive wording ("Use
face crops", checked by default); in Stash's own plugin settings page the same switch appears as "Do not
use face crops", unchecked by default.

The Faces section also has actions that are not settings: clear the face cache of this browser, and
re-detect faces for performers without stored face data ("missing only") or for everyone ("all", asks
for confirmation because with storing on it updates every performer).

Details:

- `storeFaces` is always written explicitly when the dialog saves, so an explicit "off" is kept.
- Invalid or missing values fall back to the default (also 0 for `defaultMaxCast`, which Stash shows
  when the value is unset).
- Stash's plugin settings are replaced as a whole when saved; the dialog always sends the complete set
  (values equal to the default are left out).
- Renamed values are still read: `nodeSizeBy` = `o` is read as `orgasms`, and `oOnly` inside
  `defaultFilters` as `orgasmOnly` when `orgasmOnly` is not stored. Saving the dialog writes the new
  names.

## Reduced start view for large networks

If the current selection has more performers than `startLimit`, the page starts with a reduced view
of that many performers, so that layout and drawing stay fast:

- with favorites in the network: the favorites (if there are more than the limit, the most connected
  ones), then each favorite's strongest partner, filled up with the partners that have the strongest
  ties to favorites (summed edge strength);
- without favorites: the most connected performers (number of partners, then summed edge strength).

Only edges among the shown performers are drawn; a performer left without any of them is left out. The
status line says how many of how many performers are shown and offers "Show all (slow)", which holds
until the page is left (and puts `?all=1` into the URL); "Show reduced view" in the same place goes back. Searching for a performer outside the reduced
view says so. Paths are searched within the shown network.

## URL parameters

Defaults apply when the page is opened. URL parameters override them for that view, e.g.
`/performer-network?count=productions&studio=3`.

| Parameter | Values |
|---|---|
| `count` | `scenes` or `productions` |
| `maxCast` | 2 to 40 |
| `favMode` | `partners` or `only` |
| `size` | `scenes` or `orgasms` (`o` is still accepted) |
| `studio` | studio id; empty = all studios |
| `tags` | tag ids, comma-separated |
| `tagMode` | `any` or `all` |
| `sceneStars`, `perfStars` | 0 to 5 |
| `watched` | `1` = only watched scenes |
| `orgasms` | `1` = only scenes with an orgasm count (`o=1` is still accepted) |
| `all` | `1` = no reduced start view, every performer of the selection (as after "Show all") |
