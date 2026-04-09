/**
 * Seed script — popula o banco com dados de exemplo.
 *
 * Uso:
 *   node scripts/seed.js
 *
 * Requer que o Strapi já tenha sido iniciado pelo menos uma vez
 * para que o banco e as tabelas existam.
 */

"use strict";

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const Database = require("better-sqlite3");
const path = require("path");
const { v4: uuidv4 } = require("crypto").randomUUID ? { v4: () => require("crypto").randomUUID() } : require("uuid");

const DB_PATH = path.resolve(
  __dirname,
  "..",
  process.env.DATABASE_FILENAME || ".tmp/data.db"
);

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const agora = new Date().toISOString();

// ── Dados de seed ─────────────────────────────────────────────────────────────

const restaurantes = [
  {
    nome: "Pizzaria do Zé",
    slugWhatsapp: "5511991110001",
    donoWhatsapp: "5511991110000",
    descricao: "A melhor pizza artesanal do bairro, desde 1995!",
    ativo: 1,
    plano: "profissional",
  },
  {
    nome: "Lanchonete da Cida",
    slugWhatsapp: "5511992220001",
    donoWhatsapp: "5511992220000",
    descricao: "Lanches e sucos fresquinhos feitos com amor.",
    ativo: 1,
    plano: "basico",
  },
];

const cardapios = {
  "Pizzaria do Zé": {
    nome: "Cardápio Principal",
    categorias: [
      {
        nome: "Pizzas Salgadas",
        emoji: "🍕",
        ordem: 1,
        produtos: [
          { nome: "Margherita", preco: 42.9, emoji: "🍕", descricao: "Molho de tomate, mussarela, manjericão fresco", destaque: 1 },
          { nome: "Calabresa", preco: 44.9, emoji: "🍕", descricao: "Molho de tomate, mussarela, calabresa fatiada, cebola" },
          { nome: "Frango com Catupiry", preco: 47.9, emoji: "🍕", descricao: "Frango desfiado temperado, catupiry original" },
          { nome: "Quatro Queijos", preco: 49.9, emoji: "🍕", descricao: "Mussarela, provolone, gorgonzola e parmesão", destaque: 1 },
        ],
      },
      {
        nome: "Pizzas Doces",
        emoji: "🍫",
        ordem: 2,
        produtos: [
          { nome: "Chocolate com Morango", preco: 46.9, emoji: "🍫", descricao: "Chocolate ao leite derretido e morangos frescos", destaque: 1 },
          { nome: "Banana com Canela", preco: 39.9, emoji: "🍌", descricao: "Banana caramelizada, canela e leite condensado" },
          { nome: "Nutella com Morango", preco: 52.9, emoji: "🍓", descricao: "Nutella generosa com morangos fatiados" },
          { nome: "Romeu e Julieta", preco: 41.9, emoji: "🧀", descricao: "Goiabada cascão e mussarela" },
        ],
      },
      {
        nome: "Bebidas",
        emoji: "🥤",
        ordem: 3,
        produtos: [
          { nome: "Coca-Cola 2L", preco: 12.0, emoji: "🥤", descricao: "Garrafa gelada" },
          { nome: "Suco de Laranja 500ml", preco: 9.0, emoji: "🍊", descricao: "Natural espremido na hora" },
          { nome: "Água Mineral 500ml", preco: 4.0, emoji: "💧", descricao: "Com ou sem gás" },
          { nome: "Cerveja Heineken Long Neck", preco: 11.0, emoji: "🍺", descricao: "350ml gelada" },
        ],
      },
    ],
  },
  "Lanchonete da Cida": {
    nome: "Cardápio da Cida",
    categorias: [
      {
        nome: "Lanches",
        emoji: "🍔",
        ordem: 1,
        produtos: [
          { nome: "X-Burguer", preco: 18.9, emoji: "🍔", descricao: "Pão, hambúrguer 150g, queijo, alface e tomate", destaque: 1 },
          { nome: "X-Bacon", preco: 22.9, emoji: "🥓", descricao: "Pão, hambúrguer 150g, bacon crocante, queijo", destaque: 1 },
          { nome: "Misto Quente", preco: 10.5, emoji: "🥪", descricao: "Pão de forma, presunto e queijo grelhados" },
          { nome: "Coxinha de Frango", preco: 6.0, emoji: "🍗", descricao: "Massa crocante com frango temperado" },
        ],
      },
      {
        nome: "Sucos Naturais",
        emoji: "🍹",
        ordem: 2,
        produtos: [
          { nome: "Suco de Acerola", preco: 8.0, emoji: "🍒", descricao: "500ml, rico em vitamina C" },
          { nome: "Vitamina de Banana", preco: 9.0, emoji: "🍌", descricao: "500ml com leite e mel" },
          { nome: "Suco de Maracujá", preco: 8.5, emoji: "🍋", descricao: "500ml, docinho do jeito certo" },
          { nome: "Suco Detox Verde", preco: 11.0, emoji: "🥬", descricao: "Couve, limão, gengibre e maçã verde", destaque: 1 },
        ],
      },
      {
        nome: "Porções",
        emoji: "🍟",
        ordem: 3,
        produtos: [
          { nome: "Batata Frita P", preco: 14.0, emoji: "🍟", descricao: "Porção pequena crocante com sal" },
          { nome: "Batata Frita G", preco: 22.0, emoji: "🍟", descricao: "Porção grande crocante com sal", destaque: 1 },
          { nome: "Onion Rings", preco: 18.0, emoji: "🧅", descricao: "Anéis de cebola empanados e fritos" },
          { nome: "Nuggets 10 unidades", preco: 16.0, emoji: "🍗", descricao: "Nuggets crocantes com molho à escolha" },
        ],
      },
    ],
  },
};

