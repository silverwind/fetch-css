# fetch-css
[![](https://img.shields.io/npm/v/fetch-css.svg?style=flat)](https://www.npmjs.org/package/fetch-css) [![](https://img.shields.io/npm/dm/fetch-css.svg)](https://www.npmjs.org/package/fetch-css)
> Extract CSS from websites and browser extensions

## Usage

```console
npm i fetch-css
```
```js
import fetchCss from "fetch-css";

// retrieve CSS of a website
const [{css}] = await fetchCss([{url: "https://example.com"}]);

// extract CSS from a Chrome extension
const [{css}] = await fetchCss([{crx: "hlepfoohegkhhmjieoechaddaejaokhf"}]);
```

## API
### `fetchCss(sources)`

- `sources`: *Array* Array of source objects
  - `source`: *Object*
    - `url`: *string* An absolute URL pointing to either a website or directly to a CSS or JS file (to extract inlined CSS strings from)
    - `fetchOpts`: *Object* Options passed to [fetch](https://github.com/npm/make-fetch-happen#fetch)
    - `crx`: *string* A Chrome extension id
    - `contentScriptsOnly`: *boolean* Whether to pull only content scripts from a extension. Default: `false`
    - `strict`: *boolean* Whether to throw an error if fetch fails. Default: `false`

Returns a `Promise` that resolves to a `sources` array with additional `css` properties present on each source.

## Related

- [remap-css](https://github.com/silverwind/remap-css) - Remap CSS rules based on declaration value

© [silverwind](https://github.com/silverwind), distributed under BSD licence
