const { Router } = require("express");
const { PrismaClient } = require("@prisma/client");
const { confirmarPedido } = require("../services/pedidoService");
const {
  listarInstancias,
  obterQRCode,
  verificarConexao,
  criarInstancia,
  configurarWebhook,
} = require("../services/evolutionService");

const router = Router();
const prisma = new PrismaClient();

// ── Middleware: autenticação por header ───────────────────────────────────────
router.use((req, res, next) => {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Não autorizado" });
  }
  next();
});

// ── GET /admin/pedidos?restauranteId=X&status=NOVO&pagina=1 ──────────────────
router.get("/pedidos", async (req, res) => {
  const { restauranteId, status, pagina = 1 } = req.query;
  const limite = 20;
  const offset = (Number(pagina) - 1) * limite;

  const where = {};
  if (restauranteId) where.restauranteId = restauranteId;
  if (status) where.status = status;

  try {
    const [pedidos, total] = await prisma.$transaction([
      prisma.pedido.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limite,
        include: {
          restaurante: { select: { nome: true, slugWhatsapp: true } },
        },
      }),
      prisma.pedido.count({ where }),
    ]);

    res.json({
      data: pedidos,
      meta: {
        total,
        pagina: Number(pagina),
        limite,
        paginas: Math.ceil(total / limite),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/clientes/fidelidade?limite=10 ─────────────────────────────────
router.get("/clientes/fidelidade", async (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 10, 100);

  try {
    const clientes = await prisma.clienteFidelidade.findMany({
      orderBy: { totalGasto: "desc" },
      take: limite,
    });
    res.json({ data: clientes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /admin/pedidos/:id/status ──────────────────────────────────────────
router.patch("/pedidos/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const statusValidos = ["NOVO", "CONFIRMADO", "CANCELADO"];
  if (!statusValidos.includes(status)) {
    return res
      .status(400)
      .json({ error: `Status inválido. Use: ${statusValidos.join(", ")}` });
  }

  try {
    if (status === "CONFIRMADO") {
      const pedido = await confirmarPedido(id);
      return res.json({ data: pedido });
    }

    const pedido = await prisma.pedido.update({
      where: { id },
      data: { status },
    });
    res.json({ data: pedido });
  } catch (err) {
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Pedido não encontrado" });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/stats?restauranteId=X ─────────────────────────────────────────
router.get("/stats", async (req, res) => {
  const { restauranteId } = req.query;
  const where = {};
  if (restauranteId) where.restauranteId = restauranteId;

  const inicioDia = new Date();
  inicioDia.setHours(0, 0, 0, 0);
  const whereHoje = { ...where, createdAt: { gte: inicioDia } };

  try {
    const [
      totalPedidos,
      pedidosHoje,
      faturamentoAgregado,
      faturamentoHojeAgregado,
      clientesUnicos,
      sessoesAtivas,
    ] = await prisma.$transaction([
      prisma.pedido.count({ where }),
      prisma.pedido.count({ where: whereHoje }),
      prisma.pedido.aggregate({ where, _sum: { total: true } }),
      prisma.pedido.aggregate({ where: whereHoje, _sum: { total: true } }),
      prisma.pedido.groupBy({
        by: ["clienteNumero"],
        where,
        _count: { clienteNumero: true },
      }),
      prisma.sessao.count({
        where: {
          ...(restauranteId ? { restauranteId } : {}),
          estado: { not: "FINALIZADO" },
        },
      }),
    ]);

    res.json({
      data: {
        totalPedidos,
        pedidosHoje,
        faturamentoTotal: faturamentoAgregado._sum.total ?? 0,
        faturamentoHoje: faturamentoHojeAgregado._sum.total ?? 0,
        clientesUnicos: clientesUnicos.length,
        sessoesAtivas,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══ Rotas de Instâncias Evolution API ════════════════════════════════════════

// ── GET /admin/instancias ─────────────────────────────────────────────────────
/**
 * Lista todas as instâncias na Evolution API cruzadas com os restaurantes locais.
 */
router.get("/instancias", async (req, res) => {
  try {
    const [instancias, restaurantes] = await Promise.all([
      listarInstancias(),
      prisma.restaurante.findMany({
        select: { id: true, nome: true, slugWhatsapp: true, ativo: true },
      }),
    ]);

    const slugMap = Object.fromEntries(
      restaurantes.map((r) => [r.slugWhatsapp, r])
    );

    const resultado = instancias.map((inst) => {
      const nome = inst.name || inst.instanceName || inst.instance?.instanceName;
      const estado = inst.connectionStatus || inst.instance?.state || "unknown";
      const restaurante = slugMap[nome] || null;

      return {
        instanceName: nome,
        status: estado,
        connected: estado === "open",
        restaurante: restaurante
          ? { id: restaurante.id, nome: restaurante.nome, ativo: restaurante.ativo }
          : null,
      };
    });

    res.json({ data: resultado, total: resultado.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/instancias/:slug/reconectar ───────────────────────────────────
/**
 * Recria a instância (se necessário) e retorna novo QR code.
 */
router.post("/instancias/:slug/reconectar", async (req, res) => {
  const { slug } = req.params;

  try {
    const restaurante = await prisma.restaurante.findUnique({
      where: { slugWhatsapp: slug },
    });

    if (!restaurante) {
      return res.status(404).json({ error: "Restaurante não encontrado" });
    }

    // Garante que a instância existe
    await criarInstancia(restaurante);

    // Obtém novo QR code
    const qr = await obterQRCode(slug);

    if (!qr || !qr.qrcode) {
      // Instância pode já estar conectada
      const conexao = await verificarConexao(slug);
      if (conexao.connected) {
        return res.json({
          message: "Instância já está conectada — nenhum QR code necessário",
          status: conexao,
        });
      }
      return res.status(202).json({
        message: "QR code ainda não disponível — aguarde alguns segundos e tente novamente",
        status: conexao,
      });
    }

    res.json({ qrcode: qr, status: "aguardando_scan" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/instancias/:slug/qrcode ───────────────────────────────────────
/**
 * Retorna o QR code atual de uma instância sem recriar.
 */
router.get("/instancias/:slug/qrcode", async (req, res) => {
  const { slug } = req.params;

  try {
    const conexao = await verificarConexao(slug);

    if (conexao.connected) {
      return res.json({
        message: "Instância já conectada",
        connected: true,
        number: conexao.number,
      });
    }

    if (conexao.status === "not_found") {
      return res.status(404).json({
        error: "Instância não encontrada — use /onboarding/restaurante para criá-la",
      });
    }

    const qr = await obterQRCode(slug);

    if (!qr || !qr.qrcode) {
      return res.status(202).json({
        message: "QR code ainda não disponível — aguarde alguns segundos",
        status: conexao.status,
      });
    }

    res.json({ qrcode: qr, status: conexao.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
