const { PrismaClient } = require("@prisma/client");
const { randomUUID } = require("crypto");
const prisma = new PrismaClient();

const RESTAURANTE_ID = "68f8d05d-4a28-4f77-a0a3-c3035b1d8603";
const TAXA_ENTREGA   = 10000;

// ── Menu real Don Pedro ───────────────────────────────────────────────────────
const MENU = [
  { nome: "Pollo con Catupiry - Mediana (8pz)",  preco: 85000,  peso: 8 },
  { nome: "Pollo con Catupiry - Grande (12pz)",  preco: 100000, peso: 10 },
  { nome: "Pollo con Catupiry - Pequeña (6pz)",  preco: 60000,  peso: 5 },
  { nome: "Siciliana - Mediana (8pz)",            preco: 85000,  peso: 8 },
  { nome: "Siciliana - Grande (12pz)",            preco: 100000, peso: 9 },
  { nome: "4 Quesos - Mediana (8pz)",             preco: 85000,  peso: 7 },
  { nome: "Brócoli con Bacon - Mediana (8pz)",   preco: 85000,  peso: 6 },
  { nome: "Brócoli con Bacon - Grande (12pz)",   preco: 100000, peso: 7 },
  { nome: "Strogonoff de Carne - Mediana (8pz)", preco: 85000,  peso: 5 },
  { nome: "Strogonoff de Carne - Grande (12pz)", preco: 100000, peso: 6 },
  { nome: "Tomate Seco con Rúcula - Mediana",    preco: 85000,  peso: 4 },
  { nome: "Seducción - Grande (12pz)",           preco: 100000, peso: 5 },
  { nome: "Banana - Mediana (8pz)",              preco: 85000,  peso: 3 },
  { nome: "Doble",                               preco: 45000,  peso: 4 },
  { nome: "American",                            preco: 45000,  peso: 3 },
  { nome: "X Bacon",                             preco: 38000,  peso: 3 },
  { nome: "Pollo con Catupiry - Individual",     preco: 40000,  peso: 2 },
];

const LOCALIZACOES = [
  "Rua San Martín 456, Asunción",
  "Av. España 1200, piso 3",
  "Barrio Trinidad, calle 5 N° 123",
  "Villa Morra, Mcal. López 2134",
  "Av. Madame Lynch 890",
  "Barrio Jara, calle Principal 234",
  "Av. Aviadores del Chaco 1500",
  "Fernando de la Mora, calle 8 N° 567",
];
const METODOS    = ["Efectivo","Efectivo","Efectivo","Efectivo","Tarjeta","Transferencia"];
const STATUS_POOL = ["ENTREGUE","ENTREGUE","ENTREGUE","ENTREGUE","ENTREGUE","ENTREGUE","ENTREGUE","ENTREGUE","ENTREGUE","CANCELADO"];
const HORAS_PICO = [11,12,12,13,18,18,19,19,19,19,20,20,20,20,20,21,21,21,22,22,23];
const CLIENTES   = [
  { numero:"595981234567", nome:"Carlos Rodríguez" },
  { numero:"595982345678", nome:"María González" },
  { numero:"595983456789", nome:"José Martínez" },
  { numero:"595984567890", nome:"Ana López" },
  { numero:"595985678901", nome:"Luis Pérez" },
  { numero:"595986789012", nome:"Carmen Silva" },
  { numero:"595987890123", nome:"Roberto Díaz" },
  { numero:"595988901234", nome:"Patricia Fernández" },
  { numero:"595989012345", nome:"Miguel Torres" },
  { numero:"595980123456", nome:"Laura Sánchez" },
  { numero:"595981111111", nome:"Diego Ramírez" },
  { numero:"595982222222", nome:"Sofía Morales" },
  { numero:"595983333333", nome:null },
  { numero:"595984444444", nome:null },
  { numero:"595985555555", nome:null },
];

const ri   = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const pickW = items => {
  const total = items.reduce((s, i) => s + i.peso, 0);
  let r = Math.random() * total;
  for (const item of items) { r -= item.peso; if (r <= 0) return item; }
  return items[items.length - 1];
};

function gerarItens() {
  const item1 = pickW(MENU);
  const itens = [{ nome: item1.nome, preco: item1.preco, quantidade: 1 }];
  // 35% chance de segundo item para elevar ticket médio
  if (Math.random() < 0.35) {
    const item2 = pickW(MENU);
    const ex = itens.find(i => i.nome === item2.nome);
    if (ex) ex.quantidade++; else itens.push({ nome: item2.nome, preco: item2.preco, quantidade: 1 });
  }
  return itens;
}

