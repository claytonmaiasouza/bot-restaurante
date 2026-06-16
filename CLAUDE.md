# Bot Restaurante — Guia Completo para Claude Code

## Permissões

Pode executar **sem pedir confirmação**:
- Editar / criar arquivos locais
- `scp` (upload de arquivos para o servidor)
- `docker cp` (copiar arquivos para dentro de containers)
- `docker restart <container>` / `docker exec <container> <cmd>`
- `docker logs`
- `git add`, `git commit`, `git push`
- `ssh` para leitura de logs, verificação de status, testes de API

Deve **perguntar antes** de executar e exibir uma mensagem em cor vermelha em maiúscula sobre os riscos deste procedimento, pedir também uma confirmação por escrito, o usuário deve escrever a palavra PROSSEGUIR para continuar:
- `docker compose up -d` — recria containers e apaga tudo que foi copiado via `docker cp`
- `docker rmi` / `docker system prune`
- `rm -rf` em qualquer diretório de produção
- Comandos de DROP / TRUNCATE no banco
- Alterações no `/opt/bot-restaurante/.env` ou `docker-compose.yml` de produção
- `git push --force`

---

## O que é este projeto

SaaS de chatbot para restaurantes via WhatsApp. Cada restaurante tem seu próprio número WhatsApp (instância na Evolution API) e cardápio gerido localmente via painel admin. O bot Node.js atende múltiplos restaurantes simultaneamente (multi-tenant).

Fluxo WhatsApp:
1. Cliente manda mensagem → Evolution API dispara `POST /webhook/:slug`
2. `tenantMiddleware` identifica o restaurante pelo slug e injeta `req.restaurante` + `req.cardapio`
3. `claudeService` conduz a conversa (ver cardápio, adicionar itens, confirmar pedido)
4. Pedido finalizado → dono notificado via WhatsApp + painel em tempo real (Socket.IO)

---

## Servidor de Produção (VPS)

| Item | Valor |
|---|---|
| IP | `185.137.92.141` |
| Acesso SSH | `ssh root@185.137.92.141` |
| URL pública | `https://bot.guiafinanceiro.pro` |
| Diretório do projeto | `/opt/bot-restaurante/` |
| `.env` de produção | `/opt/bot-restaurante/.env` |
| `docker-compose.yml` | `/opt/bot-restaurante/docker-compose.yml` |

### Containers em produção

