# Bot Restaurante — SaaS Multi-Tenant para WhatsApp

Plataforma completa de gestão e atendimento para restaurantes via WhatsApp, construída com Claude AI, Evolution API e PostgreSQL. Cada restaurante tem seu próprio número WhatsApp, cardápio e painel admin independentes.

---

## Arquitetura

```
Cliente WhatsApp
      │
      │  POST /webhook/:slug
      ▼
Evolution API
      │
      ▼
         Bot (Node.js 20 + Express)
    ┌────────────────────────────┐
    │  tenantMiddleware (cache)  │
    │  claudeService (IA)        │
    │  sessaoService             │
    │  pedidoService             │
    └────────────┬───────────────┘
                 │
           PostgreSQL 15
    (restaurantes, sessões, pedidos,
     mesas, fidelidade, estoque,
     caixa, facturas, promoções)
                 │
                 ▼
      Dono / Garçom / Cozinha /
      Motoboy / Monitor (PWA)
```

| Serviço | Tecnologia | Papel |
|---|---|---|
| **Bot** | Node.js 20 + Express | API admin + chatbot + Socket.IO |
| **IA** | Claude Sonnet via OpenRouter | Atendimento em linguagem natural |
| **WhatsApp** | Evolution API (Docker) | Gateway de mensagens |
| **Banco** | PostgreSQL 15 + Prisma | Persistência de todos os dados |
| **Proxy** | Traefik | SSL automático + roteamento |
| **Tempo real** | Socket.IO | Atualizações ao vivo em todos os painéis |

---

## Funcionalidades

### Atendimento via WhatsApp (IA)
- Multi-tenant: um bot atende N restaurantes simultaneamente
- Cardápio dinâmico com tamanhos, bordas e fotos
- Pedidos com numeração global crescente (nunca reseta)
- Suporte a português e espanhol (detecção automática)
- Transcrição de áudio via OpenAI Whisper
- Comprovante de pagamento: cliente envia foto, painel exibe thumbnail
- Lembrete automático de sessões inativas (4 min)
- Lembrete de comprovante pendente (a cada 5 min)

### Painel Admin (`painel.html`)
- SPA vanilla JS, sem build step, Tailwind via CDN
- **Kanban de pedidos** em tempo real (Socket.IO)
- **Gestão de mesas** — grid de mesas com status ocupado/livre
- **Balcão POS** — PDV completo com 3 colunas (categorias + produtos + carrinho)
- **App da cozinha** — reusa o pizza builder via flag `_balcaoMode`
- Cardápio: categorias, produtos, tamanhos, fotos, SKUs, bordas
- Gestão de garçons e motoboys (cadastro + envio de link via WhatsApp)
- Controle de caixa (turno, sangrias, fechamento por método de pagamento)
- Controle de estoque com movimentações e receitas técnicas
- Promoções com recorrência por dia da semana
- Programa de fidelidade (por pedidos ou valor gasto)
- Campanhas de marketing (disparos em massa)
- **Factura Legal Paraguay** (SET/RUC/Timbrado, numeração sequencial, IVA 10%)
- Exportação de histórico em CSV
- i18n (PT-BR / ES)

### Garçom PWA (`garcon.html`)
- App instalável no celular do garçom
- Visualiza mesas abertas e pedidos ativos em tempo real
- Pizza builder integrado (sabores, bordas, tamanhos)
- Lembrete de bebida antes de confirmar carrinho
- Solicitação de fechamento de mesa
- Sincronização em tempo real via Socket.IO (`pedido:novo`, `pedido:atualizado`)

### Cozinha (`cozinha.html`)
- 6 tipos de estação: `PIZZA_DELIVERY`, `PIZZA_LOCAL`, `LANCHE_DELIVERY`, `LANCHE_LOCAL`, `BAR_LOCAL`, `BAR_DELIVERY`
- Filtragem por origem (delivery vs local) e categoria
- Autenticação por senha de estação
- Pedidos de balcão criados com status `CONFIRMADO` (aparecem na cozinha imediatamente)

