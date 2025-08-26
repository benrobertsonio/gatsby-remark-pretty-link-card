const visit = require("unist-util-visit");

const DEFAULT_OPTIONS = {
  delimiter: "$card",
  timeout: 15000,
};

const getUrlString = (url) => {
  const urlString = url.startsWith("http") ? url : `https://${url}`;
  try {
    return new URL(urlString).toString();
  } catch {
    return null;
  }
};

const fetchHtml = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
};

const matchFirst = (html, regex) => {
  const m = regex.exec(html);
  return m && m[1] ? m[1].trim() : "";
};

const extractMeta = (html) => {
  // Prefer the head portion if present to speed up regexes
  const headMatch = /<head[\s\S]*?>[\s\S]*?<\/head>/i.exec(html);
  const source = headMatch ? headMatch[0] : html;

  const getMeta = (key) =>
    matchFirst(
      source,
      new RegExp(
        `<meta[^>]+(?:property|name)=["']${key}["'][^>]*?content=["']([^"']+)["'][^>]*>`,
        "i"
      )
    );

  const title =
    getMeta("og:title") || matchFirst(source, /<title>([^<]+)<\/title>/i);
  const description = getMeta("og:description") || getMeta("description");
  const ogImage = getMeta("og:image");
  const favicon = matchFirst(
    source,
    /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*?href=["']([^"']+)["'][^>]*>/i
  );

  return { title, description, ogImage, favicon };
};

const toAbsolute = (maybeUrl, baseUrl) => {
  if (!maybeUrl) return "";
  try {
    return new URL(maybeUrl, baseUrl).toString();
  } catch {
    return "";
  }
};

const getHTML = ({ title, description, favicon, url, ogImage }) => {
  const domain = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  const faviconSrc =
    favicon ||
    (domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : "");

  return `
<div>
  <a target="_blank" rel="noopener noreferrer" href="${url}" class="pretty-link-card-container">
    <div class="pretty-link-card-wrapper">
      <div class="pretty-link-card-title">${title || url}</div>
      <div class="pretty-link-card-description">${description || ""}</div>
      <div class="pretty-link-card-url">
        <img class="pretty-link-card-favicon" src="${faviconSrc}" alt="${
    title || domain
  }-favicon"/>
        <div class="pretty-link-card-link">${url}</div>
      </div>
    </div>
    <div class="pretty-link-card-image-wrapper">
      <img class="pretty-link-card-image" alt="${title || domain}-image" src="${
    ogImage || ""
  }" />
    </div>
  </a>
</div>`.trim();
};

const isValidLinkNode = (node, delimiter) => {
  if (node.type === "link" && node.title === null && node.url) {
    return (
      node.children[0] &&
      node.children[0].type === "text" &&
      node.children[0].value === delimiter
    );
  }
  return false;
};

module.exports = async ({ cache, markdownAST }, pluginOptions) => {
  const options = { ...DEFAULT_OPTIONS, ...pluginOptions };
  const { delimiter, timeout } = options;

  const tasks = [];

  visit(markdownAST, "paragraph", (paragraphNode) => {
    if (paragraphNode.children.length !== 1) return;
    const [node] = paragraphNode.children;
    if (!isValidLinkNode(node, delimiter)) return;

    const { url, value = url } = node;
    const urlString = getUrlString(value);
    if (!urlString) return;

    tasks.push(async () => {
      let html = await cache.get(urlString);
      if (!html) {
        try {
          const pageHtml = await fetchHtml(urlString, timeout);
          const meta = extractMeta(pageHtml);
          const data = {
            title: meta.title,
            description: meta.description,
            url: urlString,
            ogImage: toAbsolute(meta.ogImage, urlString),
            favicon: toAbsolute(meta.favicon, urlString),
          };
          html = getHTML(data);
          await cache.set(urlString, html);
        } catch (e) {
          // Fallback to a minimal card with just the URL
          html = getHTML({
            title: "",
            description: "",
            url: urlString,
            ogImage: "",
            favicon: "",
          });
          await cache.set(urlString, html);
        }
      }

      node.type = "html";
      node.value = html;
      node.children = undefined;
    });
  });

  if (tasks.length) {
    await Promise.all(tasks.map((t) => t()));
  }

  return markdownAST;
};
