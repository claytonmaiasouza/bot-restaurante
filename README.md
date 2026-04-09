# Bot Restaurante — SaaS Multi-Tenant para WhatsApp

Plataforma de chatbot inteligente para restaurantes via WhatsApp, construída com Claude AI, Evolution API e Strapi CMS. Cada restaurante tem seu próprio número WhatsApp, cardápio e sessões de conversa totalmente independentes.

---

## Arquitetura

```
Cliente WhatsApp
      │
      ▼
Evolution API ──── webhook POST /webhook/:slug ────▶ Nginx
                                                       │
                                          ┌────────────┴────────────┐
                                          ▼                         ▼
                                   Bot (Node.js)             Strapi CMS
                                   ┌────────────┐          (cardápios, planos)
                                   │ tenantMidd.│
                                   │ claudeServ.│
                                   │ sessaoServ.│
                                   └─────┬──────┘
                                         │
                                    PostgreSQL
                                   (sessões, pedidos,
                                    fidelidade)
                                         │
                                         ▼
                                  Dono do Restaurante
                                 (WhatsApp Business)
```

| Serviço | Tecnologia | Porta | Papel |
|---|---|---|---|
| **Bot** | Node.js 20 + Express | 3000 | Motor do chatbot + API admin |
| **CMS** | Strapi v5 | 1337 | Gestão de cardápios e restaurantes |
| **WhatsApp** | Evolution API | 8080 | Gateway de mensagens |
| **Banco** | PostgreSQL 15 | 5432 | Persistência de sessões e pedidos |
| **Proxy** | Nginx | 80/443 | Roteamento + SSL termination |
| **IA** | Claude claude-sonnet-4-5 | — | Compreensão de linguagem natural |

---

## Desenvolvimento Local

### Pré-requisitos

