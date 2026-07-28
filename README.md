# Enxoval Site

Catálogo de enxoval: coleções e links de produtos, com dados no Supabase e UI em TanStack Start (React + Vite).

## Stack

- **Frontend:** TanStack Start, React 19, TypeScript, Tailwind CSS, shadcn/ui
- **Backend/dados:** Supabase (Postgres + Realtime + RLS)
- **Deploy sugerido:** [Vercel](https://vercel.com)
- **Origem:** projeto gerado/conectado ao [Lovable](https://lovable.dev)

## Pré-requisitos

- Node.js 20+ (ou [Bun](https://bun.sh))
- Conta Supabase
- Conta Vercel (para deploy)

## Setup local

```sh
git clone <url-do-repositorio>
cd enxoval-site
cp .env.example .env
# preencha .env com as keys do Supabase (Settings → API)
npm install   # ou: bun install
npm run dev
```

App em `http://localhost:5173` (porta padrão do Vite).

### Variáveis de ambiente

| Variável | Onde usar | Observação |
|---|---|---|
| `VITE_SUPABASE_URL` | Browser + build | URL do projeto |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Browser + build | Key pública (`sb_publishable_…` ou anon JWT) |
| `VITE_SUPABASE_PROJECT_ID` | Browser + build | Ref do projeto |
| `SUPABASE_URL` | SSR/server | Mesmo valor da URL |
| `SUPABASE_PUBLISHABLE_KEY` | SSR/server | Mesma publishable/anon |
| `SUPABASE_PROJECT_ID` | SSR/server | Mesmo project id |
| `SUPABASE_SERVICE_ROLE_KEY` | **Só servidor** | Opcional; **nunca** prefixar com `VITE_` |
| `MERCADO_LIVRE_ACCESS_TOKEN` | **Só servidor** | Opcional; habilita a camada de API oficial do ML |
| `SCRAPINGBEE_API_KEY` | **Só servidor** | Opcional; proxy de scraping para sites com WAF |
| `SCRAPERAPI_API_KEY` | **Só servidor** | Opcional; alternativa ao ScrapingBee |
| `MICROLINK_API_KEY` | **Só servidor** | Opcional; plano pago do Microlink |

Regras:

1. **Nunca** commitar `.env` (já está no `.gitignore`).
2. **Nunca** colocar `service_role` / `sb_secret_` em variável `VITE_*` — isso vai para o bundle do browser.
3. A publishable/anon key é esperada no frontend; a proteção de dados depende do **RLS** no Supabase.

## Deploy na Vercel

1. Importe o repositório no dashboard da Vercel.
2. Em **Settings → Environment Variables**, configure as mesmas variáveis do `.env` (Production + Preview).
3. Não adicione `SUPABASE_SERVICE_ROLE_KEY` a menos que uma rota server-side precise dela — e nunca com prefixo `VITE_`.
4. Deploy. O build usa `npm run build` / `vite build`.

Checklist pós-deploy:

- [ ] Site abre e lista coleções
- [ ] Criar/editar/excluir funciona (se for o comportamento desejado)
- [ ] Realtime atualiza a UI
- [ ] Nenhuma `service_role` aparece no Network/Sources do browser

## Banco (Supabase)

Migrations em `supabase/migrations/`.

Tabelas principais:

- `collections` — coleções do enxoval
- `links` — produtos/links por coleção

Para aplicar localmente (com [Supabase CLI](https://supabase.com/docs/guides/cli)):

```sh
supabase db push
```

## Extração da imagem do produto

Ao colar o link de um produto, `GET /api/public/product-preview?url=…` devolve
`{ image, title, source }`. A lógica fica em `src/lib/product-image.server.ts` e roda em
cascata, parando na primeira camada que resolver:

| # | Camada | Quando entra | Observação |
|---|---|---|---|
| 1 | API oficial do Mercado Livre | Links do ML | Desde 2025 a API rejeita chamada anônima; sem `MERCADO_LIVRE_ACCESS_TOKEN` a camada se autodesativa |
| 2 | Metadados estáticos | Sempre | Open Graph → Twitter Card → JSON-LD `Product`. Tenta duas vezes: User-Agent de browser e, se falhar, de crawler social |
| 3 | Proxy de scraping | Camadas anteriores falharam | ScrapingBee → ScraperAPI (se houver chave) → Microlink |

A tentativa com User-Agent de crawler é o que destrava Mercado Livre e Amazon: ambos
respondem com muro anti-bot para browser, mas entregam Open Graph para quem monta preview
de link (é como o WhatsApp faz). Imagens de `mlstatic.com` e `media-amazon.com` são
reescritas para a versão em alta resolução.

Cada camada tem timeout próprio e a cascata inteira tem teto de 15s. Os logs saem com o
prefixo `[ImageExtractor]` indicando qual camada resolveu — útil quando um site novo começa
a bloquear.

Sites com WAF muito agressivo (Magazine Luiza, por exemplo) só resolvem com chave de
ScrapingBee/ScraperAPI configurada.

## Scripts

| Comando | Descrição |
|---|---|
| `npm run dev` | Desenvolvimento |
| `npm run build` | Build de produção |
| `npm run preview` | Preview do build |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |

## Segurança (antes do first commit / go-live)

- [x] `.env` no `.gitignore`
- [x] `.env.example` sem valores reais
- [ ] Revisar políticas RLS: hoje `collections` e `links` permitem **SELECT/INSERT/UPDATE/DELETE públicos** (`USING (true)`). Qualquer pessoa com a publishable key pode alterar/apagar dados. Restrinja writes (auth, secret compartilhado, ou só leitura pública) antes de expor o site.
- [ ] Confirmar que `SUPABASE_SERVICE_ROLE_KEY` **não** está no `.env` versionado nem em `VITE_*` na Vercel
- [ ] Se alguma key já vazou em chat/repo/print, **roteie** no dashboard Supabase

## Estrutura

```
src/
  routes/                 # Páginas e API (TanStack Router)
  integrations/supabase/  # Clients (browser + server admin)
  components/ui/          # shadcn/ui
supabase/migrations/      # SQL do schema
```

## Lovable

Este repositório pode sincronizar com o Lovable. Evite `force push`, rebase/amend de commits já publicados na branch conectada — isso reescreve o histórico no Lovable. Detalhes em `AGENTS.md`.
