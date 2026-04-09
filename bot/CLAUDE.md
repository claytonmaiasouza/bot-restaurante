# Bot Restaurante — Guia para Claude Code

## O que é este projeto

SaaS de chatbot para restaurantes via WhatsApp. Cada restaurante tem seu próprio número WhatsApp (instância na Evolution API) e cardápio gerido no Strapi CMS. O mesmo bot Node.js atende múltiplos restaurantes simultaneamente (multi-tenant).

Quando um cliente manda mensagem para o WhatsApp de um restaurante:
1. A Evolution API dispara um webhook POST `/webhook/:slug`
2. O bot identifica o restaurante pelo slug (número WA)
3. O Claude AI conduz a conversa (ver cardápio, adicionar itens, confirmar pedido)
4. Quando o cliente envia a localização, o pedido é finalizado e o dono é notificado via WhatsApp

---

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 20 + Express |
| IA | Claude claude-sonnet-4-5 via `@anthropic-ai/sdk` |
| Banco | PostgreSQL 15 + Prisma ORM |
| WhatsApp | Evolution API (self-hosted, Docker) |
| CMS | Strapi v5 (SQLite) |
| Tempo real | Socket.IO |
| Agendamento | node-cron |

---

## Como rodar localmente

```bash
# 1. Infraestrutura
cd bot-restaurante
docker compose up -d          # sobe PostgreSQL + Evolution API

# 2. Bot
cd bot
cp .env.example .env          # preencher as chaves
npm install
npx prisma migrate dev --name init
npm run dev                   # porta 3000

# 3. CMS
cd ../strapi
npm install
cp .env.example .env          # preencher APP_KEYS
npm run develop               # porta 1337
npm run seed                  # dados de exemplo (após primeiro start)
```

---

## Variáveis de ambiente obrigatórias (bot/.env)

```
DATABASE_URL          — PostgreSQL (docker: postgresql://user:pass@localhost:5432/botrestaurante)
ANTHROPIC_API_KEY     — Chave Claude API
EVOLUTION_API_URL     — http://localhost:8080
EVOLUTION_API_KEY     — sua-chave-evolution (igual ao docker-compose)
STRAPI_URL            — http://localhost:1337
STRAPI_TOKEN          — token gerado em Settings → API Tokens no Strapi
ADMIN_TOKEN           — token secreto para rotas /admin e /onboarding
BOT_PUBLIC_URL        — URL pública do bot (para configurar webhooks da Evolution)
PORT                  — 3000 (padrão)
```

---

## Estrutura de arquivos

```
bot/src/
  server.js                     — Express + Socket.IO + jobs
  controllers/
    webhookController.js        — processa mensagens recebidas do WhatsApp
  middleware/
    tenantMiddleware.js         — resolve restaurante pelo slug, valida plano
  routes/
    admin.js                    — /admin/* (pedidos, stats, instâncias)
    onboarding.js               — /onboarding/* (cadastro de novo restaurante)
  services/
    claudeService.js            — integração Claude AI, monta system prompt dinâmico
    evolutionService.js         — envio de mensagens + gestão de instâncias WA
    pedidoService.js            — finaliza pedido, notifica dono, atualiza fidelidade
    sessaoService.js            — CRUD de sessões, encerra inativas
    strapiService.js            — busca restaurante e cardápio no Strapi
    tenantService.js            — resolução multi-tenant com cache em memória
  jobs/
    limpeza.js                  — crons: sessões inativas, relatório diário, sync Strapi
```

---

## Fluxo multi-tenant

```
POST /webhook/:slug
  → validarWebhook (chave Evolution API no header)
  → tenantMiddleware
      → cache hit? retorna restaurante + cardápio
      → banco local? retorna + atualiza cache
      → Strapi? cria local + cache → retorna
      → inativo? 404
      → plano vencido? 403
  → webhookController.receberMensagem
      → usa req.restaurante e req.cardapio (já resolvidos)
```

O cache em memória do `tenantService` tem TTL de 5 minutos. O cron de sincronização a cada 10 minutos invalida o cache após atualizar os dados do Strapi.

---

## Onboarding de novo restaurante

```bash
curl -X POST http://localhost:3000/onboarding/restaurante \
  -H "x-admin-token: SEU_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "strapiId": 1, "slug": "5511999999999" }'
```

Retorna um QR code (base64) para o dono escanear com o WhatsApp Business.

---

## Convenções de código

- **CommonJS** (`require`/`module.exports`) — não usar ESM
- **Async/await** em todo código assíncrono — sem callbacks ou `.then()`
- **Prisma** para todas as queries — sem SQL raw
- **Sem try/catch desnecessário** — deixar subir para o handler de erro da rota
- **Logs com prefixo** — `[webhook]`, `[tenant]`, `[evolution]`, `[jobs]`, etc.
- **Comentários só onde a lógica não é óbvia** — não comentar o óbvio
- **Variáveis de ambiente** sempre via `process.env.*` — nunca hardcode de credenciais

---

## Modelos Prisma relevantes

- `Restaurante` — tenant principal, identificado por `slugWhatsapp`
- `Sessao` — conversa ativa por cliente+restaurante, armazena estado e carrinho (JSON)
- `Pedido` — criado ao finalizar sessão, inclui itens (JSON) e localização
- `ClienteFidelidade` — histórico cross-tenant por número de WhatsApp
- `Mensagem` — log de cada troca para alimentar o histórico do Claude

---

## Adicionando um novo restaurante (passo a passo)

1. Criar restaurante no Strapi (`http://localhost:1337/admin`)
2. Adicionar cardápio, categorias e produtos
3. Chamar `POST /onboarding/restaurante` com o strapiId e slug
4. Escanear o QR code com o WhatsApp Business do restaurante
5. Testar enviando uma mensagem para o número conectado
