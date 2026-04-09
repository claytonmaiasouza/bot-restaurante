# Bot Restaurante — CMS (Strapi v5)

Painel de gestão de restaurantes, cardápios e produtos para o SaaS.

---

## Pré-requisitos

- Node.js >= 18 (recomendado: 20 LTS)
- npm >= 8

---

## Instalação

```bash
cd strapi
npm install
cp .env.example .env
```

Edite o `.env` e preencha as chaves com valores aleatórios:

```bash
# Gere chaves seguras com:
node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"
```

---

## Rodar o Strapi

### Desenvolvimento (com hot-reload)

```bash
npm run develop
```

### Produção

```bash
npm run build
npm start
```

---

## Acessar o Admin

Abra: **http://localhost:1337/admin**

Na primeira vez, o Strapi vai pedir para criar o usuário administrador:

1. Acesse `http://localhost:1337/admin`
2. Preencha nome, e-mail e senha
3. Clique em **"Let's start"**

> Guarde bem o e-mail e senha — são usados para logar no painel.

---

## Gerar o API Token para o Bot

O bot usa um **API Token** com permissão de leitura para buscar restaurantes e cardápios.

1. No admin, vá em **Settings → API Tokens → Create new API Token**
2. Preencha:
   - **Name:** `Bot WhatsApp`
   - **Token type:** `Read-only`
   - **Token duration:** Unlimited
3. Clique em **Save**
4. **Copie o token** (aparece apenas uma vez!)
5. Cole no `.env` do bot:

```
STRAPI_TOKEN=seu-token-aqui
```

---

## Permissões Públicas

O `bootstrap` em `src/index.js` configura automaticamente permissões de leitura pública para:

- `restaurante` — find, findOne
- `cardapio` — find, findOne
- `categoria` — find, findOne
- `produto` — find, findOne

Para verificar: **Settings → Users & Permissions → Roles → Public**

---

## Popular com dados de exemplo (Seed)

Após iniciar o Strapi ao menos uma vez (para criar as tabelas):

```bash
npm run seed
```

Isso cria 2 restaurantes de exemplo com cardápios completos:

| Restaurante | WhatsApp | Plano |
|---|---|---|
| Pizzaria do Zé | 5511991110001 | profissional |
| Lanchonete da Cida | 5511992220001 | basico |

---

## Content Types

| Collection | Campos principais |
|---|---|
| **Restaurante** | nome, slugWhatsapp, donoWhatsapp, plano, ativo |
| **Cardápio** | nome, ativo, restaurante |
| **Categoria** | nome, emoji, ordem, cardapio |
| **Produto** | nome, preco, descricao, emoji, disponivel, destaque, categoria |

---

## Estrutura de Pastas

```
strapi/
  config/
    database.js     ← SQLite (padrão) ou PostgreSQL
    server.js
    middlewares.js
    plugins.js
  src/
    admin/app.js    ← Customização do painel
    index.js        ← Bootstrap: permissões públicas automáticas
    api/
      restaurante/  ← CRUD de restaurantes
      cardapio/     ← CRUD de cardápios
      categoria/    ← CRUD de categorias
      produto/      ← CRUD de produtos
  scripts/
    seed.js         ← Dados de exemplo
  .env.example
  package.json
```
