import {parse} from "acorn";
import cloner from "rfdc";
import postcss from "postcss";
import {parseFragment} from "parse5";
import unzipper from "unzipper";
import urlToolkit from "url-toolkit";
import crxToZip from "./crx-to-zip.js";
import {fetch as undiciFetch} from "undici";
import fetchEnhanced from "fetch-enhanced";

const fetch = fetchEnhanced(undiciFetch, {undici: true});
const clone = cloner();

async function doFetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (err) {
    err.message = `${err.message} (${url})`;
    throw err;
  }
}

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
    console.warn(`(fetch-css) Warning: ${msg}`);
  }
}

function extractStyleHrefs(html) {
  return (html.match(/<link.+?>/g) || []).map(link => {
    const attrs = {};
    for (const attr of parseFragment(link).childNodes[0].attrs) {
      attrs[attr.name] = attr.value;
    }
    if (attrs.href && attrs.rel === "stylesheet") return attrs.href;
    if (attrs.href && /\.css$/i.test(attrs.href.replace(/\?.+/))) return attrs.href;
    return null;
  }).filter(Boolean);
}

function extractStyleTags(html) {
  const matches = Array.from((html || "").matchAll(/<style.*?>([\s\S]*?)<\/style>/g) || []);
  return matches.map(match => match[1]).map(css => css.trim()).filter(Boolean);
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

function arrayBufferToBufferCycle(ab) {
  const buffer = new Buffer(ab.byteLength);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buffer.length; ++i) {
    buffer[i] = view[i];
  }
  return buffer;
}

function extractCssFromJs(js) {
  let css = "";

  parse(js, {
    ecmaVersion: "latest",
    onToken: token => {
      if (token.type.label === "string") {
        const str = token.value.trim()
          .replace(/\n/g, "")
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

  const res = await doFetch(url);
  validateStatus(res, url, strict);

  const crxBuffer = arrayBufferToBufferCycle(await res.arrayBuffer());
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

export default async function fetchCss(sources) { // eslint-disable-line import/no-unused-modules
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
    return pathname.endsWith(".css") || pathname.endsWith(".js") ? null : doFetch(source.url, source.fetchOpts);
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
    return Promise.all(source.urls.map(url => doFetch(url).then(res => res.text())));
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
}
