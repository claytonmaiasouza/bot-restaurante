/**
 * seed-pedidos-teste.js
 * Cria 5 pedidos de teste com pagamento em Cartão no restaurante Don Pedro.
 *
 * Uso:
 *   node scripts/seed-pedidos-teste.js
 *
 * Em produção (via docker exec):
 *   scp scripts/seed-pedidos-teste.js root@185.137.92.141:/tmp/
 *   ssh root@185.137.92.141 "docker cp /tmp/seed-pedidos-teste.js bot-app:/app/seed-pedidos-teste.js && docker exec bot-app node /app/seed-pedidos-teste.js"
 */

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const RESTAURANTE_ID = "68f8d05d-4a28-4f77-a0a3-c3035b1d8603";

const PEDIDOS = [
  {
    nome: "Ana Lima",
    fone: "5521900000001",
    itens: [{ nome: "Pizza Calabresa - G", preco: 90000, quantidade: 1 }],
    total: 90000,
    loc: "Rua das Flores 123, Centro",
  },
  {
    nome: "Carlos Souza",
    fone: "5511900000002",
    itens: [
      { nome: "Pizza Mozzarella - M", preco: 65000, quantidade: 1 },
      { nome: "Coca-Cola 2L", preco: 12000, quantidade: 1 },
    ],
    total: 77000,
    loc: "Av. Brasil 456, Bairro Norte",
  },
  {
    nome: "Julia Ramos",
    fone: "5531900000003",
    itens: [
      { nome: "Pizza Portuguesa - G", preco: 95000, quantidade: 1 },
      { nome: "Pizza Frango - P", preco: 45000, quantidade: 1 },
    ],
    total: 140000,
    loc: "Rua São Paulo 789, Vila Nova",
  },
  {
    nome: "Pedro Costa",
    fone: "5541900000004",
    itens: [{ nome: "Pizza 4 Queijos - G", preco: 98000, quantidade: 1 }],
    total: 98000,
    loc: "Av. das Nações 321, Jardim",
  },
  {
    nome: "Mariana Silva",
    fone: "5551900000005",
    itens: [
      { nome: "Pizza Calabresa - M", preco: 70000, quantidade: 1 },
      { nome: "Guaraná 2L", preco: 10000, quantidade: 1 },
    ],
    total: 80000,
    loc: "Rua Independência 654, Centro",
  },
];

async function main() {
  const agora = new Date();
  const inicioDia = new Date(
    Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 5, 0, 0)
  );
  if (agora < inicioDia) inicioDia.setUTCDate(inicioDia.getUTCDate() - 1);

  const countHoje = await prisma.pedido.count({
    where: { restauranteId: RESTAURANTE_ID, createdAt: { gte: inicioDia } },
  });

  for (let i = 0; i < PEDIDOS.length; i++) {
    const d = PEDIDOS[i];
    const numeroDia = countHoje + i + 1;

    const sessao = await prisma.sessao.create({
      data: {
        clienteNumero: d.fone,
        clienteNome: d.nome,
        restauranteId: RESTAURANTE_ID,
        estado: "FINALIZADO",
        carrinho: d.itens,
      },
    });

    await prisma.pedido.create({
      data: {
        sessaoId: sessao.id,
        restauranteId: RESTAURANTE_ID,
        clienteNumero: d.fone,
        clienteNome: d.nome,
        itens: d.itens,
        total: d.total,
        localizacao: d.loc,
        metodoPagamento: "Cartão",
        status: "CONFIRMADO",
        numeroDia,
      },
    });

    console.log(`✅ #D${numeroDia} — ${d.nome} (Gs ${d.total.toLocaleString()})`);
  }

  console.log("\nPedidos criados com sucesso.");
}

main()
  .catch((e) => { console.error("Erro:", e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
