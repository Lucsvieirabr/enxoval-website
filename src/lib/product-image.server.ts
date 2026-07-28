/**
 * Pipeline resiliente de extração da imagem principal de um produto.
 *
 * Camada 1 — API oficial do Mercado Livre (não sofre bloqueio de WAF).
 * Camada 2 — Parsing estático da página (Open Graph / Twitter Card / JSON-LD),
 *            com retentativa usando User-Agent de crawler de link preview.
 * Camada 3 — Proxy de scraping externo (ScrapingBee / ScraperAPI / Microlink).
 *
 * Nenhuma camada lança: uma falha apenas avança a cascata. Além do timeout por
 * camada existe um teto global, para o endpoint nunca ficar pendurado.
 */

export type ExtractionSource =
  | "mercadolivre-api"
  | "opengraph"
  | "twitter-card"
  | "json-ld"
  | "html-fallback"
  | "microlink"
  | "scrapingbee"
  | "scraperapi";

export type ProductImageResult = {
  image: string | null;
  title: string | null;
  source: ExtractionSource | null;
};

/** Retorno de uma camada isolada: pode trazer só o título, ou nada. */
type PartialResult = ProductImageResult;

const MERCADO_LIVRE_TIMEOUT_MS = 5_000;
const STATIC_TIMEOUT_MS = 5_000;
/** A persona de crawler recebe a página de produto completa, então é mais lenta. */
const STATIC_CRAWLER_TIMEOUT_MS = 8_000;
/** Proxies externos renderizam JS, então precisam de mais folga que uma request direta. */
const EXTERNAL_TIMEOUT_MS = 8_000;
const VALIDATION_TIMEOUT_MS = 3_000;
/** Teto da cascata inteira: somados, os timeouts por camada passariam de 30s. */
const TOTAL_BUDGET_MS = 15_000;

/** Páginas de e-commerce passam de 1 MB; ler além disso só custa latência. */
const HTML_BYTE_LIMIT = 1_500_000;

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

/**
 * Mercado Livre e Amazon servem a página real (com Open Graph) para crawlers de
 * link preview, mas mostram muro de login/anti-bot para um User-Agent de browser.
 * É o mesmo caminho que o WhatsApp usa para montar o preview de um link.
 */
const CRAWLER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (compatible; facebookexternalhit/1.1; +http://www.facebook.com/externalhit_uatext.php)",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9",
};

