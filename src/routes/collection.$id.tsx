import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Plus, Share2, ExternalLink, Trash2, ImageIcon, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { fetchProductPreview } from "@/lib/categories";

export const Route = createFileRoute("/collection/$id")({
  head: ({ params }) => ({
    meta: [
      { title: `Coleção — Enxoval` },
      { name: "description", content: "Coleção de links compartilhada. Adicione produtos em tempo real." },
      { property: "og:title", content: "Coleção compartilhada — Enxoval" },
      { property: "og:description", content: "Coleção colaborativa de links para enxoval." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "collection-id", content: params.id },
    ],
  }),
  component: CollectionPage,
});

type Collection = { id: string; title: string; description: string | null };
type LinkItem = { id: string; collection_id: string; title: string; url: string; image_url: string | null; price: string | null; created_at: string };

const emptyForm = { title: "", url: "", image_url: "", price: "" };

function CollectionPage() {
  const { id } = useParams({ from: "/collection/$id" });
  const [collection, setCollection] = useState<Collection | null>(null);
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<LinkItem | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [fetchingImage, setFetchingImage] = useState(false);
  const lastFetched = useRef<string>("");

  const load = async () => {
    const [{ data: col }, { data: lks }] = await Promise.all([
      supabase.from("collections").select("*").eq("id", id).maybeSingle(),
      supabase.from("links").select("*").eq("collection_id", id).order("created_at", { ascending: false }),
    ]);
    setCollection(col as Collection | null);
    setLinks((lks ?? []) as LinkItem[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel(`col-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "links", filter: `collection_id=eq.${id}` }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "collections", filter: `id=eq.${id}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [id]);

  // Auto-fetch product image when URL changes (debounced). Re-runs even if
  // an image was previously auto-filled, but never overrides a user-typed URL.
  const userEditedImage = useRef(false);
  useEffect(() => {
    const url = form.url.trim();
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (url === lastFetched.current) return;
    if (userEditedImage.current) return;
    const t = setTimeout(async () => {
      lastFetched.current = url;
      setFetchingImage(true);
      const preview = await fetchProductPreview(url);
      setFetchingImage(false);
      setForm((f) => ({
        ...f,
        image_url: !userEditedImage.current && preview.image ? preview.image : f.image_url,
        title: !f.title.trim() && preview.title ? preview.title : f.title,
      }));
    }, 700);
    return () => clearTimeout(t);
  }, [form.url]);


  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success("Link copiado! Compartilhe com quem quiser.");
    } catch {
      toast.error("Não foi possível copiar o link");
    }
  };

  const openCreate = () => { setEditing(null); setForm(emptyForm); lastFetched.current = ""; userEditedImage.current = false; setOpen(true); };
  const openEdit = (l: LinkItem) => {
    setEditing(l);
    setForm({ title: l.title, url: l.url, image_url: l.image_url ?? "", price: l.price ?? "" });
    lastFetched.current = l.url;
    userEditedImage.current = !!l.image_url;
    setOpen(true);
  };


  const save = async () => {
    if (!form.title.trim() || !form.url.trim()) { toast.error("Título e URL são obrigatórios"); return; }
    setSaving(true);
    const payload = {
      title: form.title.trim(),
      url: form.url.trim(),
      image_url: form.image_url.trim() || null,
      price: form.price.trim() || null,
    };
    const { error } = editing
      ? await supabase.from("links").update(payload).eq("id", editing.id)
      : await supabase.from("links").insert({ collection_id: id, ...payload });
    setSaving(false);
    if (error) { toast.error(editing ? "Erro ao salvar" : "Erro ao adicionar link"); return; }
    toast.success(editing ? "Link atualizado" : "Link adicionado");
    setForm(emptyForm); setEditing(null); setOpen(false);
  };

  const removeLink = async (linkId: string) => {
    const { error } = await supabase.from("links").delete().eq("id", linkId);
    if (error) { toast.error("Erro ao excluir"); return; }
    toast.success("Link removido");
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Carregando...</div>;
  if (!collection) return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3">
      <p className="text-muted-foreground">Coleção não encontrada.</p>
      <Button asChild variant="outline"><Link to="/"><ArrowLeft className="h-4 w-4 mr-1" /> Voltar</Link></Button>
    </div>
  );

  return (
    <div className="min-h-screen">
      <header className="border-b border-border/60 bg-background/80 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-6xl px-6 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Button asChild variant="ghost" size="icon" className="shrink-0">
              <Link to="/"><ArrowLeft className="h-5 w-5" /></Link>
            </Button>
            <div className="min-w-0">
              <h1 className="font-display text-2xl md:text-3xl truncate">{collection.title}</h1>
              {collection.description && <p className="text-sm text-muted-foreground truncate">{collection.description}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={share}><Share2 className="h-4 w-4 mr-1" /> Compartilhar</Button>
            <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditing(null); setForm(emptyForm); } }}>
              <DialogTrigger asChild>
                <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> Adicionar</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle className="font-display text-2xl">{editing ? "Editar link" : "Novo link"}</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>URL do produto</Label>
                    <div className="relative">
                      <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://..." type="url" />
                      {fetchingImage && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />}
                    </div>
                    <p className="text-xs text-muted-foreground">A imagem do produto é buscada automaticamente.</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Título</Label>
                    <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Ex: Jogo de Panela Inox Tramontina 5 Pçs" />
                  </div>
                  <div className="space-y-2">
                    <Label>Imagem do produto</Label>
                    <div className="flex gap-3 items-start">
                      <div className="w-28 h-28 rounded-md border bg-muted overflow-hidden flex items-center justify-center shrink-0">
                        {fetchingImage ? (
                          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        ) : form.image_url ? (
                          <img
                            key={form.image_url}
                            src={form.image_url}
                            alt="Prévia"
                            className="w-full h-full object-cover"
                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0.2"; }}
                          />
                        ) : (
                          <ImageIcon className="h-8 w-8 text-muted-foreground/40" />
                        )}
                      </div>
                      <div className="flex-1 space-y-2">
                        <Input
                          value={form.image_url}
                          onChange={(e) => { userEditedImage.current = true; setForm({ ...form, image_url: e.target.value }); }}
                          placeholder="Cole ou substitua a URL da imagem"
                          type="url"
                        />
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!form.url.trim() || fetchingImage}
                            onClick={async () => {
                              userEditedImage.current = false;
                              lastFetched.current = "";
                              setFetchingImage(true);
                              const preview = await fetchProductPreview(form.url.trim());
                              setFetchingImage(false);
                              if (preview.image) setForm((f) => ({ ...f, image_url: preview.image! }));
                              else toast.error("Não foi possível buscar a imagem");
                            }}
                          >
                            {fetchingImage ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
                            Buscar novamente
                          </Button>
                          {form.image_url && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => { userEditedImage.current = true; setForm({ ...form, image_url: "" }); }}
                            >
                              Limpar
                            </Button>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">Se a imagem estiver errada, cole uma URL direta do produto.</p>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Preço (opcional)</Label>
                    <Input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="299,00" />
                  </div>

                </div>
                <DialogFooter>
                  <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
                  <Button onClick={save} disabled={saving}>{editing ? "Salvar" : "Adicionar"}</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        {links.length === 0 ? (
          <Card className="p-12 text-center border-dashed bg-cream">
            <p className="text-muted-foreground mb-4">Nenhum link ainda. Adicione o primeiro!</p>
            <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> Adicionar link</Button>
          </Card>
        ) : (
          <div className="grid gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {links.map((l) => (
              <Card key={l.id} className="overflow-hidden flex flex-col hover:shadow-lg transition-all border-border/60 hover:border-primary/40 pt-0">
                <div className="aspect-square bg-muted flex items-center justify-center overflow-hidden">
                  {l.image_url ? (
                    <img src={l.image_url} alt={l.title} className="w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                  ) : (
                    <ImageIcon className="h-12 w-12 text-muted-foreground/40" />
                  )}
                </div>
                <div className="p-4 flex flex-col flex-1 gap-3">
                  <div className="flex-1">
                    <h3 className="font-medium leading-snug line-clamp-2 mb-1">{l.title}</h3>
                    {l.price && <p className="text-primary font-semibold">R$ {l.price.replace(/^R\$\s?/, "")}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button asChild size="sm" className="flex-1">
                      <a href={l.url} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5 mr-1" /> Abrir</a>
                    </Button>
                    <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-primary" onClick={() => openEdit(l)}><Pencil className="h-4 w-4" /></Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remover este link?</AlertDialogTitle>
                          <AlertDialogDescription>{l.title}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancelar</AlertDialogCancel>
                          <AlertDialogAction onClick={() => removeLink(l.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Remover</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
