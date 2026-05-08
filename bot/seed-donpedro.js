const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RESTAURANTE_ID = "68f8d05d-4a28-4f77-a0a3-c3035b1d8603";
const TAXA_ENTREGA   = 10000; // G$

// Cardápio real do Don Pedro
const MENU = [
  { nome: "Pollo con Catupiry - Individual (4pz)",    preco: 40000 },
  { nome: "Pollo con Catupiry - Pequeña (6pz)",       preco: 60000 },
  { nome: "Pollo con Catupiry - Mediana (8pz)",       preco: 85000 },
  { nome: "Pollo con Catupiry - Grande (12pz)",       preco: 100000 },
  { nome: "Brócoli con Bacon - Individual (4pz)",     preco: 40000 },
  { nome: "Brócoli con Bacon - Pequeña (6pz)",        preco: 60000 },
  { nome: "Brócoli con Bacon - Mediana (8pz)",        preco: 85000 },
  { nome: "Brócoli con Bacon - Grande (12pz)",        preco: 100000 },
  { nome: "Banana - Individual (4pz)",                preco: 40000 },
  { nome: "Banana - Mediana (8pz)",                   preco: 85000 },
  { nome: "Banana - Grande (12pz)",                   preco: 100000 },
  { nome: "Siciliana - Individual (4pz)",             preco: 40000 },
  { nome: "Siciliana - Pequeña (6pz)",                preco: 60000 },
  { nome: "Siciliana - Mediana (8pz)",                preco: 85000 },
  { nome: "Siciliana - Grande (12pz)",                preco: 100000 },
  { nome: "Strogonoff de Carne - Mediana (8pz)",      preco: 85000 },
  { nome: "Strogonoff de Carne - Grande (12pz)",      preco: 100000 },
  { nome: "Tomate Seco con Rúcula - Pequeña (6pz)",   preco: 60000 },
  { nome: "Tomate Seco con Rúcula - Mediana (8pz)",   preco: 85000 },
  { nome: "4 Quesos - Individual (4pz)",              preco: 40000 },
  { nome: "4 Quesos - Mediana (8pz)",                 preco: 85000 },
  { nome: "Seducción - Grande (12pz)",                preco: 100000 },
  { nome: "Completa",                                 preco: 40000 },
  { nome: "Mexicana",                                 preco: 40000 },
  { nome: "X Egg",                                    preco: 25000 },
  { nome: "Doble",                                    preco: 45000 },
  { nome: "Simples",                                  preco: 30000 },
  { nome: "Burguer",                                  preco: 22000 },
  { nome: "X Bacon",                                  preco: 38000 },
  { nome: "X Calabresa",                              preco: 38000 },
  { nome: "American",                                 preco: 45000 },
];

const STATUS_POOL = [
  "ENTREGUE","ENTREGUE","ENTREGUE","ENTREGUE","ENTREGUE",
  "ENTREGUE","ENTREGUE","PREPARANDO","CONFIRMADO","CANCELADO",
];
const LOCALIZACOES = [
  "Rua San Martín 456, Asunción",
  "Av. España 1200, piso 3",
  "Barrio Trinidad, calle 5 N° 123",
  "Villa Morra, Mcal. López 2134",
  "Av. Madame Lynch 890",
];
const METODOS = ["Efectivo","Efectivo","Efectivo","Tarjeta","Transferencia",null];

const ri  = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function randomDate(maxDaysAgo) {
  const now = Date.now();
  const ms = Math.random() * maxDaysAgo * 86400000;
  return new Date(now - ms);
}

async function main() {
  const clientes = await prisma.clienteFidelidade.findMany({
    where: { restauranteId: RESTAURANTE_ID },
    orderBy: { nome: "asc" },
  });

  if (!clientes.length) {
    console.log("Nenhum cliente encontrado para Don Pedro.");
    process.exit(0);
  }

  console.log(`\n🍕 Don Pedro — ${clientes.length} cliente(s) encontrado(s)\n`);

  let totalPedidosCriados = 0;

  for (const cliente of clientes) {
    const numPedidos = ri(1, 8);
    console.log(`👤 ${cliente.nome || cliente.numero} → ${numPedidos} pedido(s)`);

    let pedidosValidos = 0;
    let gastoNovo = 0;
    let ultimaData = null;

    for (let i = 0; i < numPedidos; i++) {
      // Montar itens (1 a 3 por pedido, pode repetir)
      const numItens = ri(1, 3);
      const itens = [];
      for (let j = 0; j < numItens; j++) {
        const item = pick(MENU);
        const qtd  = ri(1, 2);
        // Agrupa se o mesmo item já está no pedido
        const existe = itens.find(x => x.nome === item.nome);
        if (existe) { existe.quantidade += qtd; }
        else { itens.push({ nome: item.nome, preco: item.preco, quantidade: qtd }); }
      }

      const subtotal = itens.reduce((s, x) => s + x.preco * x.quantidade, 0);
      const status   = pick(STATUS_POOL);
      const isEntrega = Math.random() > 0.3; // 70% delivery
      const taxa     = isEntrega ? TAXA_ENTREGA : 0;
      const total    = subtotal + taxa;
      const createdAt = randomDate(90);

      // Sessão (obrigatória pelo schema)
      const sessao = await prisma.sessao.create({
        data: {
          clienteNumero:   cliente.numero,
          clienteNome:     cliente.nome,
          restauranteId:   RESTAURANTE_ID,
          estado:          "FINALIZADO",
          carrinho:        itens,
          ultimaAtividade: createdAt,
          createdAt,
        },
      });

      await prisma.pedido.create({
        data: {
          sessaoId:        sessao.id,
          restauranteId:   RESTAURANTE_ID,
          clienteNumero:   cliente.numero,
          clienteNome:     cliente.nome,
          itens,
          total,
          status,
          pago: ["ENTREGUE","PREPARANDO","SAIU_PARA_ENTREGA","PRONTO_PARA_RETIRADA"].includes(status),
          localizacao:     isEntrega ? pick(LOCALIZACOES) : null,
          metodoPagamento: pick(METODOS),
          createdAt,
        },
      });

      if (status !== "CANCELADO") {
        pedidosValidos++;
        gastoNovo += total;
      }
      if (!ultimaData || createdAt > ultimaData) ultimaData = createdAt;
      totalPedidosCriados++;
    }

    // Atualizar fidelidade
    await prisma.clienteFidelidade.update({
      where: { id: cliente.id },
      data: {
        totalPedidos: { increment: pedidosValidos },
        totalGasto:   { increment: gastoNovo },
        ultimoPedido: ultimaData || new Date(),
      },
    });

    console.log(`   ✅ ${pedidosValidos} válidos | G$ ${gastoNovo.toLocaleString()} gasto`);
  }

  console.log(`\n🎉 Pronto! ${totalPedidosCriados} pedidos criados para ${clientes.length} clientes.\n`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