const IMAGE_EXTENSION = /\.(jpe?g|png|webp|avif|gif|bmp|svg)(?:$|[?#])/i;
/** CDNs de imagem frequentemente servem sem extensão; estas pistas evitam um HEAD extra. */
const IMAGE_URL_HINT =
  /(\/images?\/|\/photos?\/|\/media\/|\/produtos?\/|[?&](?:format|fm|f|output)=(?:jpe?g|png|webp|avif))/i;
const BLOCKED_IMAGE_HINT =
  /(logo|avatar|brand|header|sprite|favicon|placeholder|navigation|spinner|loading|1x1|pixel\.)/i;

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

type LogLevel = "info" | "warn";

function log(
  level: LogLevel,
  layer: string,
  event: string,
  detail: Record<string, unknown> = {},
): void {
  const message = `[ImageExtractor] ${layer}: ${event}`;
  const payload = { scope: "ImageExtractor", layer, event, ...detail };
  if (level === "warn") console.warn(message, payload);
  else console.info(message, payload);
}

// ---------------------------------------------------------------------------
// Utilidades genéricas
// ---------------------------------------------------------------------------

function readEnv(name: string): string | undefined {
  const fromProcess = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (fromProcess) return fromProcess;
  const fromMeta = (import.meta as { env?: Record<string, string | undefined> }).env;
  return fromMeta?.[name] || undefined;
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

/**
 * Lê o corpo respeitando o charset declarado e um teto de bytes, e corta a
 * leitura assim que o `<head>` fecha já contendo a meta tag de imagem — páginas
 * de produto passam de 500 KB e baixá-las inteiras estoura o timeout da camada.
 */
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

// ---------------------------------------------------------------------------
// Normalização e validação de URL de imagem
// ---------------------------------------------------------------------------

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&(?:quot|#34|#x22);/gi, '"')
    .replace(/&(?:apos|#39|#x27);/gi, "'")
    .replace(/&(?:lt|#60|#x3c);/gi, "<")
    .replace(/&(?:gt|#62|#x3e);/gi, ">")
    .replace(/&(?:nbsp|#160|#xa0);/gi, " ")
    .replace(/&(?:amp|#38|#x26);/gi, "&"); // por último: senão "&amp;quot;" vira aspas
}

/** Resolve relativas/protocol-relative contra a página e devolve sempre absoluto em https. */
export function normalizeImageUrl(raw: unknown, baseUrl: string): string | null {
  const candidate = asString(raw);
  if (!candidate) return null;

  const decoded = decodeHtmlEntities(candidate);
  const withProtocol = decoded.startsWith("//") ? `https:${decoded}` : decoded;

  try {
    const resolved = new URL(withProtocol, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    // A página é servida por https; imagem em http seria bloqueada como mixed content.
    resolved.protocol = "https:";
    return resolved.toString();
  } catch {
    return null;
  }
}

/** Detecta miniaturas declaradas na própria URL (ex.: `_80x80.jpg`, `?w=50`). */
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
    // Host que rejeita HEAD ou omite o content-type é inconclusivo, não reprovado.
    if (!res.ok || !contentType) return true;
    return contentType.startsWith("image/");
  } catch {
    return true;
  }
}

/**
 * Reescreve URLs de CDNs conhecidos para a versão em alta resolução.
 * Medido no mlstatic: `-I` 2 KB, `-O` 26 KB, `2X_…-F` 94 KB da mesma foto.
 */
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

  // O og:image da Amazon vem com overlays de nota/preço embutidos no nome.
  if (/(^|\.)(media-amazon|ssl-images-amazon)\.com$/i.test(host)) {
    return url.replace(/(\/images\/I\/[^./]+)\..*$/i, "$1.jpg");
  }

  return url;
}

/** Normaliza, filtra heurísticas ruins e confirma que a URL realmente aponta para imagem. */
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

// ---------------------------------------------------------------------------
// Camada 1 — API oficial do Mercado Livre
// ---------------------------------------------------------------------------

const MERCADO_LIVRE_HOST = /(^|\.)(mercadolivre|mercadolibre)\.com(\.[a-z]{2,3})?$/i;
/** Cobre todos os sites do grupo: MLB (BR), MLA (AR), MLM (MX), MCO, MPE… */
const MERCADO_LIVRE_ITEM_ID = /\b(M[A-Z]{2})-?(\d{6,})\b/i;
const MERCADO_LIVRE_CATALOG_ID = /\/p\/(M[A-Z]{2})-?(\d{6,})/i;

export function isMercadoLivre(url: string): boolean {
  try {
    return MERCADO_LIVRE_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function extractMercadoLivreId(url: string): { id: string; catalog: boolean } | null {
  const catalog = url.match(MERCADO_LIVRE_CATALOG_ID);
  if (catalog) return { id: `${catalog[1].toUpperCase()}${catalog[2]}`, catalog: true };

  const item = url.match(MERCADO_LIVRE_ITEM_ID);
  if (item) return { id: `${item[1].toUpperCase()}${item[2]}`, catalog: false };

  return null;
}

/** Links encurtados (`/sec/...`) e de tracking só revelam o ID após o redirect. */
async function resolveMercadoLivreRedirect(url: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      url,
      { method: "GET", headers: CRAWLER_HEADERS },
      MERCADO_LIVRE_TIMEOUT_MS,
    );
    await res.body?.cancel().catch(() => undefined);
    return res.url && res.url !== url ? res.url : null;
  } catch {
    return null;
  }
}

/**
 * Desde 2025 a API do Mercado Livre rejeita chamadas anônimas (403 PolicyAgent).
 * Ao confirmar isso uma vez, paramos de gastar um round-trip por link.
 */
let mercadoLivreApiNeedsToken = false;

async function fetchFromMercadoLivreApi(productUrl: string): Promise<PartialResult | null> {
  const layer = "MercadoLivreAPI";
  const token = readEnv("MERCADO_LIVRE_ACCESS_TOKEN");

  if (!token && mercadoLivreApiNeedsToken) {
    log("warn", layer, "camada pulada: API exige MERCADO_LIVRE_ACCESS_TOKEN", { productUrl });
    return null;
  }

  let identifier = extractMercadoLivreId(productUrl);
  if (!identifier) {
    const resolved = await resolveMercadoLivreRedirect(productUrl);
    if (resolved) identifier = extractMercadoLivreId(resolved);
  }
  if (!identifier) {
    log("warn", layer, "item id não encontrado na URL", { productUrl });
    return null;
  }

  const endpoint = identifier.catalog
    ? `https://api.mercadolibre.com/products/${identifier.id}`
    : `https://api.mercadolibre.com/items/${identifier.id}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": BROWSER_HEADERS["User-Agent"],
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetchWithTimeout(endpoint, { headers }, MERCADO_LIVRE_TIMEOUT_MS);
    if (!res.ok) {
      if ((res.status === 401 || res.status === 403) && !token) {
        mercadoLivreApiNeedsToken = true;
        log("warn", layer, "API recusou chamada anônima; configure MERCADO_LIVRE_ACCESS_TOKEN", {
          itemId: identifier.id,
          status: res.status,
        });
      } else {
        log("warn", layer, "resposta não-ok", { itemId: identifier.id, status: res.status });
      }
      return null;
    }

    const payload = asRecord(await res.json());
    if (!payload) return null;

    const pictures = Array.isArray(payload.pictures) ? payload.pictures : [];
    const candidates = [
      ...pictures.flatMap((picture) => {
        const record = asRecord(picture);
        return record ? [record.secure_url, record.url] : [];
      }),
      payload.secure_thumbnail,
      payload.thumbnail,
    ]
      .map((value) => asString(value))
      .filter((value): value is string => Boolean(value));

    const image = await firstValidImage(candidates, productUrl);
    const title = cleanTitle(payload.title) ?? cleanTitle(payload.name);

    if (!image) {
      log("warn", layer, "API respondeu sem imagem utilizável", { itemId: identifier.id });
      return title ? { image: null, title, source: null } : null;
    }

    log("info", layer, "sucesso via API oficial do Mercado Livre", {
      itemId: identifier.id,
      catalog: identifier.catalog,
      image,
    });
    return { image, title, source: "mercadolivre-api" };
  } catch (error) {
    log("warn", layer, "falha na chamada", { itemId: identifier.id, error: errorMessage(error) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parsing de HTML (usado pela camada 2 e pelos proxies da camada 3)
// ---------------------------------------------------------------------------

const TAG_ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(TAG_ATTRIBUTE)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

/** Uma chave pode repetir (galerias declaram vários `og:image`), então guardamos a lista. */
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
      // JSON-LD malformado é comum; ignoramos o bloco e seguimos.
    }
  }

  return { productImages, anyImages };
}

const BLOCKED_TITLE =
  /(n[aã]o [eé] poss[ií]vel acessar|acesso negado|access denied|attention required|just a moment|are you (a )?(robot|human)|verifica[cç][aã]o|forbidden|p[aá]gina n[aã]o encontrada|page not found|error \d{3})/i;
/** Shells de bloqueio costumam ter só o nome da loja como título. */
const GENERIC_TITLE =
  /^(mercado ?li[bv]re|amazon(\.com(\.br)?)?|magazine luiza|magalu|americanas|shopee|casas bahia|shein|aliexpress|home|loading)$/i;

/** Descarta títulos de interstitial e o preço que o Mercado Livre anexa ao og:title. */
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

/** Núcleo compartilhado: dado um HTML, tenta OG → Twitter → JSON-LD → tags soltas. */
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

// ---------------------------------------------------------------------------
// Camada 2 — Requisição direta + metadados estáticos
// ---------------------------------------------------------------------------

const WAF_STATUS = new Set([401, 403, 405, 406, 409, 429, 503]);
const CHALLENGE_MARKER =
  /(cf-browser-verification|cf_chl_|_Incapsula_|Attention Required|Access Denied|Request unsuccessful|px-captcha|Are you a robot|Enable JavaScript and cookies|suspicious-traffic|negative_traffic|n[aã]o [eé] poss[ií]vel acessar a p[aá]gina)/i;
/** Interstitials que respondem 200 mas redirecionam para verificação/login. */
const CHALLENGE_PATH =
  /\/(gz\/account-verification|gz\/security|lgz\/login|registration|challenge|captcha|blocked)/i;

/** Uma passada da camada 2: uma persona de request + parsing do HTML devolvido. */
async function fetchStaticOnce(
  productUrl: string,
  persona: "browser" | "social-crawler",
): Promise<PartialResult | null> {
  const layer = `StaticMetadata/${persona}`;
  const isBrowser = persona === "browser";
  const headers = isBrowser
    ? { ...BROWSER_HEADERS, Referer: new URL(productUrl).origin + "/" }
    : CRAWLER_HEADERS;
  const timeout = isBrowser ? STATIC_TIMEOUT_MS : STATIC_CRAWLER_TIMEOUT_MS;

  try {
    const res = await fetchWithTimeout(productUrl, { headers }, timeout);

    if (!res.ok) {
      log("warn", layer, WAF_STATUS.has(res.status) ? "bloqueado pelo WAF" : "resposta não-ok", {
        productUrl,
        status: res.status,
      });
      return null;
    }

    const html = await readBodyLimited(res);
    // Sem o descarte, o título do interstitial ("Mercado Libre") vazaria para o formulário.
    if (CHALLENGE_PATH.test(new URL(res.url || productUrl).pathname)) {
      log("warn", layer, "redirecionado para verificação anti-bot", { productUrl, to: res.url });
      return null;
    }
    if (CHALLENGE_MARKER.test(html.slice(0, 20_000))) {
      log("warn", layer, "página devolveu desafio anti-bot", { productUrl });
      return null;
    }

    // `res.url` reflete o destino após redirects — base correta para URLs relativas.
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

  for (const persona of ["browser", "social-crawler"] as const) {
    const result = await fetchStaticOnce(productUrl, persona);
    if (result?.image) return result;
    partial = partial ?? result;
  }

  return partial;
}

// ---------------------------------------------------------------------------
// Camada 3 — Proxies de scraping externos
// ---------------------------------------------------------------------------

async function fetchViaHtmlProxy(
  productUrl: string,
  proxyUrl: string,
  source: ExtractionSource,
  layer: string,
): Promise<PartialResult | null> {
  try {
    const res = await fetchWithTimeout(proxyUrl, { headers: BROWSER_HEADERS }, EXTERNAL_TIMEOUT_MS);
    if (!res.ok) {
      log("warn", layer, "proxy respondeu não-ok", { productUrl, status: res.status });
      return null;
    }

    const result = await extractFromHtml(await readBodyLimited(res), productUrl);
    if (!result?.image) {
      log("warn", layer, "proxy retornou HTML sem imagem", { productUrl });
      return result;
    }

    log("info", layer, `sucesso via ${source} (${result.source})`, {
      productUrl,
      image: result.image,
    });
    return { ...result, source };
  } catch (error) {
    log("warn", layer, "falha no proxy", { productUrl, error: errorMessage(error) });
    return null;
  }
}

function scrapingBeeUrl(productUrl: string, apiKey: string): string {
  const params = new URLSearchParams({
    api_key: apiKey,
    url: productUrl,
    render_js: "true",
    block_resources: "true",
    country_code: "br",
  });
  return `https://app.scrapingbee.com/api/v1/?${params.toString()}`;
}

function scraperApiUrl(productUrl: string, apiKey: string): string {
  const params = new URLSearchParams({
    api_key: apiKey,
    url: productUrl,
    country_code: "br",
  });
  return `https://api.scraperapi.com/?${params.toString()}`;
}

async function fetchViaMicrolink(productUrl: string): Promise<PartialResult | null> {
  const layer = "Microlink";
  const apiKey = readEnv("MICROLINK_API_KEY");
  const endpoint = apiKey ? "https://pro.microlink.io" : "https://api.microlink.io";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;

  const request = async (params: string): Promise<Record<string, unknown> | null> => {
    const res = await fetchWithTimeout(
      `${endpoint}/?url=${encodeURIComponent(productUrl)}&${params}`,
      { headers },
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

    // Metadados vazios costumam significar OG ausente: cai para o HTML renderizado.
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

    // Sem imagem o título não é confiável: o Microlink o deriva do slug da URL.
    log("warn", layer, "nenhuma imagem encontrada", { productUrl });
    return null;
  } catch (error) {
    log("warn", layer, "falha na chamada", { productUrl, error: errorMessage(error) });
    return null;
  }
}

async function fetchFromExternalScraper(productUrl: string): Promise<PartialResult | null> {
  const scrapingBeeKey = readEnv("SCRAPINGBEE_API_KEY");
  if (scrapingBeeKey) {
    const result = await fetchViaHtmlProxy(
      productUrl,
      scrapingBeeUrl(productUrl, scrapingBeeKey),
      "scrapingbee",
      "ScrapingBee",
    );
    if (result?.image) return result;
  }

  const scraperApiKey = readEnv("SCRAPERAPI_API_KEY");
  if (scraperApiKey) {
    const result = await fetchViaHtmlProxy(
      productUrl,
      scraperApiUrl(productUrl, scraperApiKey),
      "scraperapi",
      "ScraperAPI",
    );
    if (result?.image) return result;
  }

  return fetchViaMicrolink(productUrl);
}

// ---------------------------------------------------------------------------
// Pipeline público
// ---------------------------------------------------------------------------

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

  const started = Date.now();
  // Um título achado numa camada continua útil mesmo se a imagem vier de outra.
  const partial: { title: string | null } = { title: null };

  const runCascade = async (): Promise<ProductImageResult> => {
    const layers: Array<() => Promise<PartialResult | null>> = [];
    if (isMercadoLivre(trimmed)) layers.push(() => fetchFromMercadoLivreApi(trimmed));
    layers.push(() => fetchFromStaticMetadata(trimmed));
    layers.push(() => fetchFromExternalScraper(trimmed));

    for (const layer of layers) {
      const result = await layer();
      if (result?.title && !partial.title) partial.title = result.title;
      if (result?.image) {
        log("info", "Pipeline", "imagem resolvida", {
          productUrl: trimmed,
          source: result.source,
          elapsedMs: Date.now() - started,
        });
        return { image: result.image, title: result.title ?? partial.title, source: result.source };
      }
    }

    log("warn", "Pipeline", "todas as camadas falharam", {
      productUrl: trimmed,
      elapsedMs: Date.now() - started,
    });
    return { image: null, title: partial.title, source: null };
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<ProductImageResult>((resolve) => {
    timer = setTimeout(() => {
      log("warn", "Pipeline", "orçamento de tempo esgotado", {
        productUrl: trimmed,
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
