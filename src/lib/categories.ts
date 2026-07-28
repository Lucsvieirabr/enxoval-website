export const CATEGORIES = [
  "Eletros e Limpeza",
  "Cozinha e Eletroportáteis",
  "Cama e Banho",
  "Iluminação e Clima",
  "Essenciais do Dia 1",
  "Móveis Gerais",
] as const;

export type Category = (typeof CATEGORIES)[number];

// Reexportado para não quebrar imports antigos; a fonte é @/lib/product-preview.
export { fetchProductPreview, fetchOgImage, type ProductPreview } from "./product-preview";