### Motoboy PWA (`motoboy.html`)
- Instalável como app (Web App Manifest + Service Worker)
- Push notifications para novas entregas (mesmo com app fechado)
- Auto-cadastro pelo link enviado via WhatsApp
- Rastreamento: cliente acompanha localização em tempo real (`rastrear.html`)

### Monitor Mobile (`monitor.html`)
- PWA mobile-first para o dono acompanhar remotamente
- 5 abas: Dashboard · Pedidos · Mesas · Motoboys · Cozinha
- Tempo real via Socket.IO (toast + vibração + alerta sonoro)
- Confirma pedidos NOVO → CONFIRMADO pelo celular
- Auto-refresh a cada 60 segundos
- Badge de pedidos não lidos na aba

### Cardápio Web (`cardapio.html`)
- Loja pública para delivery/self-service
- Barra de promoções horizontal scrollable
- Modal bottom-sheet com itens da promoção selecionáveis
- Integração com bot WhatsApp

---

## Estrutura de Pastas

```
bot-restaurante/
  docker-compose.yml
  bot/
    Dockerfile
    prisma/
      schema.prisma           — fonte da verdade do banco
      migrations/
    public/
      painel.html             — painel admin completo (SPA)
      garcon.html             — app garçom (PWA)
      cozinha.html            — display de cozinha por estação
      motoboy.html            — app motoboy (PWA)
      monitor.html            — monitor mobile para o dono (PWA)
      cardapio.html           — loja web pública
      rastrear.html           — rastreamento de entrega
      uploads/                — fotos de cardápio e comprovantes
    src/
      server.js
      controllers/
        webhookController.js
      middleware/
        tenantMiddleware.js   — resolve restaurante, cache TTL 5min
        authMiddleware.js     — JWT para rotas admin
      routes/
        admin.js              — /admin/* (CRUD completo, ~3200 linhas)
        auth.js               — /auth/login + /auth/definir-senha
        onboarding.js         — /onboarding/restaurante
        painel.js             — /painel/* (garçom + motoboy + cozinha)
        loja.js               — /loja/:slug (cardápio público)
      services/
        claudeService.js      — system prompt dinâmico, JSON estruturado
        evolutionService.js   — enviarMensagem / enviarImagem / enviarDocumento
        pedidoService.js      — finaliza pedido, fidelidade, numeroDia
        sessaoService.js      — CRUD sessões e mensagens
        cardapioService.js    — CRUD cardápio + importação PDF/imagem
        tenantService.js      — cache em memória TTL 5min
        transcricaoService.js — OpenAI Whisper
      jobs/
        limpeza.js            — 5 jobs agendados (ver abaixo)
```

---

## Jobs Agendados (`limpeza.js`)

| Job | Frequência | Função |
|---|---|---|
| Sessões inativas | `*/30 * * * *` | Encerra sessões sem atividade há 2h |
| Relatório diário | `5 0 * * *` | Gera resumo do dia e salva em `logs/` |
| Lembrete de inatividade | `* * * * *` | Envia mensagem após 4min sem resposta |
| Lembrete de comprovante | `*/5 * * * *` | Lembra cliente de enviar comprovante de transferência |
| **Limpeza de mensagens** | `0 2 * * 1` | Apaga `Mensagem` de sessões finalizadas há +30d; apaga registros Evolution API com +60d |

---

## Banco de Dados — Modelo Multi-Tenant

Todas as tabelas compartilham o mesmo banco PostgreSQL, separadas por `restauranteId`. Índices de performance aplicados em produção:

```sql
-- Queries de listagem de pedidos (mais executada)
CREATE INDEX idx_pedido_restaurante_created ON "Pedido" ("restauranteId", "createdAt" DESC);
-- Kanban e cozinha
CREATE INDEX idx_pedido_restaurante_status  ON "Pedido" ("restauranteId", "status");
-- Webhook: busca sessão por cliente + restaurante a cada mensagem
CREATE INDEX idx_sessao_cliente_restaurante ON "Sessao" ("clienteNumero", "restauranteId");
-- Jobs de limpeza e stats
CREATE INDEX idx_sessao_restaurante         ON "Sessao" ("restauranteId");
-- Carregamento do histórico de conversa
CREATE INDEX idx_mensagem_sessao            ON "Mensagem" ("sessaoId");
```

