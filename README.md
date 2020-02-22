# fetch-css
[![](https://img.shields.io/npm/v/fetch-css.svg?style=flat)](https://www.npmjs.org/package/fetch-css) [![](https://img.shields.io/npm/dm/fetch-css.svg)](https://www.npmjs.org/package/fetch-css) [![](https://api.travis-ci.org/silverwind/fetch-css.svg?style=flat)](https://travis-ci.org/silverwind/fetch-css)
> Extract CSS from websites and browser extensions

## Usage

```console
npm i fetch-css
```

```js
const fetchCss = require("fetch-css");

// retrieve CSS of a website
const [{css}] = await fetchCss([{url: "https://google.com"}]);

// extract CSS from a Chrome extension
const [{css}] = await fetchCss([{crx: "hlepfoohegkhhmjieoechaddaejaokhf"}]);
```

## API

### `fetchCss(sources)`

- `sources`: *Array* Array of source objects
  - `source`: *Object*
    - `url`: *string* An absolute URL pointing to either a website or directly to a CSS file
    - `fetchOpts`: *Object* Options passed to [fetch](https://github.com/npm/make-fetch-happen#fetch)
    - `crx`: *string* A Chrome extension id
    - `contentScriptsOnly`: *boolean* Whether to pull only content scripts from a extension. Default: `false`

Returns a promise that resolves to a `sources` object with additional `css` properties present.

© [silverwind](https://github.com/silverwind), distributed under BSD licence
