"use strict";

const acorn = require("acorn");
const clone = require("rfdc")();
const css = require("css");
const fetch = require("make-fetch-happen");
const parse5 = require("parse5");
const unzipper = require("unzipper");
const urlToolkit = require("url-toolkit");

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

function extractStyleHrefs(html) {
  return (html.match(/<link.+?>/g) || []).map(link => {
    const attrs = {};
    parse5.parseFragment(link).childNodes[0].attrs.forEach(attr => {
      attrs[attr.name] = attr.value;
    });
    if (attrs.rel === "stylesheet" && attrs.href) {
      return attrs.href;
    }
  }).filter(link => !!link);
}

function extractStyleTags(html) {
  const matches = Array.from((html || "").matchAll(/<style.*?>([\s\S]*?)<\/style>/g) || []);
  return matches.map(match => match[1]).map(css => css.trim()).filter(css => !!css);
}

function isValidCSS(string) {
  try {
    const result = css.parse(string);
    if (result && result.type === "stylesheet" && result.stylesheet && Array.isArray(result.stylesheet.rules) && result.stylesheet.rules.length > 1) {
      return true;
    }
  } catch (err) {}
  return false;
}

// obtain the latest chrome version in major.minor format
async function chromeVersion() {
  const res = await fetch(`https://chromedriver.storage.googleapis.com/LATEST_RELEASE`);
  if (!res.ok) throw new Error(res.statusText);

  const text = await res.text();
  const [version] = text.match(/[0-9]+\.[0-9]+/) || [];

  if (!version) throw new Error(`Unable to match version in response text '${text}'`);
  return version;
}

async function extensionCss(source, version) {
  const id = source.crx;
  let css = "";

  const res = await fetch(`https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${version}&x=id%3D${id}%26installsource%3Dondemand%26uc`);
  if (!res.ok) throw new Error(res.statusText);

  const buffer = await res.buffer();
  const dir = await unzipper.Open.buffer(buffer, {crx: true});
  const files = {};

  for (const file of dir.files) {
    files[file.path] = file;
  }

  if (!files["manifest.json"]) {
    throw new Error(`manifest.json not found in chrome extension ${id}`);
  }

  let cssFiles = [];
  let jsFiles = [];

  if (!source.contentScriptsOnly) {
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

  cssFiles = Array.from(new Set(cssFiles));
  jsFiles = Array.from(new Set(jsFiles));

  for (const file of cssFiles) {
    css += `${await files[file].buffer()}\n`;
  }

  for (const file of jsFiles) {
    acorn.parse(String(await files[file].buffer()), {onToken: async token => {
      if (token.type.label === "string") {
        const str = token.value.trim()
          .replace(/\n/gm, "")
          .replace(/^\);}/, ""); // this is probably not universal to webpack's css-in-js strings
        if (str.length > 25 && isValidCSS(str)) { // hackish treshold to ignore short strings that may be valid CSS
          css += `${str}\n`;
        }
      }
    }});
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
    return source.url.endsWith(".css") ? null : fetch(source.url, source.fetchOpts);
  }));

  for (const [index, response] of Object.entries(sourceResponses)) {
    const source = sources[index];
    if (response) {
      const [styleUrls, styleTags] = await extract(response);
      source.styles = styleUrls;
      source.styleTags = styleTags;
    } else if (source.url) {
      source.styles = [source.url];
    }
  }

  const cssResponses = await Promise.all(sources.map(source => {
    if (!source.url) return null;
    return Promise.all(source.styles.map(url => fetch(url).then(res => res.text())));
  }));

  const version = await chromeVersion();

  for (const [index, responses] of Object.entries(cssResponses)) {
    if (sources[index].crx) {
      sources[index].css = await extensionCss(sources[index], version);
    } else {
      sources[index].css = responses.join("\n");
      if (sources[index].styleTags.length) {
        sources[index].css += `\n${sources[index].styleTags.join("\n")}`;
      }
    }
  }

  return sources;
};
