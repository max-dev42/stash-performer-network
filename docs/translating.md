# Translating

Available: English (`en`), German (`de`), French (`fr`), Spanish (`es`), Italian (`it`).

The language follows Stash's interface language (Settings → Interface → Language), then
`navigator.language`, then English. Texts live in `plugin/locales/<code>.json` and are loaded at runtime
from the plugin's asset path. A key missing in a translation falls back to the English text. Numbers and
dates are formatted with `Intl` in the chosen locale.

## Adding a language

1. Copy `plugin/locales/en.json` to `plugin/locales/<code>.json`, where `<code>` is a language (`nl`) or
   a full locale (`pt-BR`). A full locale is tried first, then its language part.
2. Translate the values; keep the keys and the `{placeholders}` unchanged. Use the terms of Stash's own
   interface in that language where it has them.
3. Plural forms: keys ending in `_one`, `_other` etc. are chosen with `Intl.PluralRules` from the
   `{count}` parameter. Give every plural key exactly the categories your language has; for example
   French, Spanish and Italian also need `_many` (used for numbers like 1,000,000). To list them:
   `node -p 'new Intl.PluralRules("fr").resolvedOptions().pluralCategories'`.
4. Add the code to `plugin/locales/index.json`. Only listed codes are requested, so a missing
   translation never causes a 404.
5. Run `npm test`: it checks that every translation has all keys, the plural categories of its language
   and the same placeholders as `en.json`. Then reload plugins in Stash, or look at the demo with
   `?lang=<code>` (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

Texts contain no emoji; icons are drawn by the plugin.
