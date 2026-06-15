/**
 * Importa o cardápio do OlaClick para o Don Pedro no banco de dados.
 * Substitui completamente as categorias/produtos existentes.
 *
 * Rodar dentro do container:
 *   docker exec bot-app node /app/src/scripts/importar-olaclick-donpedro.js
 */

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const SLUG_DON_PEDRO = "595981078839";

const CARDAPIO = [
  {
    nome: "Rodizio",
    ordem: 0,
    produtos: [
      { nome: "Rodizio Local", preco: 55000, descricao: "2 variantes de tamanho" },
      { nome: "Rodizio Delivery", preco: 55000 },
      { nome: "Caipira Rodizio", preco: 0, descricao: "2 variantes de tamanho" },
    ],
  },
  {
    nome: "Promo 2x1 Hamburguesas",
    ordem: 1,
    produtos: [
      { nome: "Completa 2x1", preco: 40000 },
      { nome: "Hambur. Simples 2x1", preco: 30000 },
      { nome: "Burguer 2x1", preco: 22000 },
      { nome: "X Bacon 2x1", preco: 38000 },
      { nome: "X Calabresa 2x1", preco: 38000 },
      { nome: "X Egg 2x1", preco: 25000 },
      { nome: "Hamburguesa Mexicana 2x1", preco: 40000 },
      { nome: "American Burguer 2x1", preco: 45000 },
    ],
  },
  {
    nome: "Promociones",
    ordem: 2,
    produtos: [
      { nome: "Pizza Promo Miércoles", preco: 50000 },
      { nome: "Promo Viernes", preco: 100000, descricao: "4 variantes" },
      { nome: "Promo Martes", preco: 22000, descricao: "9 variantes" },
      { nome: "Promo Viernes (Especial)", preco: 85000 },
      { nome: "Promo Copa — Ham. Completa", preco: 40000, ativo: false },
    ],
  },
  {
    nome: "Porciones",
    ordem: 3,
    produtos: [
      { nome: "Alcatra Acebolada", preco: 80000, descricao: "2 variantes de tamanho" },
      { nome: "Calabresa con Fritas", preco: 55000 },
      { nome: "Camarón Ali Oli", preco: 125000, descricao: "2 variantes de tamanho" },
      { nome: "Camarón a Milanesa", preco: 125000, descricao: "2 variantes de tamanho" },
      { nome: "Costilla Suina", preco: 85000 },
      { nome: "Pechuga con Polenta", preco: 80000 },
      { nome: "Pechuga a la Plancha", preco: 45000 },
      { nome: "Picaña", preco: 100000, descricao: "2 variantes de tamanho" },
      { nome: "Papa Frita", preco: 35000, descricao: "2 variantes de tamanho" },
      { nome: "Papa Bagunçada", preco: 55000 },
      { nome: "Pollo a Passarinho", preco: 45000, descricao: "2 variantes de tamanho" },
      { nome: "Bolinho de Mandioca", preco: 40000 },
      { nome: "Tilapia a la Plancha", preco: 55000 },
      { nome: "Tilapia Frita", preco: 70000, descricao: "2 variantes de tamanho" },
      { nome: "Trio Delicia", preco: 85000, descricao: "2 variantes de tamanho" },
      { nome: "Tabla de Fríos", preco: 85000 },
      { nome: "Milanesa do Cheff — Pollo", preco: 60000 },
      { nome: "Milanesa do Cheff — Carne", preco: 70000 },
      { nome: "Ensalada", preco: 20000 },
    ],
  },
  {
    nome: "Hamburguesas",
    ordem: 4,
    produtos: [
      { nome: "Completa", preco: 40000 },
      { nome: "Doble Carne", preco: 45000 },
      { nome: "Hamburguesa Simples", preco: 30000 },
      { nome: "Burguer", preco: 22000 },
      { nome: "X Bacon", preco: 38000 },
      { nome: "X Calabresa", preco: 38000 },
      { nome: "X Egg", preco: 25000 },
      { nome: "Hamburguesa Mexicana", preco: 40000 },
      { nome: "American Burguer", preco: 45000 },
    ],
  },
  {
    nome: "Pizzas — Por Tamanho",
    ordem: 5,
    produtos: [
      { nome: "Pizza Grande (hasta 4 sabores)", preco: 100000 },
      { nome: "Pizza Mediana (hasta 3 sabores)", preco: 85000 },
      { nome: "Pizza Pequeña (hasta 2 sabores)", preco: 60000 },
      { nome: "Pizza Individual (hasta 2 sabores)", preco: 40000 },
    ],
  },
  {
    nome: "Pizza — Sabores",
    ordem: 6,
    produtos: [
      { nome: "Marguerita", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Calabresa", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Ali Oli", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "4 Quesos", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "3 Fronteras", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Acebollada", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Americana", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Bacon", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Catubacon", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Baiana", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Burguer", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Caipira", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Calabacon", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Catubresa", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Choclo", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Doritos", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Du Cheff", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Mexicana", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Moda de la Casa", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Mozzarella", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Napolitana", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Palmito", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Paraguaya", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Pepperoni", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Pollo Catupiry", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Portuguesa", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Primavera", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Siciliana", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Strogonoff de Carne", preco: 90000, descricao: "4 tamanhos disponíveis" },
      { nome: "Strogonoff de Pollo", preco: 0 },
      { nome: "Rúcula con Tomate Seco", preco: 0 },
    ],
  },
  {
    nome: "Bebidas",
    ordem: 7,
    produtos: [
      { nome: "Coca-Cola 500ml", preco: 9000 },
      { nome: "Coca-Cola 500ml Zero", preco: 9000 },
      { nome: "Coca-Cola 1L", preco: 14000 },
      { nome: "Coca-Cola 1L Zero", preco: 14000 },
      { nome: "Coca-Cola 2L", preco: 20000 },
      { nome: "Coca-Cola 2L Zero", preco: 20000 },
      { nome: "Coca Retornable 1L", preco: 13000 },
      { nome: "Coca Lata Zero", preco: 9000 },
      { nome: "Sprite 500ml", preco: 9000 },
      { nome: "Sprite 1L", preco: 14000 },
      { nome: "Sprite 2L", preco: 20000 },
      { nome: "Fanta Guarana 500ml", preco: 9000 },
      { nome: "Fanta Naranja 500ml", preco: 9000 },
      { nome: "Fanta Piña 500ml", preco: 9000 },
      { nome: "Fanta Naranja 1L Retornable", preco: 13000 },
      { nome: "Fanta Guarana 2L", preco: 20000 },
      { nome: "Pet Fanta / Guarana 200ml", preco: 5000 },
      { nome: "Guaraná Antártica Lata", preco: 9000 },
      { nome: "Jugo del Valle 200ml", preco: 6000 },
      { nome: "Jugo del Valle 1L", preco: 17000 },
      { nome: "Agua 500ml", preco: 6000 },
      { nome: "Agua 500ml con Gas", preco: 6000 },
      { nome: "Agua 1L", preco: 12000 },
      { nome: "Agua Tónica de la Costa Lata", preco: 9000 },
      { nome: "Schweppes Agua Tónica 500ml", preco: 11000 },
      { nome: "Schweppes Citrus 500ml", preco: 9000 },
      { nome: "Power", preco: 14000 },
      { nome: "Monster", preco: 20000 },
    ],
  },
  {
    nome: "Drinks",
    ordem: 8,
    produtos: [
      { nome: "Caipiriña Tradicional", preco: 18000 },
      { nome: "Caipiriña de Vino", preco: 18000 },
      { nome: "Caipiriña de Frutas", preco: 28000 },
      { nome: "Cóctel de Frutas", preco: 28000 },
      { nome: "Piña Colada", preco: 28000 },
      { nome: "Sex on the Beach", preco: 28000 },
      { nome: "Mojito", preco: 25000 },
      { nome: "Campari Tonic", preco: 38000 },
      { nome: "Laguna Azul", preco: 25000 },
      { nome: "Gin Tropical", preco: 25000 },
      { nome: "Frozen Daiquiri", preco: 25000 },
      { nome: "Margarita", preco: 25000 },
      { nome: "Negroni", preco: 28000 },
      { nome: "Gin Tónica", preco: 33000 },
      { nome: "Licor de Café", preco: 39000 },
      { nome: "Vino Blanco", preco: 99000 },
      { nome: "Piel de Cordero — Vino", preco: 50000 },
      { nome: "Chandon", preco: 150000 },
      { nome: "Almaden", preco: 100000 },
      { nome: "Whisky — Dose", preco: 38000 },
      { nome: "Tequila", preco: 18000 },
    ],
  },
  {
    nome: "Cerveza",
    ordem: 9,
    produtos: [
      { nome: "Corona 620ml", preco: 22000 },
      { nome: "Coronita 210ml", preco: 11000 },
      { nome: "Heineken 650ml", preco: 22000 },
      { nome: "Heineken 250ml", preco: 11000 },
      { nome: "Heineken 0.0 Zero", preco: 16500 },
      { nome: "Torre Heineken", preco: 99000, descricao: "4 variantes de tamanho" },
      { nome: "Torre Munich", preco: 72000, descricao: "4 variantes de tamanho" },
      { nome: "Stella Artois 600ml", preco: 22000 },
      { nome: "Stella Artois 330ml", preco: 11000 },
      { nome: "Budweiser 710ml", preco: 22000 },
      { nome: "Patagonia 650ml", preco: 28000 },
      { nome: "Michelob", preco: 9000 },
      { nome: "Michelob B", preco: 11000 },
      { nome: "Imperio Lager 210ml", preco: 10000 },
      { nome: "Imperio Lager 600ml", preco: 20000 },
      { nome: "Imperio Gold 210ml", preco: 12000 },
      { nome: "Imperio Ultra 210ml", preco: 10000 },
      { nome: "Imperio Ultra 269ml", preco: 8000 },
      { nome: "Imperio Pilsen", preco: 15000 },
    ],
  },
  {
    nome: "Destilado",
    ordem: 10,
    produtos: [
      { nome: "Whisky", preco: 28000 },
      { nome: "Campari", preco: 28000 },
      { nome: "Aperol", preco: 22000 },
      { nome: "Tequila", preco: 22000 },
      { nome: "Velho Barreiro", preco: 30000 },
      { nome: "Fernet", preco: 28000 },
    ],
  },
  {
    nome: "Jugos Naturales",
    ordem: 11,
    produtos: [
      { nome: "Jarra Grande", preco: 42000 },
      { nome: "Media Jarra", preco: 28000 },
      { nome: "Vaso", preco: 14500 },
    ],
  },
  {
    nome: "Heladería — Solamente Local",
    ordem: 12,
    produtos: [
      { nome: "Picole de Fruta", preco: 2000 },
      { nome: "Picole de Leche", preco: 2500 },
      { nome: "Skimo", preco: 5000 },
      { nome: "Morenita", preco: 5000 },
      { nome: "Sundae", preco: 5000 },
      { nome: "Paleta Mexicana", preco: 8000 },
      { nome: "Cucurucho", preco: 6000 },
      { nome: "Cucurucho Paquete", preco: 15000 },
      { nome: "Helado por kg", preco: 5000 },
      { nome: "Milk Shake (Pequeño)", preco: 15000 },
      { nome: "Milk Shake (Grande)", preco: 20000 },
      { nome: "Açaí Bocha", preco: 7000 },
      { nome: "Açaí 250ml", preco: 10000 },
      { nome: "Açaí 300ml", preco: 15000 },
      { nome: "Açaí 500ml", preco: 20000 },
      { nome: "Pote de Açaí 2L", preco: 70000 },
      { nome: "Pote 1,5L", preco: 30000 },
      { nome: "Pote 2L", preco: 35000 },
      { nome: "Pote 3L", preco: 50000 },
      { nome: "Caja de Açaí", preco: 200000 },
      { nome: "Caja 5L", preco: 80000 },
      { nome: "Caja 10 Litros", preco: 130000 },
      { nome: "Balde 10L", preco: 140000 },
    ],
  },
  {
    nome: "Producto Balcón",
    ordem: 13,
    produtos: [
      { nome: "Doritos 150g", preco: 20000 },
      { nome: "Doritos 235g", preco: 28000 },
      { nome: "Doritos Lila", preco: 15000 },
      { nome: "Doritos N", preco: 15000 },
      { nome: "Lays Clásica", preco: 20000 },
      { nome: "Cheetos", preco: 15000 },
      { nome: "Producto Adicional", preco: 5000 },
    ],
  },
  {
    nome: "Massa Pré-assada",
    ordem: 14,
    produtos: [
      { nome: "Massa Grande con Borde", preco: 22000 },
      { nome: "Massa Grande sin Borde", preco: 18000 },
      { nome: "Massa Media con Borde", preco: 20000 },
      { nome: "Massa Media sin Borde", preco: 18000 },
      { nome: "Massa con Borde Pequeña", preco: 15000 },
    ],
  },
  {
    nome: "Pré-assada — Somente Revenda",
    ordem: 15,
    produtos: [
      { nome: "Pizza Grande", preco: 50000 },
      { nome: "Pizza Grande — con Borde", preco: 65000 },
      { nome: "Pizza Media", preco: 40000 },
      { nome: "Pizza Media — con Borde", preco: 45000 },
      { nome: "Pizza Pequeña", preco: 35000 },
      { nome: "Pizza Pequeña — con Borde", preco: 40000 },
      { nome: "Pão de Brioche", preco: 2500 },
    ],
  },
  {
    nome: "Heladería — Revenda",
    ordem: 16,
    produtos: [
      { nome: "Picole de Fruta — Revenda", preco: 1000 },
      { nome: "Picole de Leche — Revenda", preco: 1500 },
      { nome: "Morenita — Revenda", preco: 3000 },
      { nome: "Skimo — Revenda", preco: 2500 },
      { nome: "Sundae — Revenda", preco: 3000 },
      { nome: "Paleta Mexicana — Revenda", preco: 5000 },
      { nome: "Pote Revenda 2L", preco: 28000 },
      { nome: "Caja 5L", preco: 70000 },
      { nome: "Caja 10 Litros", preco: 110000 },
    ],
  },
];