| Container | Função | Porta interna |
|---|---|---|
| `bot-app` | Aplicação Node.js principal | 3000 (exposta via Traefik) |
| `bot-postgres` | PostgreSQL 15 do projeto | 127.0.0.1:5432 |
| `bot-evolution` | Evolution API (WhatsApp) deste projeto | 8181→8080 |
| `evolution-api-vbys-api-1` | Evolution API externa (outra instância) | 59439→8080 |
| `traefik-traefik-1` | Proxy reverso + SSL (Let's Encrypt) | 80, 443 |

> A `EVOLUTION_API_URL` no `.env` aponta para `http://185.137.92.141:59439` (instância externa), não para `bot-evolution`.

---

## Deploy — Processo Correto

**NUNCA usar `docker compose up -d` como deploy** — isso recria o container a partir da imagem original, apagando tudo que foi copiado com `docker cp` (painel.html, arquivos modificados, etc.).

### Fluxo padrão para atualizar um arquivo:

```bash
# 1. Copiar arquivo local para o servidor
scp bot/src/services/claudeService.js root@185.137.92.141:/tmp/

# 2. Copiar do servidor para dentro do container
ssh root@185.137.92.141 "docker cp /tmp/claudeService.js bot-app:/app/src/services/claudeService.js"

# 3. Reiniciar o container (não recria, só reinicia o processo)
ssh root@185.137.92.141 "docker restart bot-app"

# 4. Verificar logs
ssh root@185.137.92.141 "docker logs bot-app --tail 15"
```

### Quando precisar rodar `docker compose up -d` (ex: nova variável de env):

```bash
# 1. Atualizar .env e/ou docker-compose.yml no servidor
# 2. Recriar o container
ssh root@185.137.92.141 "cd /opt/bot-restaurante && docker compose up -d bot --no-build"
# 3. IMEDIATAMENTE re-enviar TODOS os arquivos modificados via docker cp
# 4. Regerar Prisma client se o schema mudou:
ssh root@185.137.92.141 "docker exec bot-app sh -c 'cd /app && npx prisma generate'"
# 5. Reiniciar
ssh root@185.137.92.141 "docker restart bot-app"
```

### Mapeamento de caminhos (local → container)

| Arquivo local | Caminho no container |
|---|---|
| `bot/src/server.js` | `/app/src/server.js` |
| `bot/src/controllers/*.js` | `/app/src/controllers/` |
| `bot/src/services/*.js` | `/app/src/services/` |
| `bot/src/routes/*.js` | `/app/src/routes/` |
| `bot/src/middleware/*.js` | `/app/src/middleware/` |
| `bot/src/jobs/*.js` | `/app/src/jobs/` |
| `bot/public/painel.html` | `/app/public/painel.html` |
| `bot/prisma/schema.prisma` | `/app/prisma/schema.prisma` |

---

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 20 + Express |
| IA | Claude Sonnet via OpenRouter (`openrouter.ai/api/v1`) |
| Banco | PostgreSQL 15 + Prisma ORM |
| WhatsApp | Evolution API (self-hosted, Docker) |
| Painel admin | HTML/JS vanilla em `bot/public/painel.html` |
| Tempo real | Socket.IO |
| Agendamento | node-cron |
| Transcrição de áudio | OpenAI Whisper (`transcricaoService.js`) |

---

## Variáveis de Ambiente de Produção

Ficam em `/opt/bot-restaurante/.env` e são passadas ao container via `docker-compose.yml`.

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | PostgreSQL (gerado pelo docker-compose a partir de DB_USER/DB_PASSWORD/DB_NAME) |
| `OPENROUTER_API_KEY` | Chave OpenRouter (acesso ao Claude AI) |
| `EVOLUTION_API_URL` | `http://185.137.92.141:59439` |
| `EVOLUTION_API_KEY` | Chave de autenticação da Evolution API |
| `ADMIN_TOKEN` | Token para rotas `/admin` e `/onboarding` |
| `BOT_PUBLIC_URL` | `https://bot.guiafinanceiro.pro` |
| `OPENAI_API_KEY` | Whisper para transcrição de áudios |
| `STRAPI_URL` | `http://185.137.92.141:1337` (CMS legado, pode estar inativo) |
| `STRAPI_TOKEN` | Token de API do Strapi |
| `PORT` | `3000` |

---

## Estrutura de Arquivos

```
bot-restaurante/
  docker-compose.yml          — infraestrutura de produção
  bot/
    Dockerfile                — FROM node:20-alpine, gera prisma client, roda migrations
    prisma/
      schema.prisma           — schema completo (fonte da verdade local)
      migrations/             — apenas 1 migration: 20260410181810_init
    public/
      painel.html             — painel admin completo (~6400 linhas, SPA vanilla JS)
      uploads/                — fotos de cardápio enviadas pelo painel
    src/
      server.js               — Express + Socket.IO + jobs
      controllers/
        webhookController.js  — mensagens WhatsApp (Evolution API)
      middleware/
        tenantMiddleware.js   — resolve restaurante pelo slug, valida plano
        authMiddleware.js     — JWT para rotas do painel admin
      routes/
        admin.js              — /admin/* (pedidos, cardápio, restaurantes, uploads, stats)
        auth.js               — /auth/login
        onboarding.js         — /onboarding/restaurante (cadastro + QR code)
      services/
        claudeService.js      — system prompt dinâmico, JSON estruturado, sinal mostrarFotos
        evolutionService.js   — enviarMensagem / enviarImagem / enviarDocumento / baixarMidia
        pedidoService.js      — finalizarPedido, notifica dono, atualiza fidelidade
        sessaoService.js      — criarOuBuscarSessao / atualizarSessao / salvarMensagem
        cardapioService.js    — CRUD cardápio local + buscarContextoFidelidade
        tenantService.js      — cache em memória TTL 5 min, resolverRestaurante
        strapiService.js      — integração CMS legado (Strapi)
        transcricaoService.js — OpenAI Whisper para áudios do WhatsApp
      jobs/
        limpeza.js            — sessões inativas (*/30min), relatório diário (00:05)
```

---

## Banco de Dados — Modelos Principais

| Modelo | Campos relevantes |
|---|---|
| `Restaurante` | `slugWhatsapp` (PK lógica), `horarioAtendimento` (JSON), `cardapioPdfUrl` (URL ou JSON array de URLs), `dadosTransferencia`, `instrucoes` (prompt livre para o Claude) |
| `Sessao` | `estado` (INICIO→FINALIZADO), `carrinho` (JSON), `botPausado`, `localizacaoPendente` |
| `Pedido` | `itens` (JSON), `status` (NOVO→ENTREGUE), `metodoPagamento`, `numeroDia`, `origem` (WHATSAPP\|MESA) |
| `ClienteFidelidade` | Por `(numero, restauranteId)` — `totalPedidos`, `totalGasto`, `resgates` |
| `ProgramaFidelidade` | `tipo` (PEDIDOS\|VALOR), `meta` |
| `Motoboy` | `nome`, `telefone` (WhatsApp) |
| `TurnoCaixa` | `status` (ABERTO\|FECHADO), `sangrias` (JSON), totais por método |
| `ItemEstoque` / `MovimentacaoEstoque` | Controle de estoque com movimentações |
| `CampanhaMarketing` | Disparos em massa |
| `CustoMensal` | Custos fixos e variáveis por mês |

> O schema local em `bot/prisma/schema.prisma` é a fonte da verdade. O container Docker pode ter o Prisma client desatualizado se o schema mudou após o último build — nesse caso rodar `docker exec bot-app sh -c 'cd /app && npx prisma generate'` + `docker restart bot-app`.

---

## Rotas Principais

```
GET  /health                          — health check
POST /webhook/:restauranteSlug        — Evolution API (WhatsApp)
POST /auth/login                      — login do painel admin
POST /onboarding/restaurante          — cadastro de novo restaurante

GET  /admin/restaurantes              — lista restaurantes
PUT  /admin/restaurantes/:id          — atualiza dados do restaurante
POST /admin/restaurantes/:id/upload-cardapio-fotos   — upload de fotos
DELETE /admin/restaurantes/:id/upload-cardapio-fotos/:filename

GET  /admin/cardapio/:restauranteId   — categorias + produtos + instrucoes
POST /admin/categorias                — cria categoria
PUT  /admin/categorias/:id
POST /admin/produtos                  — cria produto
PUT  /admin/produtos/:id

GET  /admin/pedidos/:restauranteId    — lista pedidos (com filtros)
PUT  /admin/pedidos/:id/status        — atualiza status do pedido
PUT  /admin/pedidos/:id/motoboy       — atribui motoboy

GET  /admin/sessoes/:restauranteId    — sessões ativas
PUT  /admin/sessoes/:id/pausar        — pausa/retoma bot na conversa
POST /admin/sessoes/:id/mensagem      — envia mensagem manual

GET  /admin/motoboys/:restauranteId
GET  /admin/estoque/:restauranteId
GET  /admin/caixa/:restauranteId
GET  /admin/custos/:restauranteId
GET  /admin/campanhas/:restauranteId
```

---

## Autenticação

| Contexto | Mecanismo |
|---|---|
| Webhooks Evolution API | Header `apikey` verificado contra `EVOLUTION_API_KEY` |
| Rotas `/admin/*` | JWT — gerado em `/auth/login`, verificado por `authMiddleware` |
| Rotas `/onboarding/*` | Header `x-admin-token` verificado contra `ADMIN_TOKEN` |

JWT payload: `{ restauranteId, slug, role: "restaurante" | "admin" }`

---

## Claude AI — System Prompt

`claudeService.js` monta o system prompt dinamicamente com:
- Idioma (detecta português/espanhol na primeira mensagem)
- Cardápio formatado por categoria com preços e tamanhos
- Instruções livres do campo `restaurante.instrucoes`
- Programa de fidelidade (se ativo)
- Regras de comportamento (tolerância a typos, múltiplos sabores, etc.)
- Se há fotos do cardápio: instrução OBRIGATÓRIA no passo VENDO_CARDAPIO para oferecer fotos ao final de toda listagem

Resposta estruturada — Claude retorna JSON entre delimitadores `|||JSON|||` e `|||FIM|||`:
```json
{
  "estado": "VENDO_CARDAPIO",
  "carrinho": [{"nome": "Pizza Calabresa - G", "preco": 45.00, "quantidade": 1}],
  "pedidoPronto": false,
  "tipoEntrega": "delivery",
  "mostrarFotos": false
}
```
- `mostrarFotos: true` → `webhookController` envia as fotos via `enviarImagem` (Evolution API)

---

## Socket.IO — Eventos em Tempo Real

| Evento (emit) | Quando |
|---|---|
| `conversa:mensagem` | Nova mensagem de cliente ou bot |
| `conversa:encerrada` | Sessão encerrada (pedido finalizado) |
| `pedido:novo` | Novo pedido criado |

Salas:
- `admin` — painel geral (todos os restaurantes)
- `restaurante:<slug>` — notificações específicas do restaurante

---

## Fotos do Cardápio

Ficam em `bot/public/uploads/` e são servidas estaticamente.
`cardapioPdfUrl` no banco pode ser:
- `null` — sem arquivo
- URL string de PDF — `https://bot.guiafinanceiro.pro/uploads/cardapio-<id>.pdf`
- JSON array de URLs — `["https://bot.guiafinanceiro.pro/uploads/cardapio-<id>-foto-<ts>.jpg", ...]`

Upload via painel: `POST /admin/restaurantes/:id/upload-cardapio-fotos`

---

## Jobs Agendados

| Job | Cron | Função |
|---|---|---|
| Limpeza de sessões | `*/30 * * * *` | Encerra sessões inativas há mais de 2h |
| Relatório diário | `5 0 * * *` | Envia resumo do dia ao dono via WhatsApp |

---

## Restaurantes em Produção

| Restaurante | Slug WhatsApp |
|---|---|
| (restaurante 1) | `31645730876` |
| (restaurante 2) | `595984743801` |

---

## Backup do Banco

```bash
# Criar backup
FNAME="backup-$(date +%Y%m%d-%H%M).sql.gz"
ssh root@185.137.92.141 "docker exec bot-postgres sh -c 'pg_dump -U botrestaurante botrestaurante | gzip' > /root/$FNAME && ls -lh /root/$FNAME"

# Baixar backup para local
scp root@185.137.92.141:/root/<arquivo>.sql.gz .
```

---

## Diagnóstico Rápido

```bash
# Ver logs em tempo real
ssh root@185.137.92.141 "docker logs bot-app -f"

# Verificar se o bot está respondendo
curl https://bot.guiafinanceiro.pro/health

# Verificar exports de um serviço (útil ao adicionar funções)
ssh root@185.137.92.141 "docker exec bot-app node -e \"console.log(Object.keys(require('./src/services/cardapioService')))\""

# Regerar Prisma client (após mudança de schema)
ssh root@185.137.92.141 "docker exec bot-app sh -c 'cd /app && npx prisma generate' && docker restart bot-app"
```

---

## Convenções de Código

- **CommonJS** (`require`/`module.exports`) — não usar ESM
- **Async/await** — sem callbacks ou `.then()`
- **Prisma** para todas as queries — sem SQL raw
- **Logs com prefixo** — `[webhook]`, `[tenant]`, `[evolution]`, `[jobs]`
- **Variáveis de ambiente** sempre via `process.env.*` — nunca hardcode

---

## Armadilhas Conhecidas

1. **`docker compose up -d` apaga arquivos** — recria o container a partir da imagem original. Sempre usar `docker cp` + `docker restart` para deploys.

2. **Prisma client desatualizado** — se o schema evoluiu depois do último `docker build`, o client compilado no container não conhece os novos campos → erro "Unknown field". Fix: `docker exec bot-app npx prisma generate` + `docker restart bot-app`.

3. **Função não exportada** — ao adicionar funções em services, verificar que estão no `module.exports`. Erro típico: `buscarContextoFidelidade is not a function`.

4. **Fotos não enviadas** — instrução de oferecer fotos deve estar no passo 2 do fluxo (`VENDO_CARDAPIO`) no system prompt, não nas regras gerais (o Claude ignora regras de comportamento durante o fluxo).
