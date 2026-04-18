/**
 * Script de migração única: importa cardápio do Don Pedro do Strapi para o banco.
 * Executar uma única vez: node src/scripts/migrarDonPedro.js
 */
require("dotenv").config();

const { PrismaClient } = require("@prisma/client");
const { buscarCardapio } = require("../services/strapiService");
const { importarCardapio } = require("../services/cardapioService");

const prisma = new PrismaClient();

async function main() {
  const restaurante = await prisma.restaurante.findFirst({
    where: { slugWhatsapp: "31645730876" },
  });

  if (!restaurante) {
    console.error("Restaurante Don Pedro não encontrado no banco.");
    process.exit(1);
  }

  console.log(`Migrando cardápio de: ${restaurante.nome} (strapiId: ${restaurante.strapiId})`);

  const cardapio = await buscarCardapio(restaurante.strapiId);

  if (!cardapio.length) {
    console.error("Nenhum dado retornado do Strapi. Verifique STRAPI_URL e STRAPI_TOKEN.");
    process.exit(1);
  }

  console.log(`Encontradas ${cardapio.length} categoria(s) no Strapi:`);
  cardapio.forEach((c) => console.log(`  - ${c.nome}: ${c.produtos.length} produto(s)`));

  await importarCardapio(restaurante.id, cardapio);

  console.log("✅ Migração concluída com sucesso!");
}

main()
  .catch((err) => { console.error("Erro na migração:", err.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
