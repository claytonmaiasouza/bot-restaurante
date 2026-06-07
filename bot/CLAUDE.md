# Bot Restaurante — Guia para Claude Code

## O que é este projeto

SaaS de chatbot para restaurantes via WhatsApp e Telegram. Cada restaurante tem seu próprio número WhatsApp (instância na Evolution API) e cardápio gerido localmente via painel admin. O mesmo bot Node.js atende múltiplos restaurantes simultaneamente (multi-tenant).

Fluxo WhatsApp:
1. Cliente manda mensagem → Evolution API dispara `POST /webhook/:slug`
2. `tenantMiddleware` identifica o restaurante pelo slug e injeta `req.restaurante` + `req.cardapio`
3. `claudeService` conduz a conversa (ver cardápio, adicionar itens, confirmar pedido)
4. Pedido finalizado → dono notificado via WhatsApp + painel em tempo real (Socket.IO)

---

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 20 + Express |
| IA | Claude Sonnet via OpenRouter (`openrouter.ai/api/v1`) |
| Banco | PostgreSQL 15 + Prisma ORM |
| WhatsApp | Evolution API (self-hosted, Docker) |
| Telegram | Telegram Bot API (webhook) |
| Painel admin | HTML/JS vanilla em `bot/public/painel.html` |
| Tempo real | Socket.IO |
| Agendamento | node-cron |
| Transcrição de áudio | OpenAI Whisper (`transcricaoService.js`) |

---

## Variáveis de ambiente obrigatórias

```
DATABASE_URL          — PostgreSQL
OPENROUTER_API_KEY    — Chave OpenRouter (acesso ao Claude AI)
EVOLUTION_API_URL     — http://185.137.92.141:59439
EVOLUTION_API_KEY     — chave de autenticação da Evolution API
ADMIN_TOKEN           — token secreto para rotas /admin, /onboarding e webhook Telegram
BOT_PUBLIC_URL        — https://bot.guiafinanceiro.pro
OPENAI_API_KEY        — Whisper para transcrição de áudios
TELEGRAM_BOT_TOKEN    — token do bot Telegram
TELEGRAM_RESTAURANTE_SLUG — slug do restaurante associado ao bot Telegram
PORT                  — 3000
```

---

## Estrutura de arquivos

```
bot/src/
  server.js                     — Express + Socket.IO + jobs + auto-config webhook Telegram
  controllers/
    webhookController.js        — mensagens WhatsApp (Evolution API)
    telegramController.js       — mensagens Telegram
  middleware/
    tenantMiddleware.js         — resolve restaurante pelo slug, valida plano
    authMiddleware.js           — JWT para rotas do painel admin
  routes/
    admin.js                    — /admin/* (pedidos, cardápio, restaurantes, uploads, stats)
    auth.js                     — /auth/login
    onboarding.js               — /onboarding/restaurante (cadastro + QR code)
    painel.js                   — /painel/* (motoboy PWA: auth, pedidos, push notifications)
    telegram.js                 — /telegram/webhook
  services/
    claudeService.js            — system prompt dinâmico, JSON estruturado, sinal mostrarFotos
    evolutionService.js         — enviarMensagem / enviarImagem / enviarDocumento / baixarMidia
    telegramService.js          — enviarMensagemTelegram / enviarFotoTelegram / configurarWebhook
    pedidoService.js            — finalizarPedido, notifica dono, atualiza fidelidade
    sessaoService.js            — criarOuBuscarSessao / atualizarSessao / salvarMensagem
    cardapioService.js          — CRUD cardápio local + buscarContextoFidelidade + importarCardapio
    tenantService.js            — cache em memória TTL 5 min, resolverRestaurante
    transcricaoService.js       — OpenAI Whisper para áudios do WhatsApp
  jobs/
    limpeza.js                  — sessões inativas (*/30min), relatório diário (00:05)
  scripts/
    seed-pedidos-teste.js       — cria pedidos de teste no banco
```

---

## Convenções de código

- **CommonJS** (`require`/`module.exports`) — não usar ESM
- **Async/await** — sem callbacks ou `.then()`
- **Prisma** para todas as queries — sem SQL raw
- **Logs com prefixo** — `[webhook]`, `[telegram]`, `[tenant]`, `[evolution]`, `[jobs]`
- **Variáveis de ambiente** sempre via `process.env.*` — nunca hardcode

---

## Modelos Prisma relevantes

- `Restaurante` — tenant principal, `slugWhatsapp` é a PK lógica; `strapiId` é campo legado (null para restaurantes criados pelo painel)
- `Sessao` — conversa ativa por cliente+restaurante, armazena estado e carrinho (JSON)
- `Pedido` — criado ao finalizar sessão, `numeroDia` é contador global crescente (não reseta)
- `ClienteFidelidade` — histórico por `(numero, restauranteId)`
- `Motoboy` — entregadores, autenticados via HMAC-SHA256 no painel `/motoboy.html`
