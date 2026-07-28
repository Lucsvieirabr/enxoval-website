/**
 * Extração da imagem principal de um produto via scraping simples.
 *
 * Camada 1 — HTML da página (Open Graph / Twitter Card / JSON-LD).
 * Camada 2 — Microlink gratuito como fallback.
 *
 * Sem tokens, OAuth ou proxies pagos. Sites que bloqueiam (ex.: Mercado Livre
 * em datacenter) devem usar o upload manual de imagem no formulário.
 */

export type ExtractionSource =
  "opengraph" | "twitter-card" | "json-ld" | "html-fallback" | "microlink";

export type ProductImageResult = {
  image: string | null;
  title: string | null;
  source: ExtractionSource | null;
};

type PartialResult = ProductImageResult;

const STATIC_TIMEOUT_MS = 5_000;
const STATIC_CRAWLER_TIMEOUT_MS = 8_000;
const EXTERNAL_TIMEOUT_MS = 8_000;
const VALIDATION_TIMEOUT_MS = 3_000;
const TOTAL_BUDGET_MS = 12_000;
const HTML_BYTE_LIMIT = 1_500_000;

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

const CRAWLER_USER_AGENTS = [
  "Mozilla/5.0 (compatible; facebookexternalhit/1.1; +http://www.facebook.com/externalhit_uatext.php)",
  "WhatsApp/2.23.20.0",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];

