import {parse} from "acorn";
import cloner from "rfdc";
import postcss from "postcss";
import {parseFragment} from "parse5";
import type {DefaultTreeAdapterMap} from "parse5";
import unzipper from "unzipper";
import urlToolkit from "url-toolkit";
import crxToZip from "./crx-to-zip.ts";
import {fetch as undiciFetch} from "undici";
import fetchEnhanced from "fetch-enhanced";
import type {FetchOpts} from "fetch-enhanced";

const fetch = fetchEnhanced(undiciFetch, {undici: true});
const clone = cloner();

/** A single CSS source to fetch from a website, file or browser extension. */
export type Source = {
  /** An absolute URL pointing to a website or directly to a CSS or JS file, or an array of such URLs. */
  url?: string | Array<string>,
  /** Options passed to `fetch`. */
  fetchOpts?: FetchOpts,
  /** A Chrome extension id. */
  crx?: string,
  /** Whether to pull only content scripts from an extension. Default: `false`. */
  contentScriptsOnly?: boolean,
  /** Whether to throw an error if a fetch fails. Default: `false`. */
  strict?: boolean,
  /** The extracted CSS, present on the resolved sources. */
  css?: string,
  /** The resolved stylesheet URLs, present on the resolved sources. */
  urls?: Array<string>,
  /** The extracted inline `<style>` tag contents, present on the resolved sources. */
  styleTags?: Array<string>,
};

async function doFetch(url: string, opts?: FetchOpts): Promise<Response> {
  try {
    return await fetch(url, opts);
  } catch (err) {
    (err as Error).message = `${(err as Error).message} (${url})`;
    throw err;
  }
}

async function extract(res: Response): Promise<[Array<string>, Array<string>]> {
  const styleUrls: Array<string> = [];
  const styleTags: Array<string> = [];
  const html = await res.text();

  for (const href of extractStyleHrefs(html)) {
    styleUrls.push(urlToolkit.buildAbsoluteURL(res.url, href));
  }
  for (const style of extractStyleTags(html)) {
    styleTags.push(style);
  }

  return [styleUrls, styleTags];
}

function validateStatus(res: Response, url: string | undefined, strict: boolean | undefined): void {
  if (res.status === 200) return;
  const msg = `Failed to fetch ${url}: ${res.status} ${res.statusText}`;
  if (strict) {
    throw new Error(msg);
  } else {
    console.warn(`(fetch-css) Warning: ${msg}`);
  }
}

function extractStyleHrefs(html: string): Array<string> {
  return (html.match(/<link.+?>/g) || []).map(link => {
    const attrs: Record<string, string> = {};
    for (const attr of (parseFragment(link).childNodes[0] as DefaultTreeAdapterMap["element"]).attrs) {
      attrs[attr.name] = attr.value;
    }
    if (attrs.href && attrs.rel === "stylesheet") return attrs.href;
    if (attrs.href && /\.css$/i.test(attrs.href.replace(/\?.+/, "undefined"))) return attrs.href; // preserves the original single-arg `.replace()` behavior
    return null;
  }).filter(Boolean) as Array<string>;
}

function extractStyleTags(html: string): Array<string> {
  const matches = Array.from((html || "").matchAll(/<style.*?>([\s\S]*?)<\/style>/g) || []);
  return matches.map(match => match[1]).map(css => css.trim()).filter(Boolean);
}

function isValidCSS(string: string): boolean {
  try {
    const root = postcss.parse(string);
    if (root && root.type === "root" && Array.isArray(root.nodes) && root.nodes.length >= 1 && root.nodes.every(node => node.type === "rule")) {
      return true;
    }
  } catch {}
  return false;
}

function arrayBufferToBufferCycle(ab: ArrayBuffer): Buffer {
  const buffer = Buffer.alloc(ab.byteLength);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buffer.length; ++i) {
    buffer[i] = view[i];
  }
  return buffer;
}

function extractCssFromJs(js: string): string {
  let css = "";

  parse(js, {
    ecmaVersion: "latest",
    onToken: token => {
      if (token.type.label === "string") {
        const str = (token as unknown as {value: string}).value.trim()
          .replace(/\n/g, "")
          .replace(/^\);\}/, ""); // this is probably not universal to webpack's css-in-js strings

        if (str.length > 25 && isValidCSS(str)) { // hackish treshold to ignore short strings that may be valid CSS,
          css += `${str}\n`;
        }
      }
    },
  });

  return css.trim();
}

async function extensionCss({crx, contentScriptsOnly, strict}: Source): Promise<string> {
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

  const files: Record<string, unzipper.File> = {};
  for (const file of (await unzipper.Open.buffer(zipBuffer) || {files: []}).files) {
    files[file.path] = file;
  }

  if (!files["manifest.json"]) {
    throw new Error(`manifest.json not found in extension ${crx}`);
  }

  let cssFiles: Array<string> = [];
  let jsFiles: Array<string> = [];

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
    css += `${String(await files[file].buffer())}\n`;
  }

  for (const file of jsFiles) {
    const js = String(await files[file].buffer());
    css += extractCssFromJs(js);
  }

  return css;
}

/**
 * Extract CSS from websites and browser extensions.
 *
 * Returns the given `sources` array with an additional `css` property present on each source.
 */
export default async function fetchCss(sources: Array<Source>): Promise<Array<Source>> {
  sources = clone(sources);

  const expandedSources: Array<Source> = [];
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
    if (!source.url) return Promise.resolve(null);
    const {pathname} = new URL(source.url as string);
    if (pathname.endsWith(".css") || pathname.endsWith(".js")) return Promise.resolve(null);
    return doFetch(source.url as string, source.fetchOpts);
  }));

  for (const [index, res] of sourceResponses.entries()) {
    const source = sources[index];
    source.urls = [];
    source.styleTags = [];
    if (res) {
      validateStatus(res, source.url as string, source.strict);
      const [styleUrls, styleTags] = await extract(res);
      source.urls.push(...styleUrls);
      source.styleTags.push(...styleTags);
    } else if (source.url) {
      source.urls = [source.url as string];
    }
  }

  const fetchResponses = await Promise.all(sources.map(source => {
    if (!source.url) return Promise.resolve(null);
    return Promise.all(source.urls!.map(url => doFetch(url).then(res => res.text())));
  }));

  for (const [index, responses] of fetchResponses.entries()) {
    const source = sources[index];

    if (source.crx) {
      source.css = await extensionCss(source);
    } else {
      if ((source.url as string).endsWith(".js")) {
        source.css = extractCssFromJs(responses!.join("\n"));
      } else {
        source.css = responses!.join("\n");
        if (source.styleTags?.length) {
          source.css += `\n${source.styleTags.join("\n")}`;
        }
      }
    }
  }

  return sources;
}
