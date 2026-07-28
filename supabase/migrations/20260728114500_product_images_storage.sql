-- Bucket público para imagens anexadas aos links do enxoval.
-- A URL pública retornada por getPublicUrl() é gravada em links.image_url.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images',
  'product-images',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Leitura pública (necessário para <img src> e para upsert)
CREATE POLICY "public read product-images"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'product-images');

-- Upload público (alinha com o RLS aberto das tabelas collections/links)
CREATE POLICY "public insert product-images"
ON storage.objects FOR INSERT
TO public
WITH CHECK (bucket_id = 'product-images');

CREATE POLICY "public update product-images"
ON storage.objects FOR UPDATE
TO public
USING (bucket_id = 'product-images')
WITH CHECK (bucket_id = 'product-images');

CREATE POLICY "public delete product-images"
ON storage.objects FOR DELETE
TO public
USING (bucket_id = 'product-images');
