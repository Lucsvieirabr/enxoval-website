export const CATEGORIES = [
  "Eletros e Limpeza",
  "Cozinha e Eletroportáteis",
  "Cama e Banho",
  "Iluminação e Clima",
  "Essenciais do Dia 1",
  "Móveis Gerais",
] as const;

export type Category = (typeof CATEGORIES)[number];

export type ProductPreview = { image: string | null; title: string | null };

export async function fetchProductPreview(url: string): Promise<ProductPreview> {
  try {
    const res = await fetch(`/api/public/product-preview?url=${encodeURIComponent(url)}`);
    if (!res.ok) return { image: null, title: null };
    const json = (await res.json()) as ProductPreview;
    return {
      image: json?.image ?? null,
      title: json?.title ?? null,
    };
  } catch {
    return { image: null, title: null };
  }
}

// Backwards-compatible helper.
export async function fetchOgImage(url: string): Promise<string | null> {
  const p = await fetchProductPreview(url);
  return p.image;
}
