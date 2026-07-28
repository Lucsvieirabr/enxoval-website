import { createFileRoute } from "@tanstack/react-router";

const BAD_IMG = /(logo|avatar|brand|header|icon|sprite|favicon|placeholder|navigation)/i;

function isGoodImage(url: string | null | undefined): url is string {
  if (!url) return false;
  if (BAD_IMG.test(url)) return false;
  return /^https?:\/\//i.test(url);
}

function isTinyImage(url: string): boolean {
  const m1 = url.match(/[_\-.](\d{2,4})x(\d{2,4})(?=\.|_|-|$|\?)/i);
  if (m1) {
    const w = parseInt(m1[1], 10);
    const h = parseInt(m1[2], 10);
    if (w < 100 || h < 100) return true;
  }
  const w = url.match(/[?&](?:w|width)=(\d{2,4})/i);
  const h = url.match(/[?&](?:h|height)=(\d{2,4})/i);
  if (w && parseInt(w[1], 10) < 100) return true;
  if (h && parseInt(h[1], 10) < 100) return true;
  return false;
}

function accept(url: string | null | undefined): url is string {
  return isGoodImage(url) && !isTinyImage(url as string);
}

function extractMlbId(url: string): string | null {
  const m = url.match(/MLB-?(\d{6,})/i);
  return m ? `MLB${m[1]}` : null;
}

function isMercadoLivre(url: string): boolean {
  try {
    const u = new URL(url);
    return /mercadolivre\.com\.br$|mercadolibre\.com(\.[a-z]{2,3})?$/i.test(u.hostname);
  } catch {
    return false;
  }
}

async function fetchMercadoLibre(url: string) {
  const id = extractMlbId(url);
  if (!id) return null;
  try {
    const res = await fetch(`https://api.mercadolibre.com/items/${id}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ProductPreviewBot/1.0)",
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const pic: string | undefined =
      json?.pictures?.[0]?.secure_url || json?.pictures?.[0]?.url || json?.thumbnail;
    return {
      image: pic && isGoodImage(pic) ? pic : null,
      title: typeof json?.title === "string" ? json.title : null,
    };
  } catch {
    return null;
  }
}

function pickFromJsonLd(node: unknown): string | null {
  if (!node) return null;
  if (typeof node === "string" && accept(node)) return node;
  if (Array.isArray(node)) {
    for (const n of node) {
      const v = pickFromJsonLd(n);
      if (v) return v;
    }
    return null;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const type = obj["@type"];
    const isProduct =
      type === "Product" || (Array.isArray(type) && type.includes("Product"));
    if (isProduct && obj.image) {
      const v = pickFromJsonLd(obj.image);
      if (v) return v;
    }
    if (obj["@graph"]) {
      const v = pickFromJsonLd(obj["@graph"]);
      if (v) return v;
    }
    if (obj.image) {
      const v = pickFromJsonLd(obj.image);
      if (v) return v;
    }
    if (typeof obj.url === "string" && accept(obj.url)) return obj.url;
  }
  return null;
}

async function fetchViaMicrolink(url: string) {
  try {
    // html + prerender for JSON-LD extraction
    const htmlRes = await fetch(
      `https://api.microlink.io/?url=${encodeURIComponent(url)}&meta=false&html=true&prerender=true`,
    );
    if (htmlRes.ok) {
      const j: any = await htmlRes.json();
      const html: string | undefined = j?.data?.html;
      if (html) {
        const matches = html.matchAll(
          /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
        );
        for (const m of matches) {
          try {
            const parsed = JSON.parse(m[1].trim());
            const v = pickFromJsonLd(parsed);
            if (v) return { image: v, title: null };
          } catch {
            /* ignore */
          }
        }
      }
    }
    const imgRes = await fetch(
      `https://api.microlink.io/?url=${encodeURIComponent(url)}&prerender=true`,
    );
    if (imgRes.ok) {
      const j: any = await imgRes.json();
      const img = j?.data?.image?.url;
      const width = Number(j?.data?.image?.width ?? 0);
      const height = Number(j?.data?.image?.height ?? 0);
      if (accept(img) && !((width && width < 100) || (height && height < 100))) {
        return { image: img as string, title: (j?.data?.title as string) ?? null };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export const Route = createFileRoute("/api/public/product-preview")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const u = new URL(request.url);
        const target = u.searchParams.get("url");
        if (!target || !/^https?:\/\//i.test(target)) {
          return new Response(JSON.stringify({ image: null, title: null }), {
            headers: { "content-type": "application/json" },
          });
        }
        let result: { image: string | null; title: string | null } | null = null;
        if (isMercadoLivre(target)) {
          result = await fetchMercadoLibre(target);
        }
        if (!result || (!result.image && !result.title)) {
          result = (await fetchViaMicrolink(target)) ?? { image: null, title: null };
        }
        return new Response(JSON.stringify(result), {
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=300",
          },
        });
      },
    },
  },
});
