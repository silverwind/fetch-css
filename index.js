"use strict";

const acorn = require("acorn");
const clone = require("rfdc")();
const postcss = require("postcss");
const fetch = require("fetch-enhanced")(require("node-fetch"));
const parse5 = require("parse5");
const unzipper = require("unzipper");
const urlToolkit = require("url-toolkit");
const {name} = require("./package.json");
const crxToZip = require("./crx-to-zip");

async function extract(res) {
  const styleUrls = [];
  const styleTags = [];
  const html = await res.text();

  for (const href of extractStyleHrefs(html)) {
    styleUrls.push(urlToolkit.buildAbsoluteURL(res.url, href));
  }
  for (const style of extractStyleTags(html)) {
    styleTags.push(style);
  }

  return [styleUrls, styleTags];
}

function validateStatus(res, url, strict) {
  if (res.status === 200) return true;
  const msg = `Failed to fetch ${url}: ${res.status} ${res.statusText}`;
  if (strict) {
    throw new Error(msg);
  } else {
    console.warn(`(${name}) Warning: ${msg}`);
  }
}

function extractStyleHrefs(html) {
  return (html.match(/<link.+?>/g) || []).map(link => {
    const attrs = {};
    for (const attr of parse5.parseFragment(link).childNodes[0].attrs) {
      attrs[attr.name] = attr.value;
    }
    if (attrs.href && attrs.rel === "stylesheet") return attrs.href;
    if (attrs.href && /\.css$/i.test(attrs.href.replace(/\?.+/))) return attrs.href;
  }).filter(link => !!link);
}

function extractStyleTags(html) {
  const matches = Array.from((html || "").matchAll(/<style.*?>([\s\S]*?)<\/style>/g) || []);
  return matches.map(match => match[1]).map(css => css.trim()).filter(css => !!css);
}

function isValidCSS(string) {
  try {
    const root = postcss.parse(string);
    if (root && root.type === "root" && Array.isArray(root.nodes) && root.nodes.length >= 1 && root.nodes.every(node => node.type === "rule")) {
      return true;
    }
  } catch {}
  return false;
}

function extractCssFromJs(js) {
  let css = "";

  acorn.parse(js, {
    ecmaVersion: "latest",
    onToken: token => {
      if (token.type.label === "string") {
        const str = token.value.trim()
          .replace(/\n/gm, "")
          .replace(/^\);}/, ""); // this is probably not universal to webpack's css-in-js strings

        if (str.length > 25 && isValidCSS(str)) { // hackish treshold to ignore short strings that may be valid CSS,
          css += `${str}\n`;
        }
      }
    }
  });

  return css.trim();
}

async function extensionCss({crx, contentScriptsOnly, strict}) {
  let url = `https://clients2.google.com/service/update2/crx`;
  url += `?response=redirect`;
  url += `&os=linux`;
  url += `&arch=x86-64`;
  url += `&os_arch=x86-64`;
  url += `&acceptformat=crx3`;
  url += `&prod=chromiumcrx`;
  url += `&prodchannel=unknown`;
  url += `&prodversion=9999.0.9999.0`;
  url += `&x=id%3D${crx}`;
  url += `%26uc`;

  const res = await fetch(url);
  validateStatus(res, url, strict);

  const crxBuffer = await res.buffer();
  const zipBuffer = Buffer.from(crxToZip(crxBuffer));

  const files = {};
  for (const file of (await unzipper.Open.buffer(zipBuffer) || {}).files) {
    files[file.path] = file;
  }

  if (!files["manifest.json"]) {
    throw new Error(`manifest.json not found in extension ${crx}`);
  }

  let cssFiles = [];
  let jsFiles = [];

  if (!contentScriptsOnly) {
    for (const path of Object.keys(files)) {
      if (path.endsWith(".css")) cssFiles.push(path);
      if (path.endsWith(".js")) jsFiles.push(path);
    }
  }

  const manifest = JSON.parse(String(await files["manifest.json"].buffer()));
  for (const {css, js} of manifest.content_scripts || []) {
    if (Array.isArray(css) && css.length) cssFiles.push(...css);
    if (Array.isArray(js) && js.length) jsFiles.push(...js);
  }

  // dedupe
  cssFiles = Array.from(new Set(cssFiles));
  jsFiles = Array.from(new Set(jsFiles));

  // remove leading slash
  cssFiles = cssFiles.map(p => p.replace(/^\//, ""));
  jsFiles = jsFiles.map(p => p.replace(/^\//, ""));

  let css = "";
  for (const file of cssFiles) {
    css += `${await files[file].buffer()}\n`;
  }

  for (const file of jsFiles) {
    const js = String(await files[file].buffer());
    css += extractCssFromJs(js);
  }

  return css;
}

module.exports = async function fetchCss(sources) {
  sources = clone(sources);

  const expandedSources = [];
  for (const source of sources) {
    if ("url" in source && Array.isArray(source.url)) {
      for (const url of source.url) {
        expandedSources.push({...source, url});
      }
    } else {
      expandedSources.push(source);
    }
  }
  sources = expandedSources;

  const sourceResponses = await Promise.all(sources.map(source => {
    if (!source.url) return null;
    const {pathname} = new URL(source.url);
    return pathname.endsWith(".css") || pathname.endsWith(".js") ? null : fetch(source.url, source.fetchOpts);
  }));

  for (const [index, res] of Object.entries(sourceResponses)) {
    const source = sources[index];
    if (res) {
      validateStatus(res, source.url, source.strict);
      const [styleUrls, styleTags] = await extract(res);
      source.urls = styleUrls;
      source.styleTags = styleTags;
    } else if (source.url) {
      source.urls = [source.url];
    }
  }

  const fetchResponses = await Promise.all(sources.map(source => {
    if (!source.url) return null;
    return Promise.all(source.urls.map(url => fetch(url).then(res => res.text())));
  }));

  for (const [index, responses] of Object.entries(fetchResponses)) {
    const source = sources[index];

    if (source.crx) {
      source.css = await extensionCss(source);
    } else {
      if (source.url.endsWith(".js")) {
        source.css = extractCssFromJs(responses.join("\n"));
      } else {
        source.css = responses.join("\n");
        if (source.styleTags && source.styleTags.length) {
          source.css += `\n${source.styleTags.join("\n")}`;
        }
      }
    }
  }

  return sources;
};