const IMAGE_EXTENSION = /\.(jpe?g|png|webp|avif|gif|bmp|svg)(?:$|[?#])/i;
const IMAGE_URL_HINT =
  /(\/images?\/|\/photos?\/|\/media\/|\/produtos?\/|[?&](?:format|fm|f|output)=(?:jpe?g|png|webp|avif))/i;
const BLOCKED_IMAGE_HINT =
  /(logo|avatar|brand|header|sprite|favicon|placeholder|navigation|spinner|loading|1x1|pixel\.|frontend-assets\/ui-navigation|logo__small)/i;

function log(
  level: "info" | "warn",
  layer: string,
  event: string,
  detail: Record<string, unknown> = {},
): void {
  const message = `[ImageExtractor] ${layer}: ${event}`;
  const payload = { scope: "ImageExtractor", layer, event, ...detail };
  if (level === "warn") console.warn(message, payload);
  else console.info(message, payload);
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = STATIC_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { redirect: "follow", ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.name === "AbortError" ? "timeout" : error.message;
  return String(error);
}

const HEAD_IMAGE_META = /property=["']og:image|name=["']twitter:image/i;

async function readBodyLimited(res: Response, limit = HTML_BYTE_LIMIT): Promise<string> {
  const charset = /charset=["']?([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1];
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset || "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }

  if (!res.body) return res.text();

  const reader = res.body.getReader();
  let out = "";
  let received = 0;
  let headClosed = false;
  try {
    while (received < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (!headClosed && out.includes("</head>")) {
        headClosed = true;
        if (HEAD_IMAGE_META.test(out)) break;
      }
    }
    out += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&(?:quot|#34|#x22);/gi, '"')
    .replace(/&(?:apos|#39|#x27);/gi, "'")
    .replace(/&(?:lt|#60|#x3c);/gi, "<")
    .replace(/&(?:gt|#62|#x3e);/gi, ">")
    .replace(/&(?:nbsp|#160|#xa0);/gi, " ")
    .replace(/&(?:amp|#38|#x26);/gi, "&");
}

export function normalizeImageUrl(raw: unknown, baseUrl: string): string | null {
  const candidate = asString(raw);
  if (!candidate) return null;

  const decoded = decodeHtmlEntities(candidate);
  const withProtocol = decoded.startsWith("//") ? `https:${decoded}` : decoded;

  try {
    const resolved = new URL(withProtocol, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    resolved.protocol = "https:";
    return resolved.toString();
  } catch {
    return null;
  }
}

function isTinyImage(url: string): boolean {
  const dimensions = url.match(/[_\-.](\d{2,4})x(\d{2,4})(?=\.|_|-|$|\?)/i);
  if (dimensions) {
    if (Number(dimensions[1]) < 100 || Number(dimensions[2]) < 100) return true;
  }
  const width = url.match(/[?&](?:w|width)=(\d{2,4})/i);
  const height = url.match(/[?&](?:h|height)=(\d{2,4})/i);
  if (width && Number(width[1]) < 100) return true;
  if (height && Number(height[1]) < 100) return true;
  return false;
}

async function respondsAsImage(url: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "HEAD",
        headers: { "User-Agent": BROWSER_HEADERS["User-Agent"], Accept: "image/*,*/*;q=0.8" },
      },
      VALIDATION_TIMEOUT_MS,
    );
    const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";
    if (!res.ok || !contentType) return true;
    return contentType.startsWith("image/");
  } catch {
    return true;
  }
}

function upgradeKnownCdn(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }

  if (/(^|\.)mlstatic\.com$/i.test(host)) {
    return url
      .replace(/D_NQ_NP_(?!2X_)/i, "D_NQ_NP_2X_")
      .replace(/-[A-Z]\.(jpe?g|png|webp)$/i, "-F.$1");
  }

  if (/(^|\.)(media-amazon|ssl-images-amazon)\.com$/i.test(host)) {
    return url.replace(/(\/images\/I\/[^./]+)\..*$/i, "$1.jpg");
  }

  return url;
}

async function validateImageCandidate(raw: unknown, baseUrl: string): Promise<string | null> {
  const normalized = normalizeImageUrl(raw, baseUrl);
  if (!normalized) return null;
  const url = upgradeKnownCdn(normalized);
  if (BLOCKED_IMAGE_HINT.test(url)) return null;
  if (isTinyImage(url)) return null;
  if (IMAGE_EXTENSION.test(url) || IMAGE_URL_HINT.test(url)) return url;
  return (await respondsAsImage(url)) ? url : null;
}

async function firstValidImage(candidates: unknown[], baseUrl: string): Promise<string | null> {
  for (const candidate of candidates) {
    const valid = await validateImageCandidate(candidate, baseUrl);
    if (valid) return valid;
  }
  return null;
}

const MERCADO_LIVRE_HOST = /(^|\.)(mercadolivre|mercadolibre)\.com(\.[a-z]{2,3})?$/i;

export function isMercadoLivre(url: string): boolean {
  try {
    return MERCADO_LIVRE_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Remove hash/query de tracking; facilita o scrape quando a página ainda responde. */
export function canonicalizeProductUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!isMercadoLivre(url)) return parsed.toString();
    parsed.hash = "";
    const keep = new Set(["wid", "item_id", "variation"]);
    for (const key of [...parsed.searchParams.keys()]) {
      if (!keep.has(key.toLowerCase())) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

const TAG_ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(TAG_ATTRIBUTE)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function parseMetaTags(html: string): Map<string, string[]> {
  const meta = new Map<string, string[]>();
  for (const match of html.matchAll(/<meta\s+[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    const key = (attributes.property || attributes.name || attributes.itemprop || "").toLowerCase();
    const content = attributes.content;
    if (!key || !content) continue;
    const bucket = meta.get(key);
    if (bucket) bucket.push(content);
    else meta.set(key, [content]);
  }
  return meta;
}

function metaValues(meta: Map<string, string[]>, keys: string[]): string[] {
  return keys.flatMap((key) => meta.get(key) ?? []);
}

function collectJsonLdImages(html: string): { productImages: string[]; anyImages: string[] } {
  const productImages: string[] = [];
  const anyImages: string[] = [];

  const pushImage = (value: unknown, target: string[]): void => {
    if (Array.isArray(value)) {
      for (const entry of value) pushImage(entry, target);
      return;
    }
    const direct = asString(value);
    if (direct) {
      target.push(direct);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    const nested = asString(record.url) ?? asString(record.contentUrl) ?? asString(record["@id"]);
    if (nested) target.push(nested);
  };

  const walk = (node: unknown, depth: number): void => {
    if (depth > 8) return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, depth + 1);
      return;
    }
    const record = asRecord(node);
    if (!record) return;

    const type = record["@type"];
    const isProduct =
      type === "Product" ||
      (Array.isArray(type) && type.some((entry) => entry === "Product")) ||
      (typeof type === "string" && /(^|\/)Product$/i.test(type));

    if (record.image) pushImage(record.image, isProduct ? productImages : anyImages);
    if (isProduct && record.thumbnailUrl) pushImage(record.thumbnailUrl, productImages);

    for (const key of ["@graph", "mainEntity", "itemListElement", "offers", "hasVariant"]) {
      if (record[key]) walk(record[key], depth + 1);
    }
  };

  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const block of blocks) {
    const raw = block[1]
      .trim()
      .replace(/^<!\[CDATA\[/, "")
      .replace(/\]\]>$/, "");
    if (!raw) continue;
    try {
      walk(JSON.parse(raw), 0);
    } catch {
      /* ignore */
    }
  }

  return { productImages, anyImages };
}

const BLOCKED_TITLE =
  /(n[aã]o [eé] poss[ií]vel acessar|acesso negado|access denied|attention required|just a moment|are you (a )?(robot|human)|verifica[cç][aã]o|forbidden|p[aá]gina n[aã]o encontrada|page not found|error \d{3})/i;
const GENERIC_TITLE =
  /^(mercado ?li[bv]re|amazon(\.com(\.br)?)?|magazine luiza|magalu|americanas|shopee|casas bahia|shein|aliexpress|home|loading)$/i;

function cleanTitle(raw: unknown): string | null {
  const value = asString(raw);
  if (!value) return null;
  const text = decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
  if (!text || BLOCKED_TITLE.test(text) || GENERIC_TITLE.test(text)) return null;
  return text.replace(/\s+-\s+R\$\s?[\d.,]+$/i, "").trim() || null;
}

function extractTitle(meta: Map<string, string[]>, html: string): string | null {
  for (const candidate of metaValues(meta, ["og:title", "twitter:title", "title"])) {
    const title = cleanTitle(candidate);
    if (title) return title;
  }
  return cleanTitle(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]);
}

async function extractFromHtml(html: string, baseUrl: string): Promise<PartialResult | null> {
  const meta = parseMetaTags(html);
  const title = extractTitle(meta, html);

  const attempts: Array<{ source: ExtractionSource; candidates: string[] }> = [
    {
      source: "opengraph",
      candidates: metaValues(meta, ["og:image:secure_url", "og:image", "og:image:url"]),
    },
    {
      source: "twitter-card",
      candidates: metaValues(meta, ["twitter:image", "twitter:image:src"]),
    },
  ];

  const jsonLd = collectJsonLdImages(html);
  attempts.push({ source: "json-ld", candidates: jsonLd.productImages });

  const linkImage = /<link[^>]+rel=["'](?:image_src|apple-touch-icon-precomposed)["'][^>]*>/i.exec(
    html,
  );
  attempts.push({
    source: "html-fallback",
    candidates: [
      ...jsonLd.anyImages,
      ...(linkImage ? [parseAttributes(linkImage[0]).href ?? ""] : []),
      ...metaValues(meta, ["image"]),
    ].filter(Boolean),
  });

  for (const attempt of attempts) {
    const image = await firstValidImage(attempt.candidates, baseUrl);
    if (image) return { image, title, source: attempt.source };
  }

  return title ? { image: null, title, source: null } : null;
}

const WAF_STATUS = new Set([401, 403, 405, 406, 409, 429, 503]);
const CHALLENGE_MARKER =
  /(cf-browser-verification|cf_chl_|_Incapsula_|Attention Required|Access Denied|Request unsuccessful|px-captcha|Are you a robot|Enable JavaScript and cookies|suspicious-traffic|negative_traffic|n[aã]o [eé] poss[ií]vel acessar a p[aá]gina)/i;
const CHALLENGE_PATH =
  /\/(gz\/account-verification|gz\/security|lgz\/login|registration|challenge|captcha|blocked)/i;

async function fetchStaticOnce(
  productUrl: string,
  userAgent: string,
  timeoutMs: number,
): Promise<PartialResult | null> {
  const layer = `StaticMetadata/${userAgent.slice(0, 28)}`;
  try {
    const res = await fetchWithTimeout(
      productUrl,
      {
        headers: {
          ...BROWSER_HEADERS,
          "User-Agent": userAgent,
          Referer: new URL(productUrl).origin + "/",
        },
      },
      timeoutMs,
    );

    if (!res.ok) {
      log("warn", layer, WAF_STATUS.has(res.status) ? "bloqueado pelo WAF" : "resposta não-ok", {
        productUrl,
        status: res.status,
      });
      return null;
    }

    const html = await readBodyLimited(res);
    if (CHALLENGE_PATH.test(new URL(res.url || productUrl).pathname)) {
      log("warn", layer, "redirecionado para verificação anti-bot", { productUrl, to: res.url });
      return null;
    }
    if (CHALLENGE_MARKER.test(html.slice(0, 20_000))) {
      log("warn", layer, "página devolveu desafio anti-bot", { productUrl });
      return null;
    }

    const result = await extractFromHtml(html, res.url || productUrl);
    if (!result?.image) {
      log("warn", layer, "nenhuma imagem encontrada nos metadados", { productUrl });
      return result;
    }

    log("info", layer, `sucesso via ${result.source}`, { productUrl, image: result.image });
    return result;
  } catch (error) {
    log("warn", layer, "falha na requisição direta", { productUrl, error: errorMessage(error) });
    return null;
  }
}

async function fetchFromStaticMetadata(productUrl: string): Promise<PartialResult | null> {
  let partial: PartialResult | null = null;

  const browser = await fetchStaticOnce(
    productUrl,
    BROWSER_HEADERS["User-Agent"],
    STATIC_TIMEOUT_MS,
  );
  if (browser?.image) return browser;
  partial = browser ?? partial;

  for (const ua of CRAWLER_USER_AGENTS) {
    const result = await fetchStaticOnce(productUrl, ua, STATIC_CRAWLER_TIMEOUT_MS);
    if (result?.image) return result;
    partial = partial ?? result;
  }

  return partial;
}

async function fetchViaMicrolink(productUrl: string): Promise<PartialResult | null> {
  const layer = "Microlink";

  const request = async (params: string): Promise<Record<string, unknown> | null> => {
    const res = await fetchWithTimeout(
      `https://api.microlink.io/?url=${encodeURIComponent(productUrl)}&${params}`,
      { headers: { Accept: "application/json" } },
      EXTERNAL_TIMEOUT_MS,
    );
    if (!res.ok) {
      log("warn", layer, "resposta não-ok", { productUrl, status: res.status });
      return null;
    }
    const payload = asRecord(await res.json());
    return payload ? asRecord(payload.data) : null;
  };

  try {
    const data = await request("meta=true&palette=false&prerender=auto");
    const title = data ? cleanTitle(data.title) : null;
    const imageNode = asRecord(data?.image);

    if (imageNode) {
      const width = Number(imageNode.width ?? 0);
      const height = Number(imageNode.height ?? 0);
      const bigEnough = !((width && width < 100) || (height && height < 100));
      const image = bigEnough ? await validateImageCandidate(imageNode.url, productUrl) : null;
      if (image) {
        log("info", layer, "sucesso via metadados do Microlink", { productUrl, image });
        return { image, title, source: "microlink" };
      }
    }

    const rendered = await request("meta=false&html=true&prerender=true");
    const html = rendered ? asString(rendered.html) : null;
    if (html) {
      const result = await extractFromHtml(html, productUrl);
      if (result?.image) {
        log("info", layer, `sucesso via HTML do Microlink (${result.source})`, {
          productUrl,
          image: result.image,
        });
        return { ...result, title: result.title ?? title, source: "microlink" };
      }
    }

    log("warn", layer, "nenhuma imagem encontrada", { productUrl });
    return null;
  } catch (error) {
    log("warn", layer, "falha na chamada", { productUrl, error: errorMessage(error) });
    return null;
  }
}

/**
 * Executa a cascata até obter uma imagem válida.
 * Nunca lança: quando todas as camadas falham devolve `{ image: null, ... }`.
 */
export async function extractProductImage(productUrl: string): Promise<ProductImageResult> {
  const empty: ProductImageResult = { image: null, title: null, source: null };

  const trimmed = asString(productUrl);
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
    log("warn", "Pipeline", "URL de produto inválida", { productUrl });
    return empty;
  }

  const normalized = canonicalizeProductUrl(trimmed);
  const started = Date.now();
  const partial: { title: string | null } = { title: null };

  const runCascade = async (): Promise<ProductImageResult> => {
    for (const layer of [
      () => fetchFromStaticMetadata(normalized),
      () => fetchViaMicrolink(normalized),
    ]) {
      const result = await layer();
      if (result?.title && !partial.title) partial.title = result.title;
      if (result?.image) {
        log("info", "Pipeline", "imagem resolvida", {
          productUrl: normalized,
          source: result.source,
          elapsedMs: Date.now() - started,
        });
        return {
          image: result.image,
          title: result.title ?? partial.title,
          source: result.source,
        };
      }
    }

    log("warn", "Pipeline", "todas as camadas falharam", {
      productUrl: normalized,
      elapsedMs: Date.now() - started,
    });
    return { image: null, title: partial.title, source: null };
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<ProductImageResult>((resolve) => {
    timer = setTimeout(() => {
      log("warn", "Pipeline", "orçamento de tempo esgotado", {
        productUrl: normalized,
        budgetMs: TOTAL_BUDGET_MS,
      });
      resolve({ image: null, title: partial.title, source: null });
    }, TOTAL_BUDGET_MS);
  });

  try {
    return await Promise.race([runCascade(), budget]);
  } finally {
    clearTimeout(timer);
  }
}