- Node.js >= 20
- Docker e Docker Compose
- Chave da API Anthropic ([console.anthropic.com](https://console.anthropic.com))

### Passo a passo

```bash
# 1. Clone e entre no projeto
git clone <repo> bot-restaurante
cd bot-restaurante

# 2. Suba PostgreSQL + Evolution API
docker compose up postgres evolution-api -d

# 3. Configure o bot
cd bot
cp .env.example .env
# Edite .env com suas chaves (ANTHROPIC_API_KEY é obrigatória)

# 4. Instale dependências e migre o banco
npm install
npx prisma migrate dev --name init

# 5. Inicie o bot
npm run dev
# Bot disponível em http://localhost:3000

# 6. Configure o Strapi (novo terminal)
cd ../strapi
npm install
cp .env.example .env
# Edite strapi/.env com APP_KEYS e demais chaves
npm run develop
# Strapi disponível em http://localhost:1337/admin

# 7. Crie o usuário admin do Strapi e gere o API Token
# Settings → API Tokens → Create → Read-only → copie o token → cole em bot/.env STRAPI_TOKEN

# 8. Popule com dados de exemplo
npm run seed
```

---

## Deploy na VPS

### 1. Escolha e acesse a VPS

Qualquer provedor Ubuntu 22.04+: DigitalOcean, Hostinger, Vultr, Contabo, etc.

- Mínimo recomendado: **2 vCPU / 4 GB RAM / 50 GB SSD**
- Acesse via SSH: `ssh root@IP_DA_VPS`

### 2. Prepare o servidor

```bash
# Garante que está atualizado
apt-get update && apt-get upgrade -y

# Instala git
apt-get install -y git
```

### 3. Clone o repositório e configure

```bash
git clone <repo> /opt/bot-restaurante
cd /opt/bot-restaurante

# Cria o .env de produção
cp .env.production.example .env
nano .env   # preencha TODOS os valores marcados com ⚠️
```

### 4. Rode o script de deploy

```bash
chmod +x scripts/deploy.sh
sudo ./scripts/deploy.sh
```

O script automaticamente:
- Instala Docker, Docker Compose e Node.js
- Valida as variáveis obrigatórias no `.env`
- Builda e sobe todos os containers (`postgres`, `evolution-api`, `bot`, `nginx`)
- Instala o Strapi como serviço systemd
- Configura o firewall (portas 22, 80, 443)
- Exibe as URLs de acesso

### 5. Configure o Strapi em produção

```bash
cd /opt/bot-restaurante/strapi
nano .env   # preencha APP_KEYS e demais variáveis
npm run build
systemctl start strapi
```

Acesse `http://SEU_DOMINIO/admin` para criar o primeiro usuário.

### 6. Ative SSL com Let's Encrypt

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d seudominio.com -d www.seudominio.com

# O certbot edita o nginx.conf automaticamente.
# Para renovação automática (já incluída pelo certbot):
systemctl status certbot.timer
```

### 7. Aponte seu domínio

No painel do seu registrador de domínio, crie um registro DNS tipo A:

```
@ (ou seudominio.com)  →  A  →  IP_DA_VPS
www                    →  A  →  IP_DA_VPS
```

Aguarde a propagação (até 24h, geralmente minutos).

---

## Adicionar Novo Restaurante

### 1. Cadastrar no Strapi

Acesse `http://seudominio.com/admin` → Content Manager → Restaurante → Create new

Preencha:
- `nome`: Nome do restaurante
- `slugWhatsapp`: Número WhatsApp com DDI (ex: `5511999999999`)
- `donoWhatsapp`: Número que recebe os pedidos
- `plano`: basico / profissional / premium
- `dataVencimento`: Data de expiração do plano

Depois crie o cardápio: Cardápio → Categoria → Produtos.

### 2. Registrar via API de Onboarding

```bash
curl -X POST https://seudominio.com/api/onboarding/restaurante \
  -H "x-admin-token: SEU_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "strapiId": 1,
    "slug": "5511999999999"
  }'
```

A resposta inclui um **QR code em base64**.

### 3. Conectar o WhatsApp Business

Abra o QR code retornado (use qualquer [decodificador base64 → imagem](https://base64.guru/converter/decode/image)) e escaneie com o WhatsApp Business do restaurante:

> WhatsApp Business → Configurações → Dispositivos Conectados → Conectar Dispositivo

### 4. Testar

Envie "oi" para o número WhatsApp do restaurante. O bot deve responder apresentando o cardápio.

### 5. Verificar status da conexão

```bash
curl https://seudominio.com/api/onboarding/status/5511999999999 \
  -H "x-admin-token: SEU_ADMIN_TOKEN"
```

---

## Variáveis de Ambiente Explicadas

### docker-compose / raiz (.env)

| Variável | Obrigatório | Descrição |
|---|---|---|
| `DB_USER` | Sim | Usuário do PostgreSQL |
| `DB_PASSWORD` | Sim | Senha do PostgreSQL — use `openssl rand -hex 32` |
| `DB_NAME` | Não | Nome do banco (padrão: `botrestaurante`) |
| `ANTHROPIC_API_KEY` | Sim | Chave da API Claude — [console.anthropic.com](https://console.anthropic.com) |
| `EVOLUTION_API_KEY` | Sim | Chave da Evolution API — use `openssl rand -hex 24` |
| `STRAPI_URL` | Sim | URL onde o Strapi está rodando |
| `STRAPI_TOKEN` | Sim | API Token do Strapi (Read-only) |
| `ADMIN_TOKEN` | Sim | Token para rotas `/admin` e `/onboarding` — use `openssl rand -hex 32` |
| `BOT_PUBLIC_URL` | Sim | URL pública do servidor, sem barra final (ex: `https://seudominio.com`) |

### Strapi (strapi/.env)

| Variável | Descrição |
|---|---|
| `APP_KEYS` | 4 chaves base64 separadas por vírgula — `openssl rand -base64 16` |
| `API_TOKEN_SALT` | Salt para tokens de API — `openssl rand -hex 16` |
| `ADMIN_JWT_SECRET` | Secret JWT do admin — `openssl rand -hex 32` |
| `TRANSFER_TOKEN_SALT` | Salt para tokens de transferência |
| `JWT_SECRET` | Secret JWT público |
| `DATABASE_CLIENT` | `sqlite` (padrão) ou `postgres` |

---

## API Admin

Todas as rotas requerem o header `x-admin-token: SEU_ADMIN_TOKEN`.

### Pedidos

```bash
# Listar pedidos (com filtros)
GET /api/admin/pedidos?restauranteId=X&status=NOVO&pagina=1

# Atualizar status
PATCH /api/admin/pedidos/:id/status
Body: { "status": "CONFIRMADO" }  # NOVO | CONFIRMADO | CANCELADO
# Ao confirmar, o cliente recebe notificação automática via WhatsApp

# Estatísticas
GET /api/admin/stats?restauranteId=X
# Retorna: totalPedidos, pedidosHoje, faturamentoTotal, faturamentoHoje,
#          clientesUnicos, sessoesAtivas
```

### Instâncias WhatsApp

```bash
# Listar todas as instâncias e status de conexão
GET /api/admin/instancias

# Reconectar (gera novo QR code)
POST /api/admin/instancias/:slug/reconectar

# Obter QR code atual
GET /api/admin/instancias/:slug/qrcode
```

---

## Programa de Fidelidade

O sistema acumula automaticamente o histórico de compras de cada cliente (identificado pelo número WhatsApp), independente do restaurante.

### Consultar ranking

```bash
curl "https://seudominio.com/api/admin/clientes/fidelidade?limite=20" \
  -H "x-admin-token: SEU_ADMIN_TOKEN"
```

Resposta:
```json
{
  "data": [
    {
      "numero": "5511999999999",
      "nome": "João Silva",
      "totalPedidos": 12,
      "totalGasto": 487.50,
      "ultimoPedido": "2026-04-01T20:30:00Z",
      "restaurantes": [
        { "restauranteId": "uuid-...", "pedidos": 8, "gasto": 320.00 },
        { "restauranteId": "uuid-...", "pedidos": 4, "gasto": 167.50 }
      ]
    }
  ]
}
```

Cada entrada registra:
- **totalPedidos** e **totalGasto** — acumulado em todos os restaurantes
- **restaurantes** — histórico detalhado por restaurante
- **ultimoPedido** — data do pedido mais recente

---

## Estrutura de Pastas

```
bot-restaurante/
  bot/                        ← Motor do chatbot (Node.js)
    src/
      controllers/            ← webhookController
      middleware/             ← tenantMiddleware
      routes/                 ← admin, onboarding
      services/               ← claude, evolution, pedido, sessao, strapi, tenant
      jobs/                   ← limpeza (crons)
    prisma/schema.prisma      ← Modelos do banco
    Dockerfile
    CLAUDE.md                 ← Guia para desenvolvimento com Claude Code
  strapi/                     ← CMS Strapi v5
    src/api/                  ← Content Types: restaurante, cardapio, categoria, produto
    scripts/seed.js           ← Dados de exemplo
  nginx/nginx.conf            ← Proxy reverso
  scripts/deploy.sh           ← Deploy automático em VPS Ubuntu
  docker-compose.yml          ← Todos os serviços de produção
  .env.production.example     ← Template de variáveis para produção
  README.md
```

---

## Comandos Úteis em Produção

```bash
# Status dos containers
docker compose ps

# Logs em tempo real
docker compose logs -f bot
docker compose logs -f evolution-api

# Reiniciar um serviço
docker compose restart bot

# Atualizar após novo deploy
git pull
docker compose up -d --build bot

# Backup do banco
docker compose exec postgres pg_dump -U $DB_USER $DB_NAME > backup-$(date +%F).sql

# Restaurar backup
cat backup-2026-04-01.sql | docker compose exec -T postgres psql -U $DB_USER $DB_NAME

# Prisma Studio (inspecionar banco)
cd bot && npx prisma studio

# Status do Strapi
systemctl status strapi
journalctl -u strapi -f
```
