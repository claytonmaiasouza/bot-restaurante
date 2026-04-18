/**
 * Atualiza todos os produtos de categorias de pizza com o campo tamanhos.
 * Identifica categorias pelo nome (contém "pizza", case-insensitive).
 *
 * Uso: node scripts/update-pizza-tamanhos.js
 */

require("dotenv").config({ path: ".env" });
const axios = require("axios");

const STRAPI_URL = process.env.STRAPI_URL || "http://localhost:1337";
const STRAPI_TOKEN = process.env.STRAPI_TOKEN;

if (!STRAPI_TOKEN) {
  console.error("STRAPI_TOKEN não definido no .env");
  process.exit(1);
}

const client = axios.create({
  baseURL: STRAPI_URL,
  headers: { Authorization: `Bearer ${STRAPI_TOKEN}` },
});

const TAMANHOS_PIZZA = [
  { nome: "Individual (4pz)", preco: 40000, precoComBorda: 50000 },
  { nome: "Pequeña (6pz)",    preco: 60000, precoComBorda: 80000 },
  { nome: "Mediana (8pz)",    preco: 85000, precoComBorda: 95000 },
  { nome: "Grande (12pz)",    preco: 100000, precoComBorda: 120000 },
];

async function main() {
  // 1. Buscar todas as categorias
  const { data: catData } = await client.get("/api/categorias", {
    params: {
      "pagination[pageSize]": 100,
      "populate[produtos][populate]": "tamanhos",
    },
  });

  const categorias = catData.data || [];
  const pizzaCats = categorias.filter((c) => {
    const nome = c.nome || c.attributes?.nome || "";
    return /pizza/i.test(nome);
  });

  if (!pizzaCats.length) {
    console.log("Nenhuma categoria de pizza encontrada.");
    return;
  }

  console.log(`Categorias de pizza encontradas: ${pizzaCats.map((c) => c.nome || c.attributes?.nome).join(", ")}`);

  // 2. Para cada categoria, atualizar cada produto
  let total = 0;
  for (const cat of pizzaCats) {
    const produtosRaw = cat.produtos?.data || cat.produtos || [];

    for (const p of produtosRaw) {
      const id = p.id;
      const nome = p.nome || p.attributes?.nome;

      try {
        await client.put(`/api/produtos/${id}`, {
          data: { tamanhos: TAMANHOS_PIZZA },
        });
        console.log(`  ✓ ${nome} (id ${id})`);
        total++;
      } catch (err) {
        console.error(`  ✗ ${nome} (id ${id}):`, err.response?.data || err.message);
      }
    }
  }

  console.log(`\nConcluído: ${total} produto(s) atualizado(s).`);
}

main().catch((err) => {
  console.error("Erro fatal:", err.message);
  process.exit(1);
});
