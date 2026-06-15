// @ts-check
"use strict";

/*
 * MHT (MHTML) ビューアーの描画ロジック。
 *
 * Node.js やサードパーティー ライブラリは一切使用せず、ブラウザー標準の
 * API (fetch / TextDecoder / atob / btoa / DOMParser / Blob など) のみで
 * 以下を行います。
 *
 *   1. .mht ファイルのバイト列を取得する
 *   2. MIME マルチパート (multipart/related) を分解する
 *   3. base64 / quoted-printable をデコードする
 *   4. HTML パートから参照されている画像などを data URI へ差し替える
 *   5. sandbox 化した iframe 内に再構築した HTML を描画する
 */
(function () {
  "use strict";

  const vscode =
    typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

  /** @type {HTMLElement} */
  const statusEl = mustGet("status");
  /** @type {HTMLIFrameElement} */
  const frameEl = /** @type {HTMLIFrameElement} */ (mustGet("content"));
  /** @type {HTMLElement} */
  const toolbarEl = mustGet("toolbar");
  /** @type {HTMLElement} */
  const subjectEl = mustGet("subject");
  /** @type {HTMLElement} */
  const dateEl = mustGet("date");
  /** @type {HTMLElement} */
  const countEl = mustGet("count");
  /** @type {HTMLElement} */
  const sourceEl = mustGet("source");
  /** @type {HTMLButtonElement} */
  const toggleBtn = /** @type {HTMLButtonElement} */ (mustGet("toggle-source"));

  /** @type {string | null} 直近に生成した blob URL (破棄管理用)。 */
  let currentBlobUrl = null;
  /** @type {string} 整形前の元テキスト (ソース表示用)。 */
  let rawSourceText = "";
  let showingSource = false;
  let currentArchive = null;
  let currentResourceMap = new Map();

  toggleBtn.addEventListener("click", toggleSource);
  window.addEventListener("message", handleFrameMessage);

  main().catch((err) => fail(err));

  // ---------------------------------------------------------------------------
  // エントリー ポイント
  // ---------------------------------------------------------------------------

  async function main() {
    const config = /** @type {{ fileUri?: string }} */ (
      // @ts-ignore - ホスト ページが注入するグローバル
      window.__MHT__ || {}
    );
    const fileUri = document.body.getAttribute("data-file-uri") || config.fileUri;
    if (!fileUri) {
      throw new Error("表示対象のファイル URI が見つかりません。");
    }

    const response = await fetch(fileUri);
    if (!response.ok) {
      throw new Error(
        `ファイルの取得に失敗しました (HTTP ${response.status})。`
      );
    }
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    const archive = parseMhtml(bytes);
    rawSourceText = bytesToLatin1(bytes);
    renderArchive(archive);
  }

  // ---------------------------------------------------------------------------
  // MHTML パース
  // ---------------------------------------------------------------------------

  /**
   * @typedef {Object} MhtPart
   * @property {Record<string, string>} headers
   * @property {string} contentType
   * @property {string} mimeType        パラメーターを除いた Content-Type
   * @property {string} location        Content-Location
   * @property {string} contentId       Content-ID (山括弧を除去済み)
   * @property {Uint8Array} bytes        デコード済みの本体
   */

  /**
   * @typedef {Object} MhtArchive
   * @property {Record<string, string>} headers   最上位の MIME ヘッダー
   * @property {MhtPart[]} parts
   * @property {MhtPart | null} mainHtml
   */

  /**
   * @param {Uint8Array} bytes
   * @returns {MhtArchive}
   */
  function parseMhtml(bytes) {
    const text = bytesToLatin1(bytes);
    const top = parseHeaders(text, 0);
    const contentType = top.headers["content-type"] || "";
    const boundary = getParameter(contentType, "boundary");

    /** @type {MhtPart[]} */
    const parts = [];

    if (boundary) {
      const rawParts = splitByBoundary(text, top.bodyStart, boundary);
      for (const rawPart of rawParts) {
        const part = buildPart(rawPart);
        if (part) {
          parts.push(part);
        }
      }
    } else {
      // マルチパートでない場合は全体を 1 つの HTML パートとして扱う。
      const part = buildPartFromHeaders(top, text);
      if (part) {
        parts.push(part);
      }
    }

    const mainHtml = pickMainHtml(parts, top.headers);
    return { headers: top.headers, parts, mainHtml };
  }

  /**
   * 1 つのパート (ヘッダー + 本体) を解析します。
   *
   * @param {string} rawPart
   * @returns {MhtPart | null}
   */
  function buildPart(rawPart) {
    const parsed = parseHeaders(rawPart, 0);
    return buildPartFromHeaders(parsed, rawPart);
  }

  /**
   * @param {{ headers: Record<string, string>, bodyStart: number }} parsed
   * @param {string} source
   * @returns {MhtPart | null}
   */
  function buildPartFromHeaders(parsed, source) {
    const headers = parsed.headers;
    const body = source.slice(parsed.bodyStart);
    const contentType = headers["content-type"] || "application/octet-stream";
    const encoding = (headers["content-transfer-encoding"] || "")
      .toLowerCase()
      .trim();

    let bytes;
    if (encoding === "base64") {
      bytes = decodeBase64(body);
    } else if (encoding === "quoted-printable") {
      bytes = decodeQuotedPrintable(body);
    } else {
      // 7bit / 8bit / binary / 未指定
      bytes = latin1ToBytes(body);
    }

    return {
      headers,
      contentType,
      mimeType: contentType.split(";")[0].trim().toLowerCase(),
      location: (headers["content-location"] || "").trim(),
      contentId: stripAngleBrackets(headers["content-id"] || ""),
      bytes,
    };
  }

  /**
   * 表示の起点となる HTML パートを選びます。
   *
   * @param {MhtPart[]} parts
   * @param {Record<string, string>} topHeaders
   * @returns {MhtPart | null}
   */
  function pickMainHtml(parts, topHeaders) {
    if (parts.length === 0) {
      return null;
    }
    // multipart/related の type / start パラメーターを優先的に尊重する。
    const startId = stripAngleBrackets(
      getParameter(topHeaders["content-type"] || "", "start") || ""
    );
    if (startId) {
      const started = parts.find((p) => p.contentId === startId);
      if (started) {
        return started;
      }
    }
    const html = parts.find((p) => p.mimeType === "text/html");
    return html || parts[0];
  }

  // ---------------------------------------------------------------------------
  // MIME ヘルパー
  // ---------------------------------------------------------------------------

  /**
   * 指定位置から空行までを MIME ヘッダーとして解析します。
   * ヘッダーの折り返し (継続行) にも対応します。
   *
   * @param {string} text
   * @param {number} start
   * @returns {{ headers: Record<string, string>, bodyStart: number }}
   */
  function parseHeaders(text, start) {
    /** @type {Record<string, string>} */
    const headers = {};
    let i = start;
    let lastKey = null;

    while (i < text.length) {
      let eol = text.indexOf("\n", i);
      if (eol === -1) {
        eol = text.length;
      }
      let line = text.slice(i, eol);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      const next = eol + 1;

      if (line === "") {
        return { headers, bodyStart: next };
      }

      if ((line[0] === " " || line[0] === "\t") && lastKey) {
        headers[lastKey] += " " + line.trim();
      } else {
        const colon = line.indexOf(":");
        if (colon !== -1) {
          const key = line.slice(0, colon).trim().toLowerCase();
          headers[key] = line.slice(colon + 1).trim();
          lastKey = key;
        }
      }
      i = next;
    }
    return { headers, bodyStart: text.length };
  }

  /**
   * Content-Type などから名前付きパラメーターを取り出します。
   *
   * @param {string} headerValue
   * @param {string} name
   * @returns {string | null}
   */
  function getParameter(headerValue, name) {
    if (!headerValue) {
      return null;
    }
    const re = new RegExp(
      name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^;\\s]+))",
      "i"
    );
    const m = re.exec(headerValue);
    if (!m) {
      return null;
    }
    const value = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    return value != null ? value.trim() : null;
  }

  /**
   * 本体をバウンダリーで分割し、各パート (ヘッダー + 本体) を返します。
   *
   * @param {string} text
   * @param {number} start
   * @param {string} boundary
   * @returns {string[]}
   */
  function splitByBoundary(text, start, boundary) {
    const delimiter = "--" + boundary;
    /** @type {string[]} */
    const parts = [];
    let idx = text.indexOf(delimiter, start);

    while (idx !== -1) {
      const after = text.substr(idx + delimiter.length, 2);
      if (after === "--") {
        // 終端バウンダリー
        break;
      }
      const lineEnd = text.indexOf("\n", idx);
      if (lineEnd === -1) {
        break;
      }
      const partStart = lineEnd + 1;
      const nextIdx = text.indexOf(delimiter, partStart);
      if (nextIdx === -1) {
        parts.push(text.slice(partStart));
        break;
      }
      let partEnd = nextIdx;
      if (text[partEnd - 1] === "\n") {
        partEnd--;
      }
      if (text[partEnd - 1] === "\r") {
        partEnd--;
      }
      parts.push(text.slice(partStart, partEnd));
      idx = nextIdx;
    }
    return parts;
  }

  // ---------------------------------------------------------------------------
  // エンコーディング ヘルパー
  // ---------------------------------------------------------------------------

  /**
   * バイト列を Latin-1 (1 バイト = 1 文字) として可逆的に文字列化します。
   *
   * @param {Uint8Array} bytes
   * @returns {string}
   */
  function bytesToLatin1(bytes) {
    let result = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      result += String.fromCharCode.apply(null, /** @type {any} */ (chunk));
    }
    return result;
  }

  /**
   * Latin-1 文字列をバイト列へ戻します。
   *
   * @param {string} str
   * @returns {Uint8Array}
   */
  function latin1ToBytes(str) {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      bytes[i] = str.charCodeAt(i) & 0xff;
    }
    return bytes;
  }

  /**
   * @param {string} input
   * @returns {Uint8Array}
   */
  function decodeBase64(input) {
    const clean = input.replace(/[^A-Za-z0-9+/=]/g, "");
    try {
      const binary = atob(clean);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch (_e) {
      return new Uint8Array(0);
    }
  }

  /**
   * @param {string} input
   * @returns {Uint8Array}
   */
  function decodeQuotedPrintable(input) {
    /** @type {number[]} */
    const out = [];
    for (let i = 0; i < input.length; i++) {
      const c = input[i];
      if (c === "=") {
        // ソフト改行 (=CRLF / =LF)
        if (input[i + 1] === "\r" && input[i + 2] === "\n") {
          i += 2;
          continue;
        }
        if (input[i + 1] === "\n") {
          i += 1;
          continue;
        }
        const hex = input.substr(i + 1, 2);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          out.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
        out.push(0x3d); // '=' をそのまま
      } else {
        out.push(c.charCodeAt(0) & 0xff);
      }
    }
    return Uint8Array.from(out);
  }

  /**
   * バイト列を Content-Type の charset に従って文字列化します。
   *
   * @param {Uint8Array} bytes
   * @param {string} contentType
   * @returns {string}
   */
  function decodeTextBytes(bytes, contentType) {
    const charset = normalizeCharset(getParameter(contentType, "charset"));
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch (_e) {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }

  /**
   * @param {string | null} charset
   * @returns {string}
   */
  function normalizeCharset(charset) {
    let cs = (charset || "").toLowerCase().trim().replace(/['"]/g, "");
    if (!cs) {
      return "utf-8";
    }
    if (cs === "unicode" || cs === "utf16" || cs === "utf-16") {
      return "utf-16le";
    }
    return cs;
  }

  /**
   * @param {Uint8Array} bytes
   * @returns {string}
   */
  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, /** @type {any} */ (chunk));
    }
    return btoa(binary);
  }

  // ---------------------------------------------------------------------------
  // リソース解決 (画像などの差し替え)
  // ---------------------------------------------------------------------------

  /**
   * パートを data URI へ変換します。
   *
   * @param {MhtPart} part
   * @returns {string}
   */
  function partToDataUri(part) {
    const mime = part.mimeType || "application/octet-stream";
    return "data:" + mime + ";base64," + bytesToBase64(part.bytes);
  }

  /**
   * 参照解決用のマップ (各種キー -> data URI) を構築します。
   *
   * @param {MhtArchive} archive
   * @returns {Map<string, string>}
   */
  function buildResourceMap(archive) {
    /** @type {Map<string, string>} */
    const map = new Map();
    for (const part of archive.parts) {
      if (part.mimeType === "text/html") {
        continue;
      }
      const uri = partToDataUri(part);
      if (part.location) {
        addKey(map, part.location, uri);
        addKey(map, stripScheme(part.location), uri);
        addKey(map, basename(part.location), uri);
      }
      if (part.contentId) {
        addKey(map, "cid:" + part.contentId, uri);
      }
    }
    return map;
  }

  /**
   * @param {Map<string, string>} map
   * @param {string} key
   * @param {string} value
   */
  function addKey(map, key, value) {
    if (key && !map.has(key)) {
      map.set(key, value);
    }
    const normalized = normalizeLocation(key);
    if (normalized && !map.has(normalized)) {
      map.set(normalized, value);
    }
  }

  /**
   * 参照文字列を data URI へ解決します。
   *
   * @param {string | null} value
   * @param {Map<string, string>} map
   * @param {string} base
   * @returns {string | null}
   */
  function resolveResource(value, map, base) {
    if (!value) {
      return null;
    }
    const ref = value.trim();
    if (!ref || ref.startsWith("#") || ref.startsWith("data:")) {
      return null;
    }
    const candidates = buildReferenceCandidates(ref, base);
    for (const candidate of candidates) {
      if (map.has(candidate)) {
        return map.get(candidate) || null;
      }
      const normalized = normalizeLocation(candidate);
      if (normalized && map.has(normalized)) {
        return map.get(normalized) || null;
      }
    }
    if (/^cid:/i.test(ref)) {
      const id = stripAngleBrackets(ref.slice(4));
      return map.get("cid:" + id) || null;
    }
    if (map.has(ref)) {
      return map.get(ref) || null;
    }
    // ベース URL からの絶対化を試みる。
    if (base) {
      try {
        const abs = new URL(ref, base).href;
        if (map.has(abs)) {
          return map.get(abs) || null;
        }
        if (map.has(stripScheme(abs))) {
          return map.get(stripScheme(abs)) || null;
        }
      } catch (_e) {
        /* noop */
      }
    }
    if (map.has(stripScheme(ref))) {
      return map.get(stripScheme(ref)) || null;
    }
    const bn = basename(ref);
    if (bn && map.has(bn)) {
      return map.get(bn) || null;
    }
    return null;
  }

  /**
   * HTML パートや画像パートの Content-Location と照合する候補を作ります。
   * PSR の MHT は main.htm / slide0001.htm のような相対 Content-Location を
   * 多用するため、URL API だけでなく単純な相対パス解決も併用します。
   *
   * @param {string} ref
   * @param {string} base
   * @returns {string[]}
   */
  function buildReferenceCandidates(ref, base) {
    const values = [ref, stripScheme(ref), basename(ref)];
    const relative = resolveRelativeReference(ref, base);
    values.push(relative, stripScheme(relative), basename(relative));
    try {
      if (base) {
        const absolute = new URL(ref, base).href;
        values.push(absolute, stripScheme(absolute), basename(absolute));
      }
    } catch (_e) {
      /* noop */
    }
    return values.filter((value, index) => value && values.indexOf(value) === index);
  }

  /**
   * @param {string} ref
   * @param {string} base
   * @returns {string}
   */
  function resolveRelativeReference(ref, base) {
    if (!base || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("/")) {
      return ref;
    }
    try {
      if (/^[a-z][a-z0-9+.-]*:/i.test(base)) {
        return new URL(ref, base).href;
      }
    } catch (_e) {
      /* noop */
    }
    const cleanBase = base.split("?")[0].split("#")[0].replace(/\\/g, "/");
    const slash = cleanBase.lastIndexOf("/");
    const dir = slash === -1 ? "" : cleanBase.slice(0, slash + 1);
    return normalizePath(dir + ref.replace(/\\/g, "/"));
  }

  /**
   * @param {string} path
   * @returns {string}
   */
  function normalizePath(path) {
    const output = [];
    for (const part of path.split("/")) {
      if (!part || part === ".") {
        continue;
      }
      if (part === "..") {
        output.pop();
      } else {
        output.push(part);
      }
    }
    return output.join("/");
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function normalizeLocation(value) {
    return stripScheme(value || "")
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .toLowerCase();
  }

  /**
   * @param {string} url
   * @returns {string}
   */
  function stripScheme(url) {
    return url.replace(/^[a-z][a-z0-9+.-]*:\/*/i, "");
  }

  /**
   * @param {string} url
   * @returns {string}
   */
  function basename(url) {
    const clean = url.split("?")[0].split("#")[0];
    const parts = clean.split(/[\\/]/);
    return parts[parts.length - 1] || "";
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function stripAngleBrackets(value) {
    return (value || "").trim().replace(/^<|>$/g, "").trim();
  }

  // ---------------------------------------------------------------------------
  // HTML / CSS の再構築
  // ---------------------------------------------------------------------------

  /**
   * メイン HTML を組み立て、外部参照を data URI へ差し替えます。
   *
   * @param {MhtArchive} archive
   * @returns {string}
   */
  function buildDocument(archive, htmlPart) {
    if (!htmlPart) {
      throw new Error("HTML パートが見つかりませんでした。");
    }
    const map = currentResourceMap.size > 0 ? currentResourceMap : buildResourceMap(archive);
    const base = htmlPart.location || "";
    const htmlText = decodeTextBytes(
      htmlPart.bytes,
      htmlPart.contentType
    );

    const doc = new DOMParser().parseFromString(htmlText, "text/html");

    // <base> は data URI 解決の妨げになるため削除する。
    doc.querySelectorAll("base").forEach((el) => el.remove());

    rewriteAttributes(doc, map, base);
    inlineStylesheets(doc, archive, map, base);
    rewriteInlineStyles(doc, map, base);
    rewriteLinks(doc, archive, map, base);
    enhanceImageZoom(doc);
    neutralizeExternalLinks(doc);
    injectHead(doc);
    injectNavigationScript(doc);

    return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  }

  /**
   * src / href / poster などの属性を差し替えます。
   *
   * @param {Document} doc
   * @param {Map<string, string>} map
   * @param {string} base
   */
  function rewriteAttributes(doc, map, base) {
    const targets = [
      ["img", "src"],
      ["img", "longdesc"],
      ["source", "src"],
      ["input", "src"],
      ["video", "poster"],
      ["video", "src"],
      ["audio", "src"],
      ["embed", "src"],
      ["object", "data"],
      ["track", "src"],
      ["[background]", "background"],
    ];
    for (const [selector, attr] of targets) {
      doc.querySelectorAll(selector).forEach((el) => {
        const value = el.getAttribute(attr);
        const resolved = resolveResource(value, map, base);
        if (resolved) {
          el.setAttribute(attr, resolved);
        }
      });
    }
    // srcset (img / source)
    doc.querySelectorAll("img[srcset], source[srcset]").forEach((el) => {
      const srcset = el.getAttribute("srcset");
      if (srcset) {
        el.setAttribute("srcset", rewriteSrcset(srcset, map, base));
      }
    });
  }

  /**
   * @param {string} srcset
   * @param {Map<string, string>} map
   * @param {string} base
   * @returns {string}
   */
  function rewriteSrcset(srcset, map, base) {
    return srcset
      .split(",")
      .map((entry) => {
        const trimmed = entry.trim();
        if (!trimmed) {
          return "";
        }
        const space = trimmed.indexOf(" ");
        const url = space === -1 ? trimmed : trimmed.slice(0, space);
        const descriptor = space === -1 ? "" : trimmed.slice(space);
        const resolved = resolveResource(url, map, base);
        return (resolved || url) + descriptor;
      })
      .filter(Boolean)
      .join(", ");
  }

  /**
   * 外部 CSS (<link rel="stylesheet">) を <style> としてインライン化します。
   *
   * @param {Document} doc
   * @param {MhtArchive} archive
   * @param {Map<string, string>} map
   */
  function inlineStylesheets(doc, archive, map, base) {
    doc.querySelectorAll('link[rel~="stylesheet"]').forEach((link) => {
      const href = link.getAttribute("href");
      if (!href) {
        return;
      }
      const part = findCssPart(href, archive, base);
      if (!part) {
        return;
      }
      const css = rewriteCss(
        decodeTextBytes(part.bytes, part.contentType),
        map,
        part.location || base
      );
      const style = doc.createElement("style");
      style.textContent = css;
      link.replaceWith(style);
    });
  }

  /**
   * @param {string} href
   * @param {MhtArchive} archive
   * @param {string} base
   * @returns {MhtPart | null}
   */
  function findCssPart(href, archive, base) {
    const candidates = buildReferenceCandidates(href, base);
    for (const part of archive.parts) {
      if (part.mimeType !== "text/css") {
        continue;
      }
      const keys = [
        part.location,
        stripScheme(part.location || ""),
        basename(part.location || ""),
        normalizeLocation(part.location || ""),
      ];
      if (candidates.some((c) => c && keys.indexOf(c) !== -1)) {
        return part;
      }
    }
    return null;
  }

  /**
   * 同一 MHT 内の HTML パートへのリンクを Webview 内ナビゲーションへ変換します。
   *
   * @param {Document} doc
   * @param {MhtArchive} archive
   * @param {Map<string, string>} map
   * @param {string} base
   */
  function rewriteLinks(doc, archive, map, base) {
    doc.querySelectorAll("a[href]").forEach((link) => {
      const href = link.getAttribute("href") || "";
      if (!href || href.startsWith("#")) {
        return;
      }
      const resolvedResource = resolveResource(href, map, base);
      if (resolvedResource) {
        link.setAttribute("href", resolvedResource);
        return;
      }
      const target = findHtmlPart(href, archive, base);
      if (!target) {
        return;
      }
      link.setAttribute("href", "#");
      link.setAttribute("data-mht-location", target.location);
      const hashIndex = href.indexOf("#");
      if (hashIndex !== -1) {
        link.setAttribute("data-mht-hash", href.slice(hashIndex));
      }
    });
  }

  /**
   * PSR のスライド画面はスクリーンショットをリンクで包みます。MHT 内の画像を
   * data URI に置換した後も、クリックで画像だけに遷移せず拡大縮小できるように
   * Webview 側の補助属性を付けます。
   *
   * @param {Document} doc
   */
  function enhanceImageZoom(doc) {
    doc.querySelectorAll("img.screenshot, img.screenshot-thumb, img.slidescreenshot").forEach((img) => {
      img.setAttribute("data-mht-zoomable", "true");
      if (!img.hasAttribute("data-mht-original-style")) {
        img.setAttribute("data-mht-original-style", img.getAttribute("style") || "");
      }
      const link = img.closest("a[href]");
      if (link && /^data:image\//i.test(link.getAttribute("href") || "")) {
        link.setAttribute("href", "#");
        link.setAttribute("data-mht-image-link", "true");
      }
    });
  }

  /**
   * @param {string} href
   * @param {MhtArchive} archive
   * @param {string} base
   * @returns {MhtPart | null}
   */
  function findHtmlPart(href, archive, base) {
    const withoutHash = href.split("#")[0];
    const candidates = buildReferenceCandidates(withoutHash, base).map((c) =>
      normalizeLocation(c)
    );
    for (const part of archive.parts) {
      if (part.mimeType !== "text/html") {
        continue;
      }
      const keys = buildReferenceCandidates(part.location, "").map((key) =>
        normalizeLocation(key)
      );
      if (candidates.some((candidate) => candidate && keys.indexOf(candidate) !== -1)) {
        return part;
      }
    }
    return null;
  }

  /**
   * <style> 要素および style 属性内の url() を差し替えます。
   *
   * @param {Document} doc
   * @param {Map<string, string>} map
   * @param {string} base
   */
  function rewriteInlineStyles(doc, map, base) {
    doc.querySelectorAll("style").forEach((style) => {
      if (style.textContent) {
        style.textContent = rewriteCss(style.textContent, map, base);
      }
    });
    doc.querySelectorAll("[style]").forEach((el) => {
      const value = el.getAttribute("style");
      if (value && value.indexOf("url(") !== -1) {
        el.setAttribute("style", rewriteCss(value, map, base));
      }
    });
  }

  /**
   * CSS テキスト中の url() を data URI へ差し替えます。
   *
   * @param {string} css
   * @param {Map<string, string>} map
   * @param {string} base
   * @returns {string}
   */
  function rewriteCss(css, map, base) {
    return css.replace(
      /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
      (match, quote, ref) => {
        const resolved = resolveResource(ref, map, base);
        return resolved ? "url(" + quote + resolved + quote + ")" : match;
      }
    );
  }

  /**
   * 外部リンクが新しいタブを開かないよう無効化します
   * (sandbox 化された iframe でナビゲーションを抑止)。
   *
   * @param {Document} doc
   */
  function neutralizeExternalLinks(doc) {
    doc.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      if (/^https?:/i.test(href) || /^file:/i.test(href)) {
        a.setAttribute("title", href);
        a.removeAttribute("href");
        a.setAttribute("style", (a.getAttribute("style") || "") + ";cursor:default;");
      }
    });
  }

  /**
   * iframe 内ドキュメント用の charset / CSP メタ情報を head 先頭へ挿入します。
   * これにより外部ネットワーク アクセスを遮断しつつ、PSR の埋め込み
   * スクリプト (スライドショー等) と data URI 画像のみを許可します。
   *
   * @param {Document} doc
   */
  function injectHead(doc) {
    let head = doc.querySelector("head");
    if (!head) {
      head = doc.createElement("head");
      doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
    }

    const csp = doc.createElement("meta");
    csp.setAttribute("http-equiv", "Content-Security-Policy");
    csp.setAttribute(
      "content",
      "default-src 'none'; img-src data:; media-src data:; " +
        "style-src 'unsafe-inline' data:; font-src data:; " +
        "script-src 'unsafe-inline';"
    );

    const charset = doc.createElement("meta");
    charset.setAttribute("charset", "utf-8");

    const style = doc.createElement("style");
    style.textContent = [
      "img[data-mht-zoomable].slidescreenshot { cursor: zoom-in; }",
      "img[data-mht-zoomable][data-mht-zoomed=\"true\"] { cursor: zoom-out; }",
    ].join("\n");

    head.insertBefore(csp, head.firstChild);
    head.insertBefore(charset, head.firstChild);
    head.appendChild(style);
  }

  /**
   * sandbox iframe 内から親 Webview へ HTML パート遷移を通知するスクリプトを
   * 埋め込みます。外部通信ではなく、同一 Webview 内の postMessage のみです。
   *
   * @param {Document} doc
   */
  function injectNavigationScript(doc) {
    const script = doc.createElement("script");
    script.textContent = `
window.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type !== 'mht-scroll' || !data.hash) {
    return;
  }
  var id = data.hash.charAt(0) === '#' ? data.hash.slice(1) : data.hash;
  var target = document.getElementById(id) || document.querySelector('[name="' + id.replace(/"/g, '\\"') + '"]');
  if (target && target.scrollIntoView) {
    target.scrollIntoView();
  }
});
document.addEventListener('click', function (event) {
  var target = event.target;
  var image = target && target.closest ? target.closest('img[data-mht-zoomable]') : null;
  if (image && image.classList.contains('slidescreenshot')) {
    event.preventDefault();
    var zoomed = image.getAttribute('data-mht-zoomed') === 'true';
    if (zoomed) {
      image.setAttribute('style', image.getAttribute('data-mht-original-style') || '');
      image.setAttribute('data-mht-zoomed', 'false');
    } else {
      if (!image.hasAttribute('data-mht-original-style')) {
        image.setAttribute('data-mht-original-style', image.getAttribute('style') || '');
      }
      image.style.width = 'auto';
      image.style.maxWidth = 'none';
      image.style.height = 'auto';
      image.setAttribute('data-mht-zoomed', 'true');
    }
    return;
  }
  var link = target && target.closest ? target.closest('a[data-mht-location]') : null;
  if (!link) {
    return;
  }
  event.preventDefault();
  parent.postMessage({
    type: 'mht-navigate',
    location: link.getAttribute('data-mht-location') || '',
    hash: link.getAttribute('data-mht-hash') || ''
  }, '*');
});`;
    (doc.body || doc.documentElement).appendChild(script);
  }

  // ---------------------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------------------

  /**
   * @param {MhtArchive} archive
   */
  function renderArchive(archive) {
    currentArchive = archive;
    currentResourceMap = buildResourceMap(archive);
    const html = buildDocument(archive, archive.mainHtml);
    loadIntoFrame(html);
    updateToolbar(archive);

    statusEl.hidden = true;
    frameEl.hidden = false;
    toolbarEl.hidden = false;
  }

  /**
   * iframe から送られた HTML パート遷移を処理します。
   *
   * @param {MessageEvent} event
   */
  function handleFrameMessage(event) {
    const data = event.data;
    if (!data || typeof data !== "object" || data.type !== "mht-navigate") {
      return;
    }
    if (!currentArchive || typeof data.location !== "string") {
      return;
    }
    const target = findHtmlPart(data.location, currentArchive, "");
    if (!target) {
      return;
    }
    const html = buildDocument(currentArchive, target);
    loadIntoFrame(html);
    if (typeof data.hash === "string" && data.hash) {
      frameEl.addEventListener(
        "load",
        () => {
          try {
            frameEl.contentWindow && frameEl.contentWindow.postMessage(
              { type: "mht-scroll", hash: data.hash },
              "*"
            );
          } catch (_e) {
            /* noop */
          }
        },
        { once: true }
      );
    }
  }

  /**
   * @param {string} html
   */
  function loadIntoFrame(html) {
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = null;
    }
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    currentBlobUrl = URL.createObjectURL(blob);
    frameEl.src = currentBlobUrl;
  }

  /**
   * @param {MhtArchive} archive
   */
  function updateToolbar(archive) {
    const subject = decodeMimeWord(archive.headers["subject"] || "");
    const date = archive.headers["date"] || "";
    const images = archive.parts.filter((p) =>
      p.mimeType.startsWith("image/")
    ).length;

    subjectEl.textContent = subject || "MHT ドキュメント";
    dateEl.textContent = date;
    countEl.textContent = images > 0 ? `画像 ${images} 件` : "";
    document.title = subject || "MHT Viewer";
  }

  function toggleSource() {
    showingSource = !showingSource;
    if (showingSource) {
      sourceEl.textContent = rawSourceText;
      sourceEl.hidden = false;
      frameEl.hidden = true;
      toggleBtn.textContent = "プレビュー";
    } else {
      sourceEl.hidden = true;
      frameEl.hidden = false;
      toggleBtn.textContent = "ソース";
    }
  }

  // ---------------------------------------------------------------------------
  // ユーティリティ
  // ---------------------------------------------------------------------------

  /**
   * RFC 2047 の encoded-word (=?charset?B/Q?...?=) を可能な範囲でデコードします。
   *
   * @param {string} value
   * @returns {string}
   */
  function decodeMimeWord(value) {
    return value.replace(
      /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
      (match, charset, enc, data) => {
        try {
          let bytes;
          if (enc.toLowerCase() === "b") {
            bytes = decodeBase64(data);
          } else {
            bytes = decodeQuotedPrintable(data.replace(/_/g, " "));
          }
          return new TextDecoder(normalizeCharset(charset)).decode(bytes);
        } catch (_e) {
          return match;
        }
      }
    );
  }

  /**
   * @param {string} id
   * @returns {HTMLElement}
   */
  function mustGet(id) {
    const el = document.getElementById(id);
    if (!el) {
      throw new Error(`要素 #${id} が見つかりません。`);
    }
    return el;
  }

  /**
   * @param {unknown} err
   */
  function fail(err) {
    const message =
      err instanceof Error ? err.message : String(err || "不明なエラー");
    statusEl.hidden = false;
    statusEl.classList.add("error");
    statusEl.textContent = "表示できませんでした: " + message;
    frameEl.hidden = true;
    if (vscode) {
      vscode.postMessage({ type: "error", text: message });
    }
  }
})();
