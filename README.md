# Bot Restaurante — SaaS Multi-Tenant para WhatsApp

Plataforma de chatbot inteligente para restaurantes via WhatsApp, construída com Claude AI, Evolution API e PostgreSQL. Cada restaurante tem seu próprio número WhatsApp, cardápio e painel admin independentes.

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
              Bot (Node.js)
         ┌────────────────────┐
         │  tenantMiddleware  │
         │  claudeService     │
         │  sessaoService     │
         │  pedidoService     │
         └────────┬───────────┘
                  │
             PostgreSQL
         (restaurantes, sessões,
          pedidos, fidelidade,
          estoque, caixa)
                  │
                  ▼
        Dono do Restaurante
       (WhatsApp + Painel Admin)
```

| Serviço | Tecnologia | Papel |
|---|---|---|
| **Bot** | Node.js 20 + Express | Chatbot + API admin + painel motoboy |
| **IA** | Claude Sonnet via OpenRouter | Compreensão de linguagem natural |
| **WhatsApp** | Evolution API (Docker) | Gateway de mensagens |
| **Banco** | PostgreSQL 15 + Prisma | Persistência de todos os dados |
| **Proxy** | Traefik | SSL automático (Let's Encrypt) + roteamento |
| **Tempo real** | Socket.IO | Painel admin ao vivo |

---

## Funcionalidades

- **Multi-tenant**: um bot atende N restaurantes simultaneamente
- **Cardápio dinâmico**: gerido pelo painel admin (categorias, produtos, tamanhos, fotos)
- **Pedidos com numeração global**: contador crescente, nunca reseta
- **Programa de fidelidade**: por pedidos ou valor gasto
- **Fotos do cardápio**: enviadas automaticamente quando solicitadas
- **Transcrição de áudio**: cliente pode pedir por voz (OpenAI Whisper)
- **Comprovante de pagamento**: cliente envia foto, painel exibe thumbnail
- **Painel motoboy (PWA)**: app instalável no celular, com push notifications para novas entregas
- **Rastreamento de entrega**: cliente acompanha localização do motoboy em tempo real
- **Controle de estoque e caixa**: turno de caixa, sangrias, movimentações
- **Campanhas de marketing**: disparos em massa via WhatsApp

---

## Estrutura de Pastas

```
bot-restaurante/
  docker-compose.yml          — infraestrutura de produção
  bot/
    Dockerfile                — FROM node:20-alpine
    prisma/
      schema.prisma           — schema completo (fonte da verdade)
      migrations/             — migrations do banco
    public/
      painel.html             — painel admin (SPA vanilla JS)
      motoboy.html            — painel motoboy (PWA)
      rastrear.html           — página de rastreamento para o cliente
      sw-motoboy.js           — service worker do PWA motoboy
      icons/                  — ícones PWA (SVG + PNG)
      uploads/                — fotos de cardápio e comprovantes
    src/
      server.js               — Express + Socket.IO + jobs
      controllers/
        webhookController.js  — mensagens WhatsApp
      middleware/
        tenantMiddleware.js   — resolve restaurante pelo slug
        authMiddleware.js     — JWT para rotas do painel admin
      routes/
        admin.js              — /admin/* (CRUD completo)
        auth.js               — /auth/login
        onboarding.js         — /onboarding/restaurante
        painel.js             — /painel/* (motoboy + push notifications)
      services/
        claudeService.js      — system prompt dinâmico + JSON estruturado
        evolutionService.js   — envio de mensagens e mídia (WhatsApp)
        pedidoService.js      — finaliza pedido, notifica dono, fidelidade
        sessaoService.js      — CRUD de sessões e mensagens
        cardapioService.js    — CRUD de cardápio local
        tenantService.js      — cache em memória TTL 5 min
        transcricaoService.js — OpenAI Whisper para áudios
      jobs/
        limpeza.js            — sessões inativas + relatório diário
```

---

## Variáveis de Ambiente

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `OPENROUTER_API_KEY` | Chave OpenRouter (acesso ao Claude AI) |
| `EVOLUTION_API_URL` | URL da Evolution API |
| `EVOLUTION_API_KEY` | Chave de autenticação da Evolution API |
| `ADMIN_TOKEN` | Token para rotas `/admin` e `/onboarding` |
| `BOT_PUBLIC_URL` | URL pública do bot (sem barra final) |
| `OPENAI_API_KEY` | Whisper para transcrição de áudios |
| `PORT` | Porta do servidor (padrão: `3000`) |

---

## Deploy em Produção

O deploy é feito via `scp` + `docker cp` + `docker restart` — **nunca** via `docker compose up -d` (recriaria o container apagando arquivos copiados).

```bash
# Copiar arquivo atualizado para o container
scp bot/src/services/claudeService.js root@IP:/tmp/
ssh root@IP "docker cp /tmp/claudeService.js bot-app:/app/src/services/claudeService.js"
ssh root@IP "docker restart bot-app"
ssh root@IP "docker logs bot-app --tail 20"
```

### Backup do banco

```bash
FNAME="backup-$(date +%Y%m%d-%H%M).sql.gz"
ssh root@IP "docker exec bot-postgres sh -c 'pg_dump -U botrestaurante botrestaurante | gzip' > /root/$FNAME"
scp root@IP:/root/$FNAME .
```

---

## Adicionar Novo Restaurante

```bash
curl -X POST https://seudominio.com/onboarding/restaurante \
  -H "x-admin-token: SEU_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nome": "Pizzaria Exemplo",
    "slugWhatsapp": "5511999999999",
    "donoWhatsapp": "5511888888888"
  }'
```

A resposta inclui o QR code para conectar o WhatsApp Business. Após escanear, o cardápio é gerido inteiramente pelo painel admin.

---

## Painel Admin

Acesse `https://seudominio.com/painel.html` e faça login com as credenciais do restaurante.

Funcionalidades:
- Pedidos em tempo real (Socket.IO)
- Gestão de cardápio (categorias, produtos, tamanhos, fotos)
- Sessões ativas e envio de mensagens manuais
- Controle de caixa e estoque
- Programa de fidelidade
- Campanhas de marketing
- Relatórios e estatísticas

## Painel Motoboy (PWA)

Acesse `https://seudominio.com/motoboy.html?slug=SLUG&t=TOKEN` no celular.

- Instalável como app na tela inicial (Web App Manifest + Service Worker)
- Recebe push notifications para novas entregas (mesmo com app fechado)
- Auto-cadastro: motoboy cria sua própria conta pelo link, sem precisar de admin
- Rastreamento: cliente acompanha localização do motoboy em tempo real

---

## Diagnóstico Rápido

```bash
# Health check
curl https://seudominio.com/health

# Logs em tempo real
ssh root@IP "docker logs bot-app -f"

# Verificar exports de um serviço
ssh root@IP "docker exec bot-app node -e \"console.log(Object.keys(require('./src/services/cardapioService')))\""

# Regerar Prisma client após mudança de schema
ssh root@IP "docker exec bot-app sh -c 'cd /app && npx prisma generate' && docker restart bot-app"
```
