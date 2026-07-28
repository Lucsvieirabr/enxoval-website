import { createFileRoute } from "@tanstack/react-router";
import { extractProductImage } from "@/lib/product-image.server";

const PRIVATE_HOSTNAME =
  /^(localhost|.*\.local|.*\.internal|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;

/** Endpoint público que busca URLs arbitrárias: precisa barrar alvos internos (SSRF). */
function parsePublicUrl(raw: string | null): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (PRIVATE_HOSTNAME.test(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

function json(body: unknown, status: number, cacheSeconds: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control":
        cacheSeconds > 0 ? `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}` : "no-store",
    },
  });
}

export const Route = createFileRoute("/api/public/product-preview")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const target = parsePublicUrl(new URL(request.url).searchParams.get("url"));
        if (!target) {
          return json({ image: null, title: null, source: null, error: "invalid_url" }, 400, 0);
        }

        const result = await extractProductImage(target.toString());

        // Falha costuma ser transitória (rate limit, WAF), então cacheamos pouco.
        return json(result, 200, result.image ? 86_400 : 60);
      },
    },
  },
});
