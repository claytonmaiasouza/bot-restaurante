const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { encerrarSessoesInativas } = require("../services/sessaoService");
const { enviarMensagem } = require("../services/evolutionService");

const prisma = new PrismaClient();

const LOGS_DIR = path.resolve(__dirname, "../../logs");

// Garante que o diretório de logs existe
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dataFormatada(date, separador = "-") {
  return date.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })
    .split("/")
    .reverse()
    .join(separador);
}

function log(msg) {
  const ts = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  console.log(`[jobs] ${ts} — ${msg}`);
}

// ── Job 1: Sessões inativas (a cada 30 min) ───────────────────────────────────

function iniciarJobSessoes() {
  cron.schedule("*/30 * * * *", async () => {
    log("verificando sessões inativas...");
    try {
      const encerradas = await encerrarSessoesInativas();
      if (encerradas > 0) {
        log(`${encerradas} sessão(ões) encerrada(s) por inatividade`);
      }
    } catch (err) {
      log(`ERRO ao encerrar sessões inativas: ${err.message}`);
    }
  });

  log("job de limpeza de sessões agendado (*/30 * * * *)");
}

// ── Job 2: Relatório diário (todo dia às 00:05) ───────────────────────────────

function iniciarJobRelatorio() {
  cron.schedule("5 0 * * *", async () => {
    // Calcula a janela do dia anterior
    const ontem = new Date();
    ontem.setDate(ontem.getDate() - 1);
    ontem.setHours(0, 0, 0, 0);

    const fimOntem = new Date(ontem);
    fimOntem.setHours(23, 59, 59, 999);

    log(`gerando relatório do dia ${dataFormatada(ontem)}...`);

    try {
      await gerarRelatorio(ontem, fimOntem);
    } catch (err) {
      log(`ERRO ao gerar relatório: ${err.message}`);
    }
  }, { timezone: "America/Sao_Paulo" });

  log("job de relatório diário agendado (5 0 * * *)");
}

// ── Geração do relatório ──────────────────────────────────────────────────────

async function gerarRelatorio(inicio, fim) {
  const where = { createdAt: { gte: inicio, lte: fim } };

  const [pedidos, faturamento, clientesUnicos, porRestaurante] =
    await prisma.$transaction([
      prisma.pedido.count({ where }),
      prisma.pedido.aggregate({ where, _sum: { total: true }, _avg: { total: true } }),
      prisma.pedido.groupBy({
        by: ["clienteNumero"],
        where,
        _count: { clienteNumero: true },
      }),
      prisma.pedido.groupBy({
        by: ["restauranteId"],
        where,
        _count: { id: true },
        _sum: { total: true },
      }),
    ]);

  // Enriquece com nome dos restaurantes
  const restauranteIds = porRestaurante.map((r) => r.restauranteId);
  const restaurantes = await prisma.restaurante.findMany({
    where: { id: { in: restauranteIds } },
    select: { id: true, nome: true },
  });
  const nomeMap = Object.fromEntries(restaurantes.map((r) => [r.id, r.nome]));

  const linhasRestaurantes = porRestaurante
    .sort((a, b) => (b._sum.total ?? 0) - (a._sum.total ?? 0))
    .map((r) => {
      const nome = nomeMap[r.restauranteId] || r.restauranteId;
      return `  - ${nome}: ${r._count.id} pedido(s) | R$ ${(r._sum.total ?? 0).toFixed(2)}`;
    })
    .join("\n");

  const relatorio = [
    `=== RELATÓRIO DIÁRIO — ${dataFormatada(inicio, "/")} ===`,
    ``,
    `Total de pedidos   : ${pedidos}`,
    `Clientes únicos    : ${clientesUnicos.length}`,
    `Faturamento total  : R$ ${(faturamento._sum.total ?? 0).toFixed(2)}`,
    `Ticket médio       : R$ ${(faturamento._avg.total ?? 0).toFixed(2)}`,
    ``,
    `Por restaurante:`,
    linhasRestaurantes || "  (nenhum pedido)",
    ``,
    `Gerado em: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`,
    ``,
  ].join("\n");

  const nomeArquivo = `relatorio-${dataFormatada(inicio)}.txt`;
  const caminho = path.join(LOGS_DIR, nomeArquivo);
  fs.writeFileSync(caminho, relatorio, "utf8");

  log(`relatório salvo em logs/${nomeArquivo}`);
  console.log(relatorio);
}

// ── Job 3: Lembrete de inatividade (a cada 1 min) ─────────────────────────────

function iniciarJobLembrete() {
  cron.schedule("* * * * *", async () => {
    try {
      const limite = new Date(Date.now() - 4 * 60 * 1000); // 4 minutos atrás

      const sessoes = await prisma.sessao.findMany({
        where: {
          estado: { notIn: ["FINALIZADO", "INICIO"] },
          botPausado: false,
          lembreteEnviado: false,
          ultimaAtividade: { lt: limite },
        },
        include: { restaurante: true },
      });

      for (const sessao of sessoes) {
        const msg =
          `Olá${sessao.clienteNome ? `, ${sessao.clienteNome}` : ""}! 😊 Ainda está aí?\n\n` +
          `Pode continuar com seu pedido quando quiser. Estamos aqui! 🍽️`;

        await enviarMensagem(
          sessao.clienteNumero,
          msg,
          sessao.restaurante.slugWhatsapp
        );

        await prisma.sessao.update({
          where: { id: sessao.id },
          data: { lembreteEnviado: true },
        });

        log(`lembrete enviado para ${sessao.clienteNumero} (sessão ${sessao.id.split("-")[0]})`);
      }
    } catch (err) {
      log(`ERRO no job de lembrete: ${err.message}`);
    }
  });

  log("job de lembrete de inatividade agendado (* * * * *)");
}

// ── Exporta e inicializa ──────────────────────────────────────────────────────

function iniciarJobs() {
  iniciarJobSessoes();
  iniciarJobRelatorio();
  iniciarJobLembrete();
}

module.exports = { iniciarJobs, gerarRelatorio };