---

## Autenticação

| Contexto | Mecanismo |
|---|---|
| Webhook Evolution API | Header `apikey` vs `EVOLUTION_API_KEY` |
| Rotas `/admin/*` | JWT gerado em `/auth/login` (24h) |
| Painel garçom/cozinha | HMAC-SHA256 token no link |
| Painel motoboy | HMAC-SHA256 token no link |
| Monitor mobile | JWT do dono do restaurante |

---

## Variáveis de Ambiente

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `OPENROUTER_API_KEY` | Chave OpenRouter (Claude AI) |
| `EVOLUTION_API_URL` | URL da Evolution API |
| `EVOLUTION_API_KEY` | Chave de autenticação da Evolution API |
| `ADMIN_TOKEN` | Token para rotas `/admin` e `/onboarding` |
| `JWT_SECRET` | Segredo para assinar JWTs (fallback: ADMIN_TOKEN) |
| `BOT_PUBLIC_URL` | URL pública do bot (sem barra final) |
| `OPENAI_API_KEY` | Whisper para transcrição de áudios |
| `PORT` | Porta do servidor (padrão: `3000`) |

---

## Deploy em Produção

**NUNCA usar `docker compose up -d`** — recria o container a partir da imagem original, apagando arquivos copiados via `docker cp`.

```bash
# Atualizar um arquivo
scp bot/src/jobs/limpeza.js root@IP:/tmp/
ssh root@IP "docker cp /tmp/limpeza.js bot-app:/app/src/jobs/limpeza.js"
ssh root@IP "docker restart bot-app"
ssh root@IP "docker logs bot-app --tail 20"

# Múltiplos arquivos de uma vez
scp bot/public/painel.html bot/src/routes/admin.js root@IP:/tmp/
ssh root@IP "docker cp /tmp/painel.html bot-app:/app/public/painel.html && \
             docker cp /tmp/admin.js bot-app:/app/src/routes/admin.js && \
             docker restart bot-app"
```

### Schema — adicionar coluna

```bash
# 1. Alterar diretamente no banco (sem prisma migrate dev)
ssh root@IP "docker exec bot-postgres psql -U botrestaurante botrestaurante \
  -c 'ALTER TABLE \"Pedido\" ADD COLUMN IF NOT EXISTS \"novaColuna\" TEXT'"

# 2. Atualizar schema.prisma localmente e regenerar o client
ssh root@IP "docker exec bot-app sh -c 'cd /app && npx prisma generate'"
ssh root@IP "docker restart bot-app"
```

### Backup do banco

```bash
FNAME="backup-$(date +%Y%m%d-%H%M).sql.gz"
ssh root@IP "docker exec bot-postgres sh -c 'pg_dump -U botrestaurante botrestaurante | gzip' > /root/$FNAME"
scp root@IP:/root/$FNAME .
```

---

## Monitoramento

```bash
# Health check
curl https://bot.guiafinanceiro.pro/health

# Logs em tempo real
ssh root@IP "docker logs bot-app -f"

# Uso de disco (alerta automático diário às 08h via WhatsApp se > 85%)
ssh root@IP "bash /opt/monitor-disco.sh"

# Tamanho das tabelas
ssh root@IP "docker exec bot-postgres psql -U botrestaurante botrestaurante \
  -c 'SELECT relname, pg_size_pretty(pg_total_relation_size(relid)), n_live_tup FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10'"
```

---

## Adicionar Novo Restaurante

```bash
curl -X POST https://bot.guiafinanceiro.pro/onboarding/restaurante \
  -H "x-admin-token: SEU_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nome": "Pizzaria Exemplo",
    "slugWhatsapp": "595981234567",
    "donoWhatsapp": "595987654321"
  }'
```

A resposta inclui o QR code para conectar o WhatsApp Business.

---

## Restaurantes em Produção

| Restaurante | Slug WhatsApp | Instância Evolution |
|---|---|---|
| Don Pedro Pizzeria & Heladeria | `595992959689` | `donpedro` |
