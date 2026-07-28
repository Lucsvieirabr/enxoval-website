export type ProductPreview = {
  image: string | null;
  title: string | null;
  /** Camada da cascata que resolveu a imagem — útil para depurar bloqueios. */
  source: string | null;
};

const EMPTY: ProductPreview = { image: null, title: null, source: null };

export async function fetchProductPreview(
  url: string,
  options: { signal?: AbortSignal } = {},
): Promise<ProductPreview> {
  try {
    const res = await fetch(`/api/public/product-preview?url=${encodeURIComponent(url)}`, {
      signal: options.signal,
    });
    if (!res.ok) return EMPTY;
    const json = (await res.json()) as Partial<ProductPreview> | null;
    return {
      image: json?.image ?? null,
      title: json?.title ?? null,
      source: json?.source ?? null,
    };
  } catch {
    return EMPTY;
  }
}

export async function fetchOgImage(url: string): Promise<string | null> {
  return (await fetchProductPreview(url)).image;
}