async function main() {
  const rest = await prisma.restaurante.findUnique({
    where: { slugWhatsapp: SLUG_DON_PEDRO },
    select: { id: true, nome: true },
  });

  if (!rest) {
    console.error(`Restaurante com slug ${SLUG_DON_PEDRO} não encontrado.`);
    process.exit(1);
  }

  console.log(`Restaurante encontrado: ${rest.nome} (${rest.id})`);
  console.log("Removendo categorias existentes...");
  await prisma.categoria.deleteMany({ where: { restauranteId: rest.id } });

  let totalProdutos = 0;
  for (const cat of CARDAPIO) {
    const categoria = await prisma.categoria.create({
      data: { restauranteId: rest.id, nome: cat.nome, ordem: cat.ordem },
    });

    for (const p of cat.produtos) {
      await prisma.produto.create({
        data: {
          categoriaId: categoria.id,
          nome: p.nome,
          descricao: p.descricao || null,
          preco: p.preco || 0,
          ativo: p.ativo !== undefined ? p.ativo : true,
        },
      });
      totalProdutos++;
    }
    console.log(`  ✓ ${cat.nome} (${cat.produtos.length} produtos)`);
  }

  console.log(`\nImportação concluída: ${CARDAPIO.length} categorias, ${totalProdutos} produtos.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