// Meses para seed: Dez/2025 ... Mai/2026
function gerarMeses() {
  const meses = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(2026, 4 - i, 1));
    meses.push({ str: `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`, ano: d.getUTCFullYear(), mes: d.getUTCMonth() });
  }
  return meses;
}

async function main() {
  console.log("\n🍕 Don Pedro — Seed Completo\n");

  // ── 1. Estoque ───────────────────────────────────────────────────────────────
  console.log("📦 Criando itens de estoque...");
  const ITENS_DEF = [
    // Ingredientes
    { nome:"Farinha de Trigo",          categoria:"INGREDIENTE", unidade:"kg",  quantidadeAtual:500, quantidadeMinima:100, precoUnitario:3500,  fornecedor:"Moinho Don Pedro" },
    { nome:"Queijo Mussarela",          categoria:"INGREDIENTE", unidade:"kg",  quantidadeAtual:200, quantidadeMinima:50,  precoUnitario:28000, fornecedor:"Lácteos Asunción" },
    { nome:"Molho de Tomate",           categoria:"INGREDIENTE", unidade:"L",   quantidadeAtual:100, quantidadeMinima:20,  precoUnitario:5000,  fornecedor:"Distribuidora MG" },
    { nome:"Pepperoni",                 categoria:"INGREDIENTE", unidade:"kg",  quantidadeAtual:50,  quantidadeMinima:10,  precoUnitario:45000, fornecedor:"Frigorífico Central" },
    { nome:"Calabresa",                 categoria:"INGREDIENTE", unidade:"kg",  quantidadeAtual:80,  quantidadeMinima:15,  precoUnitario:22000, fornecedor:"Frigorífico Central" },
    { nome:"Catupiry",                  categoria:"INGREDIENTE", unidade:"kg",  quantidadeAtual:60,  quantidadeMinima:10,  precoUnitario:35000, fornecedor:"Lácteos Asunción" },
    { nome:"Bacon",                     categoria:"INGREDIENTE", unidade:"kg",  quantidadeAtual:40,  quantidadeMinima:8,   precoUnitario:30000, fornecedor:"Frigorífico Central" },
    { nome:"Brócoli",                   categoria:"INGREDIENTE", unidade:"kg",  quantidadeAtual:30,  quantidadeMinima:5,   precoUnitario:8000,  fornecedor:"Verduras Frescas" },
    { nome:"Banana Madura",             categoria:"INGREDIENTE", unidade:"kg",  quantidadeAtual:20,  quantidadeMinima:5,   precoUnitario:4000,  fornecedor:"Verduras Frescas" },
    { nome:"Tomate Seco",               categoria:"INGREDIENTE", unidade:"kg",  quantidadeAtual:15,  quantidadeMinima:3,   precoUnitario:40000, fornecedor:"Distribuidora MG" },
    { nome:"Rúcula",                    categoria:"INGREDIENTE", unidade:"kg",  quantidadeAtual:10,  quantidadeMinima:2,   precoUnitario:12000, fornecedor:"Verduras Frescas" },
    { nome:"Carne Bovina (hambúrguer)", categoria:"INGREDIENTE", unidade:"kg",  quantidadeAtual:60,  quantidadeMinima:10,  precoUnitario:35000, fornecedor:"Frigorífico Central" },
    { nome:"Pão de Hambúrguer",         categoria:"INGREDIENTE", unidade:"un",  quantidadeAtual:200, quantidadeMinima:50,  precoUnitario:2500,  fornecedor:"Padaria Central" },
    { nome:"4 Quesos Mix",              categoria:"INGREDIENTE", unidade:"kg",  quantidadeAtual:40,  quantidadeMinima:8,   precoUnitario:38000, fornecedor:"Lácteos Asunción" },
    { nome:"Fermento Biológico",        categoria:"INGREDIENTE", unidade:"kg",  quantidadeAtual:10,  quantidadeMinima:2,   precoUnitario:25000, fornecedor:"Distribuidora MG" },
    { nome:"Azeite de Oliva",           categoria:"INGREDIENTE", unidade:"L",   quantidadeAtual:20,  quantidadeMinima:5,   precoUnitario:42000, fornecedor:"Distribuidora MG" },
    // Bebidas
    { nome:"Coca-Cola 2L",              categoria:"BEBIDA",      unidade:"un",  quantidadeAtual:100, quantidadeMinima:20,  precoUnitario:8500,  fornecedor:"FEMSA Paraguay" },
    { nome:"Guaraná Antarctica 2L",     categoria:"BEBIDA",      unidade:"un",  quantidadeAtual:80,  quantidadeMinima:15,  precoUnitario:7500,  fornecedor:"FEMSA Paraguay" },
    { nome:"Água Mineral 500ml",        categoria:"BEBIDA",      unidade:"un",  quantidadeAtual:200, quantidadeMinima:50,  precoUnitario:2000,  fornecedor:"FEMSA Paraguay" },
    { nome:"Cerveja Brahma 350ml",      categoria:"BEBIDA",      unidade:"un",  quantidadeAtual:150, quantidadeMinima:30,  precoUnitario:5500,  fornecedor:"FEMSA Paraguay" },
    // Embalagens
    { nome:"Caixa Pizza Individual",    categoria:"EMBALAGEM",   unidade:"un",  quantidadeAtual:500, quantidadeMinima:100, precoUnitario:1200,  fornecedor:"Embalagens Asunción" },
    { nome:"Caixa Pizza Pequeña",       categoria:"EMBALAGEM",   unidade:"un",  quantidadeAtual:300, quantidadeMinima:80,  precoUnitario:1500,  fornecedor:"Embalagens Asunción" },
    { nome:"Caixa Pizza Mediana",       categoria:"EMBALAGEM",   unidade:"un",  quantidadeAtual:400, quantidadeMinima:100, precoUnitario:1800,  fornecedor:"Embalagens Asunción" },
    { nome:"Caixa Pizza Grande",        categoria:"EMBALAGEM",   unidade:"un",  quantidadeAtual:200, quantidadeMinima:50,  precoUnitario:2200,  fornecedor:"Embalagens Asunción" },
    { nome:"Embalagem Hambúrguer",      categoria:"EMBALAGEM",   unidade:"un",  quantidadeAtual:300, quantidadeMinima:80,  precoUnitario:800,   fornecedor:"Embalagens Asunción" },
    { nome:"Guardanapos",               categoria:"EMBALAGEM",   unidade:"pct", quantidadeAtual:50,  quantidadeMinima:10,  precoUnitario:15000, fornecedor:"Embalagens Asunción" },
    { nome:"Sacolas Plásticas",         categoria:"EMBALAGEM",   unidade:"pct", quantidadeAtual:30,  quantidadeMinima:8,   precoUnitario:12000, fornecedor:"Embalagens Asunción" },
    // Limpeza
    { nome:"Detergente Líquido",        categoria:"LIMPEZA",     unidade:"L",   quantidadeAtual:10,  quantidadeMinima:2,   precoUnitario:5000,  fornecedor:"Limpesa Total" },
    { nome:"Desinfetante",              categoria:"LIMPEZA",     unidade:"L",   quantidadeAtual:8,   quantidadeMinima:2,   precoUnitario:7000,  fornecedor:"Limpesa Total" },
    { nome:"Álcool 70%",               categoria:"LIMPEZA",     unidade:"L",   quantidadeAtual:5,   quantidadeMinima:1,   precoUnitario:8000,  fornecedor:"Limpesa Total" },
    { nome:"Papel Toalha",             categoria:"LIMPEZA",     unidade:"cx",  quantidadeAtual:20,  quantidadeMinima:5,   precoUnitario:15000, fornecedor:"Distribuidora MG" },
    { nome:"Luvas Descartáveis",       categoria:"LIMPEZA",     unidade:"cx",  quantidadeAtual:10,  quantidadeMinima:2,   precoUnitario:25000, fornecedor:"Limpesa Total" },
  ];

  const itensDb = [];
  for (const def of ITENS_DEF) {
    const item = await prisma.itemEstoque.create({ data: { restauranteId: RESTAURANTE_ID, ...def } });
    itensDb.push(item);
  }
  console.log(`   ✅ ${itensDb.length} itens criados`);

  // ── 2. Movimentações de Estoque (CMV) ────────────────────────────────────────
  // CMV alvo: ~45% de 280M = 126M Gs/mês
  // Distribuição mensal por ingrediente-chave
  const CMV_MENSAL = [
    // [itemNome, qtdPorMes, variacaoPct]
    ["Queijo Mussarela",          1500, 0.10],  // 42M Gs/mês
    ["Calabresa",                  600, 0.12],  // 13.2M
    ["Catupiry",                   300, 0.10],  // 10.5M
    ["Carne Bovina (hambúrguer)",  400, 0.12],  // 14M
    ["Bacon",                      200, 0.10],  //  6M
    ["4 Quesos Mix",               200, 0.08],  //  7.6M
    ["Farinha de Trigo",          3000, 0.05],  // 10.5M
    ["Molho de Tomate",           1500, 0.08],  //  7.5M
    ["Tomate Seco",                150, 0.15],  //  6M
    ["Pepperoni",                  100, 0.15],  //  4.5M
    ["Pão de Hambúrguer",         1500, 0.08],  //  3.75M
    ["Azeite de Oliva",             20, 0.10],  //  0.84M
  ];
  // Total base: ~126.39M ✓

  console.log("📊 Registrando movimentações de estoque (CMV)...");
  const meses = gerarMeses();
  let cmvTotal = 0;

  for (const { str: mesSt, ano, mes } of meses) {
    const diaRef = new Date(Date.UTC(ano, mes, 15));
    for (const [nomeItem, qtdBase, variacao] of CMV_MENSAL) {
      const item = itensDb.find(i => i.nome === nomeItem);
      if (!item) continue;
      const qtd = Math.round(qtdBase * (1 + (Math.random() - 0.5) * variacao));
      await prisma.movimentacaoEstoque.create({
        data: {
          restauranteId: RESTAURANTE_ID,
          itemId: item.id,
          tipo: "SAIDA",
          quantidade: qtd,
          motivo: "PRODUCAO",
          observacao: `Consumo mensal ${mesSt}`,
          createdAt: diaRef,
        },
      });
      cmvTotal += qtd * item.precoUnitario;
    }
    process.stdout.write(`   CMV ${mesSt} ok\n`);
  }
  console.log(`   ✅ CMV total registrado: Gs ${cmvTotal.toLocaleString()}`);

  // ── 3. Custos Mensais ────────────────────────────────────────────────────────
  // Fixos base: 52M | Variáveis base: 45M | Total: 97M
  // Lucro = Faturamento(280M) - CMV(126M) - Custos(97M) = 57M ≈ 50M (cancelados reduzem fat.)
  console.log("💰 Registrando custos mensais...");

  const FIXOS = [
    { nome:"Aluguel do estabelecimento",  subcategoria:"ALUGUEL",     base:20000000, var:0.00 },
    { nome:"Salário — Pizzaiolo Chefe",   subcategoria:"FUNCIONARIO", base:7000000,  var:0.00 },
    { nome:"Salário — Pizzaiolo Aux.",    subcategoria:"FUNCIONARIO", base:5000000,  var:0.00 },
    { nome:"Salário — Atendente 1",       subcategoria:"FUNCIONARIO", base:4000000,  var:0.00 },
    { nome:"Salário — Atendente 2",       subcategoria:"FUNCIONARIO", base:4000000,  var:0.00 },
    { nome:"Salário — Entregador",        subcategoria:"FUNCIONARIO", base:4500000,  var:0.00 },
    { nome:"Energia Elétrica",            subcategoria:"ENERGIA",     base:4000000,  var:0.15 },
    { nome:"Água e Saneamento",           subcategoria:"AGUA",        base:1000000,  var:0.10 },
    { nome:"Internet + Telefone",         subcategoria:"INTERNET",    base:500000,   var:0.00 },
    { nome:"Seguro do estabelecimento",   subcategoria:"OUTRO",       base:2000000,  var:0.00 },
  ];
  const VARIAVEIS = [
    { nome:"Compra de Ingredientes",      subcategoria:"FORNECEDOR",  base:35000000, var:0.12 },
    { nome:"Embalagens e Descartáveis",   subcategoria:"EMBALAGEM",   base:5000000,  var:0.10 },
    { nome:"Manutenção de Equipamentos",  subcategoria:"MANUTENCAO",  base:2000000,  var:0.50 },
    { nome:"Marketing e Publicidade",     subcategoria:"OUTRO",       base:3000000,  var:0.30 },
  ];

  for (const { str: mesSt } of meses) {
    const custosBatch = [];
    for (const c of FIXOS) {
      custosBatch.push({ restauranteId: RESTAURANTE_ID, nome: c.nome, categoria: "FIXO", subcategoria: c.subcategoria, valor: Math.round(c.base * (1 + (Math.random() - 0.5) * c.var)), mes: mesSt });
    }
    for (const c of VARIAVEIS) {
      custosBatch.push({ restauranteId: RESTAURANTE_ID, nome: c.nome, categoria: "VARIAVEL", subcategoria: c.subcategoria, valor: Math.round(c.base * (1 + (Math.random() - 0.5) * c.var)), mes: mesSt });
    }
    await prisma.custoMensal.createMany({ data: custosBatch });
  }
  console.log(`   ✅ Custos de 6 meses registrados`);

  // ── 4. Pedidos ───────────────────────────────────────────────────────────────
  console.log("🛒 Criando pedidos (6 meses, ~78/dia)...");

  const BATCH_SIZE = 400;
  let totalPedidos = 0;

  for (const { str: mesSt, ano, mes } of meses) {
    const diasNoMes = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
    const sessoesData = [];
    const pedidosData = [];

    for (let dia = 1; dia <= diasNoMes; dia++) {
      const dow = new Date(Date.UTC(ano, mes, dia)).getUTCDay();
      const fds = dow === 0 || dow === 6;
      const numPedidos = fds ? ri(90, 110) : ri(65, 85);

      for (let p = 0; p < numPedidos; p++) {
        const hora = pick(HORAS_PICO);
        const dataHora = new Date(Date.UTC(ano, mes, dia, hora, ri(0,59), ri(0,59)));
        const cliente = pick(CLIENTES);
        const isDelivery = Math.random() > 0.3;
        const status = pick(STATUS_POOL);
        const itens = gerarItens();
        const subtotal = itens.reduce((s, i) => s + i.preco * i.quantidade, 0);
        const total = subtotal + (isDelivery ? TAXA_ENTREGA : 0);
        const sessaoId = randomUUID();

        sessoesData.push({
          id: sessaoId,
          clienteNumero: cliente.numero,
          clienteNome: cliente.nome,
          restauranteId: RESTAURANTE_ID,
          estado: "FINALIZADO",
          carrinho: itens,
          ultimaAtividade: dataHora,
          createdAt: dataHora,
        });
        pedidosData.push({
          sessaoId,
          restauranteId: RESTAURANTE_ID,
          clienteNumero: cliente.numero,
          clienteNome: cliente.nome,
          itens,
          total,
          status,
          pago: ["ENTREGUE","PREPARANDO","SAIU_PARA_ENTREGA","PRONTO_PARA_RETIRADA"].includes(status),
          localizacao: isDelivery ? pick(LOCALIZACOES) : null,
          metodoPagamento: pick(METODOS),
          createdAt: dataHora,
        });
      }
    }

    // Batch insert
    for (let i = 0; i < sessoesData.length; i += BATCH_SIZE) {
      await prisma.sessao.createMany({ data: sessoesData.slice(i, i + BATCH_SIZE) });
      await prisma.pedido.createMany({ data: pedidosData.slice(i, i + BATCH_SIZE) });
    }

    const fat = pedidosData.filter(p => p.status !== "CANCELADO").reduce((s, p) => s + p.total, 0);
    console.log(`   📅 ${mesSt}: ${pedidosData.length} pedidos | Gs ${fat.toLocaleString()}`);
    totalPedidos += pedidosData.length;
  }

  // ── 5. Atualizar fidelidade ───────────────────────────────────────────────────
  console.log("\n👥 Atualizando fidelidade...");
  for (const cliente of CLIENTES) {
    const rows = await prisma.pedido.findMany({
      where: { clienteNumero: cliente.numero, restauranteId: RESTAURANTE_ID, status: { not: "CANCELADO" } },
      select: { total: true, createdAt: true },
    });
    if (!rows.length) continue;
    const totalGasto = rows.reduce((s, p) => s + p.total, 0);
    const ultimoPedido = rows.reduce((d, p) => new Date(p.createdAt) > d ? new Date(p.createdAt) : d, new Date(0));
    await prisma.clienteFidelidade.upsert({
      where: { numero_restauranteId: { numero: cliente.numero, restauranteId: RESTAURANTE_ID } },
      create: { numero: cliente.numero, restauranteId: RESTAURANTE_ID, nome: cliente.nome, totalPedidos: rows.length, totalGasto, ultimoPedido },
      update: { nome: cliente.nome, totalPedidos: rows.length, totalGasto, ultimoPedido },
    });
  }

  console.log(`\n🎉 Concluído! ${totalPedidos} pedidos criados.\n`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
