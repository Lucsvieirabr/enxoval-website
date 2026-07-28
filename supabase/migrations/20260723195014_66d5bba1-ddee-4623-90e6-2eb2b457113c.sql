
CREATE TABLE public.collections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.collections TO anon, authenticated;
GRANT ALL ON public.collections TO service_role;
ALTER TABLE public.collections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read collections" ON public.collections FOR SELECT USING (true);
CREATE POLICY "public insert collections" ON public.collections FOR INSERT WITH CHECK (true);
CREATE POLICY "public update collections" ON public.collections FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "public delete collections" ON public.collections FOR DELETE USING (true);

CREATE TABLE public.links (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  collection_id UUID NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  image_url TEXT,
  price TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX links_collection_id_idx ON public.links(collection_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.links TO anon, authenticated;
GRANT ALL ON public.links TO service_role;
ALTER TABLE public.links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read links" ON public.links FOR SELECT USING (true);
CREATE POLICY "public insert links" ON public.links FOR INSERT WITH CHECK (true);
CREATE POLICY "public update links" ON public.links FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "public delete links" ON public.links FOR DELETE USING (true);

ALTER PUBLICATION supabase_realtime ADD TABLE public.collections;
ALTER PUBLICATION supabase_realtime ADD TABLE public.links;
