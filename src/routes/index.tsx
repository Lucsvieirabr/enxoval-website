import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, ArrowRight, Trash2, Sparkles, Search, Pencil } from "lucide-react";
import { toast } from "sonner";
import { CATEGORIES } from "@/lib/categories";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

type Collection = {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  created_at: string;
};

const emptyForm = { title: "", description: "", category: "" };

function Dashboard() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Collection | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState<string>("all");

  const load = async () => {
    const { data, error } = await supabase.from("collections").select("*").order("created_at", { ascending: false });
    if (error) { toast.error("Erro ao carregar coleções"); return; }
    setCollections((data ?? []) as Collection[]);
    const { data: linksData } = await supabase.from("links").select("collection_id");
    const c: Record<string, number> = {};
    (linksData ?? []).forEach((l: { collection_id: string }) => { c[l.collection_id] = (c[l.collection_id] ?? 0) + 1; });
    setCounts(c);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel("dash")
      .on("postgres_changes", { event: "*", schema: "public", table: "collections" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "links" }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  const openCreate = () => { setEditing(null); setForm(emptyForm); setOpen(true); };
  const openEdit = (c: Collection) => {
    setEditing(c);
    setForm({ title: c.title, description: c.description ?? "", category: c.category ?? "" });
    setOpen(true);
  };

  const save = async () => {
    if (!form.title.trim()) return;
    setSaving(true);
    const payload = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      category: form.category || null,
    };
    const { error } = editing
      ? await supabase.from("collections").update(payload).eq("id", editing.id)
      : await supabase.from("collections").insert(payload);
    setSaving(false);
    if (error) { toast.error(editing ? "Erro ao salvar" : "Não foi possível criar a coleção"); return; }
    toast.success(editing ? "Coleção atualizada" : "Coleção criada");
    setForm(emptyForm); setEditing(null); setOpen(false);
  };

  const remove = async (id: string) => {
    const { error } = await supabase.from("collections").delete().eq("id", id);
    if (error) { toast.error("Erro ao excluir"); return; }
    toast.success("Coleção excluída");
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return collections.filter((c) => {
      const matchQ = !q || c.title.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q) || (c.category ?? "").toLowerCase().includes(q);
      const matchCat = filterCat === "all" || c.category === filterCat;
      return matchQ && matchCat;
    });
  }, [collections, search, filterCat]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-border/60 bg-background/80 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-6xl px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <span className="font-display text-2xl">Enxoval</span>
          </div>
          <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> Nova coleção</Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-12">
        <div className="mb-10">
          <h1 className="font-display text-5xl md:text-6xl leading-tight">Seu enxoval,<br/><span className="text-primary italic">organizado juntos.</span></h1>
          <p className="mt-4 text-muted-foreground max-w-xl">Crie coleções, adicione links de produtos e compartilhe a página com quem quiser — sem cadastro, atualização em tempo real.</p>
        </div>

        <div className="mb-6 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome ou categoria..." className="pl-9" />
          </div>
          <Select value={filterCat} onValueChange={setFilterCat}>
            <SelectTrigger className="sm:w-64"><SelectValue placeholder="Categoria" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as categorias</SelectItem>
              {CATEGORIES.map((cat) => (<SelectItem key={cat} value={cat}>{cat}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="text-muted-foreground">Carregando...</div>
        ) : filtered.length === 0 ? (
          <Card className="p-12 text-center border-dashed bg-cream">
            <p className="text-muted-foreground mb-4">{collections.length === 0 ? "Nenhuma coleção ainda." : "Nenhuma coleção encontrada."}</p>
            {collections.length === 0 && <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> Criar a primeira</Button>}
          </Card>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((c) => (
              <Card key={c.id} className="group p-6 hover:shadow-lg transition-all border-border/60 hover:border-primary/40 flex flex-col justify-between min-h-[180px]">
                <div>
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <h2 className="font-display text-2xl leading-tight">{c.title}</h2>
                    <Badge variant="secondary" className="shrink-0">{counts[c.id] ?? 0} {(counts[c.id] ?? 0) === 1 ? "item" : "itens"}</Badge>
                  </div>
                  {c.category && <Badge variant="outline" className="mb-2">{c.category}</Badge>}
                  {c.description && <p className="text-sm text-muted-foreground line-clamp-2">{c.description}</p>}
                </div>
                <div className="mt-5 flex items-center justify-between">
                  <Button asChild variant="ghost" size="sm" className="text-primary hover:text-primary">
                    <Link to="/collection/$id" params={{ id: c.id }}>Abrir <ArrowRight className="ml-1 h-4 w-4" /></Link>
                  </Button>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-primary" onClick={() => openEdit(c)}><Pencil className="h-4 w-4" /></Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Excluir "{c.title}"?</AlertDialogTitle>
                          <AlertDialogDescription>Todos os links dessa coleção serão perdidos. Esta ação não pode ser desfeita.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancelar</AlertDialogCancel>
                          <AlertDialogAction onClick={() => remove(c.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Excluir</AlertDialogAction>
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

      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setEditing(null); setForm(emptyForm); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display text-2xl">{editing ? "Editar coleção" : "Nova coleção"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="t">Título</Label>
              <Input id="t" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Ex: Jogo de Panela" autoFocus />
            </div>
            <div className="space-y-2">
              <Label>Categoria</Label>
              <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                <SelectTrigger><SelectValue placeholder="Selecione uma categoria" /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((cat) => (<SelectItem key={cat} value={cat}>{cat}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="d">Descrição (opcional)</Label>
              <Textarea id="d" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Sobre o que é essa coleção?" rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button onClick={save} disabled={saving || !form.title.trim()}>{editing ? "Salvar" : "Criar coleção"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