// ── Insert helpers ────────────────────────────────────────────────────────────

function insertRestaurante(r) {
  const id = uuidv4();
  db.prepare(`
    INSERT OR IGNORE INTO restaurantes
      (document_id, nome, slug_whatsapp, dono_whatsapp, descricao, ativo, plano, created_at, updated_at, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, r.nome, r.slugWhatsapp, r.donoWhatsapp, r.descricao, r.ativo, r.plano, agora, agora, agora);
  return db.prepare("SELECT id FROM restaurantes WHERE slug_whatsapp = ?").get(r.slugWhatsapp);
}

function insertCardapio(nome, restauranteId) {
  const id = uuidv4();
  db.prepare(`
    INSERT OR IGNORE INTO cardapios
      (document_id, nome, ativo, restaurante_id, created_at, updated_at, published_at)
    VALUES (?, ?, 1, ?, ?, ?, ?)
  `).run(id, nome, restauranteId, agora, agora, agora);
  return db.prepare("SELECT id FROM cardapios WHERE nome = ? AND restaurante_id = ?").get(nome, restauranteId);
}

function insertCategoria(nome, emoji, ordem, cardapioId) {
  const id = uuidv4();
  db.prepare(`
    INSERT OR IGNORE INTO categorias
      (document_id, nome, emoji, ordem, cardapio_id, created_at, updated_at, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, nome, emoji, ordem, cardapioId, agora, agora, agora);
  return db.prepare("SELECT id FROM categorias WHERE nome = ? AND cardapio_id = ?").get(nome, cardapioId);
}

function insertProduto(p, categoriaId) {
  const id = uuidv4();
  db.prepare(`
    INSERT OR IGNORE INTO produtos
      (document_id, nome, descricao, preco, emoji, disponivel, destaque, categoria_id, created_at, updated_at, published_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).run(id, p.nome, p.descricao || null, p.preco, p.emoji || null, p.destaque || 0, categoriaId, agora, agora, agora);
}

// ── Execução ──────────────────────────────────────────────────────────────────

function seed() {
  console.log("🌱 Iniciando seed...\n");

  for (const dadosRestaurante of restaurantes) {
    console.log(`📍 Restaurante: ${dadosRestaurante.nome}`);

    const restaurante = insertRestaurante(dadosRestaurante);
    const dadosCardapio = cardapios[dadosRestaurante.nome];

    const cardapio = insertCardapio(dadosCardapio.nome, restaurante.id);
    console.log(`   📋 Cardápio: ${dadosCardapio.nome}`);

    for (const dadosCategoria of dadosCardapio.categorias) {
      const categoria = insertCategoria(
        dadosCategoria.nome,
        dadosCategoria.emoji,
        dadosCategoria.ordem,
        cardapio.id
      );
      console.log(`   ${dadosCategoria.emoji} Categoria: ${dadosCategoria.nome}`);

      for (const produto of dadosCategoria.produtos) {
        insertProduto(produto, categoria.id);
        console.log(`      • ${produto.nome} — R$ ${produto.preco.toFixed(2)}`);
      }
    }

    console.log();
  }

  console.log("✅ Seed concluído com sucesso!");
}

try {
  seed();
} catch (err) {
  console.error("❌ Erro no seed:", err.message);
  console.error("\nDica: inicie o Strapi uma vez antes de rodar o seed:");
  console.error("  npm run develop\n");
  process.exit(1);
}
