const { Router } = require("express");
const { PrismaClient } = require("@prisma/client");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { confirmarPedido } = require("../services/pedidoService");
const { enviarMensagem, listarInstancias, obterQRCode, verificarConexao, criarInstancia, configurarWebhook } = require("../services/evolutionService");
const { authMiddleware } = require("../middleware/authMiddleware");
const {
  buscarCardapioDB, criarCategoria, atualizarCategoria, deletarCategoria,
  criarProduto, atualizarProduto, deletarProduto, atualizarTamanho, deletarTamanho,
  importarCardapio,
} = require("../services/cardapioService");
const { invalidarCache } = require("../services/tenantService");
const bcrypt = require("bcryptjs");

// Multer: armazena PDF em memória (sem salvar em disco)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Multer: salva PDF de cardápio em disco
const UPLOADS_DIR = path.resolve(__dirname, "../../public/uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const uploadDisco = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, _file, cb) => cb(null, `cardapio-${req.params.id}.pdf`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype === "application/pdf"),
});

const router = Router();
const prisma = new PrismaClient();

function idCurto(uuid) {
  return uuid.split("-")[0].toUpperCase();
}

const STATUS_VALIDOS = [
  "NOVO", "CONFIRMADO", "PAGO", "PREPARANDO",
  "SAIU_PARA_ENTREGA", "PRONTO_PARA_RETIRADA", "ENTREGUE", "CANCELADO",
];

const NOTIFICACOES = {
  CONFIRMADO: (id) => `✅ Seu pedido *#${id}* foi confirmado pelo restaurante! Logo começaremos a preparar. 🍽️`,
  PAGO: (id) => `💳 Pagamento do pedido *#${id}* confirmado! Obrigado! ✅`,
  PREPARANDO: (id) => `👨‍🍳 Seu pedido *#${id}* está sendo preparado com carinho! Em breve ficará pronto. 🍕`,
  SAIU_PARA_ENTREGA: (id) => `🛵 Seu pedido *#${id}* saiu para entrega! Em breve chegará até você. 😊`,
  PRONTO_PARA_RETIRADA: (id) => `🏪 Seu pedido *#${id}* está pronto! Pode vir retirar no balcão. 😊`,
  ENTREGUE: (id) => `✅ Pedido *#${id}* entregue com sucesso! Obrigado pela preferência. 😊`,
  CANCELADO: (id) => `❌ Seu pedido *#${id}* foi cancelado. Entre em contato com o restaurante para mais informações.`,
};

// ── Middleware: autenticação (admin token ou JWT do restaurante) ───────────────
router.use(authMiddleware);

// ── Helper: restauranteId efetivo (JWT scope ou query param) ──────────────────
function resolverRestauranteId(req) {
  if (req.user.role === "restaurante") return req.user.restauranteId;
  return req.query.restauranteId || req.body?.restauranteId || null;
}

// ── GET /admin/restaurantes ───────────────────────────────────────────────────
router.get("/restaurantes", async (req, res) => {
  try {
    const where = req.user.role === "restaurante" ? { id: req.user.restauranteId } : {};
    const restaurantes = await prisma.restaurante.findMany({
      where,
      select: { id: true, nome: true, slugWhatsapp: true, donoWhatsapp: true, moeda: true, taxaEntrega: true, ativo: true, email: true, horarioAtendimento: true, cardapioPdfUrl: true },
      orderBy: { nome: "asc" },
    });
    res.json({ data: restaurantes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/pedidos?restauranteId=X&status=NOVO&pagina=1 ──────────────────
router.get("/pedidos", async (req, res) => {
  const { status, pagina = 1 } = req.query;
  const restauranteId = resolverRestauranteId(req);
  const limite = 50;
  const offset = (Number(pagina) - 1) * limite;

  const where = {};
  if (restauranteId) where.restauranteId = restauranteId;
  if (status && status !== "Todos") {
    if (status === "PAGO") {
      where.pago = true; // aba PAGO mostra todos os pagos, independente do status
    } else {
      where.status = status;
    }
  }

  try {
    const [pedidos, total] = await prisma.$transaction([
      prisma.pedido.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limite,
        include: {
          restaurante: { select: { nome: true, slugWhatsapp: true, moeda: true, taxaEntrega: true } },
        },
      }),
      prisma.pedido.count({ where }),
    ]);

    res.json({ data: pedidos, meta: { total, pagina: Number(pagina), limite, paginas: Math.ceil(total / limite) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/pedidos/:id ────────────────────────────────────────────────────
router.get("/pedidos/:id", async (req, res) => {
  try {
    const pedido = await prisma.pedido.findUnique({
      where: { id: req.params.id },
      include: { restaurante: { select: { nome: true, slugWhatsapp: true, moeda: true, taxaEntrega: true } } },
    });
    if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });
    res.json({ data: pedido });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /admin/pedidos/:id/status ──────────────────────────────────────────
router.patch("/pedidos/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const io = req.app.get("io");

  if (!STATUS_VALIDOS.includes(status)) {
    return res.status(400).json({ error: `Status inválido. Use: ${STATUS_VALIDOS.join(", ")}` });
  }

  try {
    const pedido = await prisma.pedido.update({
      where: { id },
      data: { status },
      include: { restaurante: { select: { nome: true, slugWhatsapp: true, moeda: true, taxaEntrega: true } } },
    });

    // Notifica o cliente via WhatsApp
    const mensagem = NOTIFICACOES[status]?.(idCurto(pedido.id));
    if (mensagem) {
      await enviarMensagem(pedido.clienteNumero, mensagem, pedido.restaurante.slugWhatsapp).catch(() => {});
    }

    // Emite para o painel em tempo real
    io?.to("admin").emit("pedido:atualizado", pedido);
    io?.to(`restaurante:${pedido.restaurante.slugWhatsapp}`).emit("pedido:atualizado", pedido);

    res.json({ data: pedido });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Pedido não encontrado" });
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /admin/pedidos/:id/pago ────────────────────────────────────────────
router.patch("/pedidos/:id/pago", async (req, res) => {
  const { id } = req.params;
  const io = req.app.get("io");

  try {
    const atual = await prisma.pedido.findUnique({ where: { id }, select: { status: true } });
    if (!atual) return res.status(404).json({ error: "Pedido não encontrado" });

    // Muda status para PAGO exceto se já entregue ou cancelado
    const novoStatus = ["ENTREGUE", "CANCELADO"].includes(atual.status) ? atual.status : "PAGO";

    const pedido = await prisma.pedido.update({
      where: { id },
      data: { pago: true, status: novoStatus },
      include: { restaurante: { select: { nome: true, slugWhatsapp: true, moeda: true, taxaEntrega: true } } },
    });

    if (novoStatus === "PAGO") {
      const mensagem = NOTIFICACOES["PAGO"]?.(idCurto(pedido.id));
      if (mensagem) {
        await enviarMensagem(pedido.clienteNumero, mensagem, pedido.restaurante.slugWhatsapp).catch(() => {});
      }
    }

    io?.to("admin").emit("pedido:atualizado", pedido);
    io?.to(`restaurante:${pedido.restaurante.slugWhatsapp}`).emit("pedido:atualizado", pedido);

    res.json({ data: pedido });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Pedido não encontrado" });
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

// ── GET /admin/stats?restauranteId=X ─────────────────────────────────────────
router.get("/stats", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  const where = {};
  if (restauranteId) where.restauranteId = restauranteId;

  const inicioDia = new Date();
  inicioDia.setHours(0, 0, 0, 0);
  const whereHoje = { ...where, createdAt: { gte: inicioDia } };
  const whereAberto = { ...where, status: { notIn: ["ENTREGUE", "CANCELADO"] } };
  const wherePago = { ...where, pago: true };
  const wherePagoHoje = { ...where, pago: true, createdAt: { gte: inicioDia } };

  try {
    const [totalPedidos, pedidosHoje, faturamentoAgregado, faturamentoHojeAgregado, clientesUnicos, sessoesAtivas, emAberto] =
      await prisma.$transaction([
        prisma.pedido.count({ where }),
        prisma.pedido.count({ where: whereHoje }),
        prisma.pedido.aggregate({ where: wherePago, _sum: { total: true } }),
        prisma.pedido.aggregate({ where: wherePagoHoje, _sum: { total: true } }),
        prisma.pedido.groupBy({ by: ["clienteNumero"], where, _count: { clienteNumero: true } }),
        prisma.sessao.count({ where: { ...(restauranteId ? { restauranteId } : {}), estado: { not: "FINALIZADO" } } }),
        prisma.pedido.count({ where: whereAberto }),
      ]);

    res.json({
      data: {
        totalPedidos,
        pedidosHoje,
        faturamentoTotal: faturamentoAgregado._sum.total ?? 0,
        faturamentoHoje: faturamentoHojeAgregado._sum.total ?? 0,
        clientesUnicos: clientesUnicos.length,
        sessoesAtivas,
        emAberto,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══ Rotas de Conversas ═══════════════════════════════════════════════════════

router.get("/conversas", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  const { encerradas } = req.query;
  const where = encerradas === "true" ? { estado: "FINALIZADO" } : { estado: { not: "FINALIZADO" } };
  if (restauranteId) where.restauranteId = restauranteId;

  try {
    const sessoes = await prisma.sessao.findMany({
      where,
      orderBy: { ultimaAtividade: "desc" },
      take: 100,
      select: {
        id: true, clienteNumero: true, clienteNome: true,
        estado: true, botPausado: true, ultimaAtividade: true,
        restaurante: { select: { nome: true, slugWhatsapp: true } },
        mensagens: { orderBy: { createdAt: "desc" }, take: 1,
          select: { conteudo: true, role: true, createdAt: true } },
      },
    });
    res.json({ data: sessoes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/conversas/:id/mensagens", async (req, res) => {
  try {
    const mensagens = await prisma.mensagem.findMany({
      where: { sessaoId: req.params.id },
      orderBy: { createdAt: "asc" },
    });
    res.json({ data: mensagens });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/conversas/:id/pausar", async (req, res) => {
  const io = req.app.get("io");
  try {
    const sessao = await prisma.sessao.findUnique({ where: { id: req.params.id } });
    if (!sessao) return res.status(404).json({ error: "Sessão não encontrada" });

    const atualizada = await prisma.sessao.update({
      where: { id: req.params.id },
      data: { botPausado: !sessao.botPausado },
    });

    io?.to("admin").emit("conversa:atualizada", { id: atualizada.id, botPausado: atualizada.botPausado });
    res.json({ data: { botPausado: atualizada.botPausado } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/conversas/:id/mensagem", async (req, res) => {
  const { mensagem } = req.body;
  if (!mensagem?.trim()) return res.status(400).json({ error: "Mensagem vazia" });

  try {
    const sessao = await prisma.sessao.findUnique({
      where: { id: req.params.id },
      include: { restaurante: true },
    });
    if (!sessao) return res.status(404).json({ error: "Sessão não encontrada" });

    await enviarMensagem(sessao.clienteNumero, mensagem.trim(), sessao.restaurante.slugWhatsapp);

    const msg = await prisma.mensagem.create({
      data: { sessaoId: sessao.id, role: "bot", conteudo: `[admin] ${mensagem.trim()}` },
    });

    const io = req.app.get("io");
    io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: msg });

    res.json({ data: msg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══ Clientes ══════════════════════════════════════════════════════════════════

router.get("/clientes", async (req, res) => {
  const { busca, pagina = 1 } = req.query;
  const limite = 50;
  const offset = (Number(pagina) - 1) * limite;

  const where = {};
  if (busca) {
    where.OR = [
      { nome: { contains: busca, mode: "insensitive" } },
      { numero: { contains: busca } },
    ];
  }

  try {
    const [clientes, total] = await prisma.$transaction([
      prisma.clienteFidelidade.findMany({
        where,
        orderBy: { ultimoPedido: "desc" },
        skip: offset,
        take: limite,
      }),
      prisma.clienteFidelidade.count({ where }),
    ]);
    res.json({ data: clientes, meta: { total, pagina: Number(pagina), limite, paginas: Math.ceil(total / limite) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /admin/clientes/:id ─────────────────────────────────────────────────
router.patch("/clientes/:id", async (req, res) => {
  const { nome } = req.body;
  try {
    const cliente = await prisma.clienteFidelidade.update({
      where: { id: req.params.id },
      data: { nome: nome !== undefined ? (nome || null) : undefined },
    });
    res.json({ data: cliente });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Cliente não encontrado" });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/disparar ──────────────────────────────────────────────────────
// Envia uma mensagem em massa para clientes de um restaurante
router.post("/disparar", async (req, res) => {
  const { mensagem, filtro } = req.body;
  const rid = req.body.restauranteId || resolverRestauranteId(req);

  if (!mensagem?.trim()) return res.status(400).json({ error: "Mensagem obrigatória" });
  if (!rid) return res.status(400).json({ error: "restauranteId obrigatório" });

  try {
    const restaurante = await prisma.restaurante.findUnique({
      where: { id: rid },
      select: { slugWhatsapp: true },
    });
    if (!restaurante) return res.status(404).json({ error: "Restaurante não encontrado" });

    let numeros = [];

    // Busca todos os clientes que têm histórico neste restaurante
    const todosClientes = await prisma.clienteFidelidade.findMany();
    const clientesDoRestaurante = todosClientes.filter((c) => {
      const hist = Array.isArray(c.restaurantes) ? c.restaurantes : [];
      return hist.some((h) => h.restauranteId === rid);
    });

    if (filtro && filtro !== "todos") {
      // filtro = id do programa de fidelidade → apenas clientes qualificados
      const programa = await prisma.programaFidelidade.findUnique({ where: { id: filtro } });
      if (!programa) return res.status(404).json({ error: "Programa não encontrado" });

      numeros = clientesDoRestaurante
        .filter((c) => {
          const hist = Array.isArray(c.restaurantes) ? c.restaurantes : [];
          const r = hist.find((h) => h.restauranteId === rid);
          return r ? clienteQualificado(r, programa) : false;
        })
        .map((c) => c.numero);
    } else {
      numeros = clientesDoRestaurante.map((c) => c.numero);
    }

    let enviadas = 0;
    let erros = 0;
    for (const numero of numeros) {
      try {
        await enviarMensagem(numero, mensagem.trim(), restaurante.slugWhatsapp);
        enviadas++;
      } catch {
        erros++;
      }
    }

    res.json({ ok: true, enviadas, erros, total: numeros.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══ Programas de fidelidade ═══════════════════════════════════════════════════

// Helper: verifica se cliente tem resgate pendente para um programa
function clienteQualificado(histRestaurante, programa) {
  const r = histRestaurante;
  const resgatesFeitos = r.resgates || 0;
  const progresso = programa.tipo === "PEDIDOS" ? (r.pedidos || 0) : (r.gasto || 0);
  return Math.floor(progresso / programa.meta) > resgatesFeitos;
}

router.get("/fidelidade", async (req, res) => {
  const rid = resolverRestauranteId(req);
  if (!rid) return res.status(400).json({ error: "restauranteId obrigatório" });
  try {
    const programas = await prisma.programaFidelidade.findMany({
      where: { restauranteId: rid },
      orderBy: { createdAt: "asc" },
    });
    res.json({ data: programas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/fidelidade", async (req, res) => {
  const rid = resolverRestauranteId(req);
  if (!rid) return res.status(400).json({ error: "restauranteId obrigatório" });
  const { nome, descricao, tipo = "PEDIDOS", meta } = req.body;
  if (!nome || meta === undefined) return res.status(400).json({ error: "nome e meta obrigatórios" });
  try {
    const p = await prisma.programaFidelidade.create({
      data: { restauranteId: rid, nome, descricao: descricao || null, tipo, meta: parseFloat(meta) },
    });
    res.status(201).json({ data: p });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/fidelidade/:id", async (req, res) => {
  const { nome, descricao, tipo, meta, ativo } = req.body;
  try {
    const p = await prisma.programaFidelidade.update({
      where: { id: req.params.id },
      data: {
        ...(nome && { nome }),
        ...(descricao !== undefined && { descricao }),
        ...(tipo && { tipo }),
        ...(meta !== undefined && { meta: parseFloat(meta) }),
        ...(ativo !== undefined && { ativo }),
      },
    });
    res.json({ data: p });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Programa não encontrado" });
    res.status(500).json({ error: err.message });
  }
});

router.delete("/fidelidade/:id", async (req, res) => {
  try {
    await prisma.programaFidelidade.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Programa não encontrado" });
    res.status(500).json({ error: err.message });
  }
});

// Clientes que têm resgate pendente
router.get("/fidelidade/:id/qualificados", async (req, res) => {
  try {
    const programa = await prisma.programaFidelidade.findUnique({ where: { id: req.params.id } });
    if (!programa) return res.status(404).json({ error: "Programa não encontrado" });

    const clientes = await prisma.clienteFidelidade.findMany();
    const qualificados = clientes
      .map((c) => {
        const hist = Array.isArray(c.restaurantes) ? c.restaurantes : [];
        const r = hist.find((h) => h.restauranteId === programa.restauranteId);
        if (!r || !clienteQualificado(r, programa)) return null;
        return {
          id: c.id,
          nome: c.nome,
          numero: c.numero,
          pedidos: r.pedidos || 0,
          gasto: r.gasto || 0,
          resgates: r.resgates || 0,
        };
      })
      .filter(Boolean);

    res.json({ data: qualificados, total: qualificados.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Registrar resgate para um cliente
router.post("/fidelidade/:id/resgatar", async (req, res) => {
  const { clienteNumero } = req.body;
  if (!clienteNumero) return res.status(400).json({ error: "clienteNumero obrigatório" });

  try {
    const programa = await prisma.programaFidelidade.findUnique({ where: { id: req.params.id } });
    if (!programa) return res.status(404).json({ error: "Programa não encontrado" });

    const cliente = await prisma.clienteFidelidade.findUnique({ where: { numero: clienteNumero } });
    if (!cliente) return res.status(404).json({ error: "Cliente não encontrado" });

    const hist = Array.isArray(cliente.restaurantes) ? [...cliente.restaurantes] : [];
    const idx = hist.findIndex((h) => h.restauranteId === programa.restauranteId);
    if (idx < 0) return res.status(400).json({ error: "Cliente sem histórico neste restaurante" });

    if (!clienteQualificado(hist[idx], programa)) {
      return res.status(400).json({ error: "Cliente não qualificado para resgate" });
    }

    hist[idx] = { ...hist[idx], resgates: (hist[idx].resgates || 0) + 1 };

    // Determina quem está registrando
    const registradoPor = req.user.role === "admin" ? "super-admin" : (req.user.email || req.user.restauranteId || "restaurante");

    await prisma.$transaction([
      // Atualiza contador no histórico do cliente
      prisma.clienteFidelidade.update({
        where: { numero: clienteNumero },
        data: { restaurantes: hist },
      }),
      // Salva registro no histórico de resgates
      prisma.resgateFidelidade.create({
        data: {
          programaId: programa.id,
          clienteNumero,
          clienteNome: cliente.nome || null,
          registradoPor,
        },
      }),
    ]);

    res.json({ ok: true, resgatesTotal: hist[idx].resgates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Histórico de resgates de um programa
router.get("/fidelidade/:id/resgates", async (req, res) => {
  const { pagina = 1 } = req.query;
  const limite = 50;
  const offset = (Number(pagina) - 1) * limite;

  try {
    const programa = await prisma.programaFidelidade.findUnique({ where: { id: req.params.id } });
    if (!programa) return res.status(404).json({ error: "Programa não encontrado" });

    const [resgates, total] = await prisma.$transaction([
      prisma.resgateFidelidade.findMany({
        where: { programaId: req.params.id },
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limite,
      }),
      prisma.resgateFidelidade.count({ where: { programaId: req.params.id } }),
    ]);

    res.json({ data: resgates, meta: { total, pagina: Number(pagina), limite, paginas: Math.ceil(total / limite) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══ Rotas de Instâncias Evolution API (somente super admin) ══════════════════

router.get("/instancias", async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Acesso restrito ao super admin" });
  try {
    const [instancias, restaurantes] = await Promise.all([
      listarInstancias(),
      prisma.restaurante.findMany({ select: { id: true, nome: true, slugWhatsapp: true, ativo: true } }),
    ]);

    const slugMap = Object.fromEntries(restaurantes.map((r) => [r.slugWhatsapp, r]));
    const resultado = instancias.map((inst) => {
      const nome = inst.name || inst.instanceName || inst.instance?.instanceName;
      const estado = inst.connectionStatus || inst.instance?.state || "unknown";
      const restaurante = slugMap[nome] || null;
      return {
        instanceName: nome,
        status: estado,
        connected: estado === "open",
        restaurante: restaurante ? { id: restaurante.id, nome: restaurante.nome, ativo: restaurante.ativo } : null,
      };
    });

    res.json({ data: resultado, total: resultado.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/instancias/:slug/reconectar", async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Acesso restrito ao super admin" });
  const { slug } = req.params;
  try {
    const restaurante = await prisma.restaurante.findUnique({ where: { slugWhatsapp: slug } });
    if (!restaurante) return res.status(404).json({ error: "Restaurante não encontrado" });

    await criarInstancia(restaurante);
    const qr = await obterQRCode(slug);

    if (!qr || !qr.qrcode) {
      const conexao = await verificarConexao(slug);
      if (conexao.connected) return res.json({ message: "Instância já está conectada", status: conexao });
      return res.status(202).json({ message: "QR code ainda não disponível — tente novamente", status: conexao });
    }

    res.json({ qrcode: qr, status: "aguardando_scan" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/instancias/:slug/qrcode", async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Acesso restrito ao super admin" });
  const { slug } = req.params;
  try {
    const conexao = await verificarConexao(slug);
    if (conexao.connected) return res.json({ message: "Instância já conectada", connected: true, number: conexao.number });
    if (conexao.status === "not_found") return res.status(404).json({ error: "Instância não encontrada" });

    const qr = await obterQRCode(slug);
    if (!qr || !qr.qrcode) return res.status(202).json({ message: "QR code ainda não disponível", status: conexao.status });
    res.json({ qrcode: qr, status: conexao.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /admin/restaurantes/:id ────────────────────────────────────────────
router.patch("/restaurantes/:id", async (req, res) => {
  const { id } = req.params;

  // Restaurante só pode editar o próprio
  if (req.user.role === "restaurante" && req.user.restauranteId !== id) {
    return res.status(403).json({ error: "Acesso negado" });
  }

  const { nome, donoWhatsapp, moeda, taxaEntrega, email, senha, ativo, horarioAtendimento } = req.body;

  try {
    const dados = {};
    if (nome !== undefined)               dados.nome = nome;
    if (donoWhatsapp !== undefined)        dados.donoWhatsapp = donoWhatsapp;
    if (moeda !== undefined)               dados.moeda = moeda;
    if (taxaEntrega !== undefined)         dados.taxaEntrega = parseFloat(taxaEntrega);
    if (email !== undefined)               dados.email = email ? email.toLowerCase().trim() : null;
    if (senha)                             dados.senhaHash = await bcrypt.hash(senha, 10);
    if (horarioAtendimento !== undefined)  dados.horarioAtendimento = horarioAtendimento ? JSON.stringify(horarioAtendimento) : null;
    // Só admin pode ativar/desativar
    if (ativo !== undefined && req.user.role === "admin") dados.ativo = ativo;

    const restaurante = await prisma.restaurante.update({
      where: { id },
      data: dados,
      select: { id: true, nome: true, slugWhatsapp: true, donoWhatsapp: true, moeda: true, taxaEntrega: true, ativo: true, email: true, horarioAtendimento: true, cardapioPdfUrl: true },
    });

    // Invalida cache para refletir mudanças imediatamente
    const { invalidarCache } = require("../services/tenantService");
    invalidarCache(restaurante.slugWhatsapp);

    res.json({ data: restaurante });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Email já cadastrado" });
    if (err.code === "P2025") return res.status(404).json({ error: "Restaurante não encontrado" });
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/restaurantes/:id/upload-cardapio-pdf
router.post("/restaurantes/:id/upload-cardapio-pdf", uploadDisco.single("pdf"), async (req, res) => {
  const { id } = req.params;

  if (req.user.role === "restaurante" && req.user.restauranteId !== id) {
    return res.status(403).json({ error: "Acesso negado" });
  }

  if (!req.file) {
    return res.status(400).json({ error: "Arquivo PDF não recebido ou formato inválido" });
  }

  const botUrl = process.env.BOT_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  const pdfUrl = `${botUrl}/uploads/cardapio-${id}.pdf`;

  await prisma.restaurante.update({
    where: { id },
    data: { cardapioPdfUrl: pdfUrl },
  });

  res.json({ data: { cardapioPdfUrl: pdfUrl } });
});

// DELETE /admin/restaurantes/:id/upload-cardapio-pdf
router.delete("/restaurantes/:id/upload-cardapio-pdf", async (req, res) => {
  const { id } = req.params;

  if (req.user.role === "restaurante" && req.user.restauranteId !== id) {
    return res.status(403).json({ error: "Acesso negado" });
  }

  const filePath = path.join(UPLOADS_DIR, `cardapio-${id}.pdf`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  await prisma.restaurante.update({
    where: { id },
    data: { cardapioPdfUrl: null },
  });

  res.json({ data: { cardapioPdfUrl: null } });
});

// ══ Criação de Restaurante (somente super admin) ══════════════════════════════

router.post("/restaurantes", async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Acesso restrito ao super admin" });

  const { nome, slugWhatsapp, donoWhatsapp, moeda = "R$", taxaEntrega = 0, email, senha } = req.body;

  if (!nome || !slugWhatsapp || !donoWhatsapp) {
    return res.status(400).json({ error: "nome, slugWhatsapp e donoWhatsapp são obrigatórios" });
  }
  if (!/^\d{10,15}$/.test(slugWhatsapp)) {
    return res.status(400).json({ error: "slugWhatsapp inválido — apenas dígitos com DDI (ex: 5511999999999)" });
  }

  const webhookBaseUrl = process.env.BOT_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;

  try {
    const senhaHash = senha ? await bcrypt.hash(senha, 10) : null;

    const restaurante = await prisma.restaurante.create({
      data: {
        nome,
        slugWhatsapp,
        donoWhatsapp,
        moeda,
        taxaEntrega: parseFloat(taxaEntrega),
        email: email ? email.toLowerCase().trim() : null,
        senhaHash,
      },
    });

    // Cria instância na Evolution API
    await criarInstancia(restaurante);
    await configurarWebhook(restaurante.slugWhatsapp, webhookBaseUrl);
    const qr = await obterQRCode(restaurante.slugWhatsapp);

    res.status(201).json({
      data: restaurante,
      qrcode: qr,
      webhookUrl: `${webhookBaseUrl}/webhook/${restaurante.slugWhatsapp}`,
    });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "SlugWhatsapp ou email já cadastrado" });
    res.status(500).json({ error: err.message });
  }
});

// ══ Cardápio ══════════════════════════════════════════════════════════════════

// GET /admin/cardapio/:restauranteId
router.get("/cardapio/:restauranteId", async (req, res) => {
  const { restauranteId } = req.params;
  if (req.user.role === "restaurante" && req.user.restauranteId !== restauranteId) {
    return res.status(403).json({ error: "Acesso negado" });
  }
  try {
    const cardapio = await buscarCardapioDB(restauranteId);
    res.json({ data: cardapio });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/cardapio/:restauranteId/categorias
router.post("/cardapio/:restauranteId/categorias", async (req, res) => {
  const { restauranteId } = req.params;
  if (req.user.role === "restaurante" && req.user.restauranteId !== restauranteId) {
    return res.status(403).json({ error: "Acesso negado" });
  }
  const { nome, ordem } = req.body;
  if (!nome) return res.status(400).json({ error: "nome é obrigatório" });
  try {
    const cat = await criarCategoria(restauranteId, nome, ordem);
    invalidarCache(req.body.slug || "");
    res.status(201).json({ data: cat });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/cardapio/categorias/:id
router.patch("/cardapio/categorias/:id", async (req, res) => {
  try {
    const cat = await atualizarCategoria(req.params.id, req.body);
    res.json({ data: cat });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/cardapio/categorias/:id
router.delete("/cardapio/categorias/:id", async (req, res) => {
  try {
    await deletarCategoria(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/cardapio/categorias/:categoriaId/produtos
router.post("/cardapio/categorias/:categoriaId/produtos", async (req, res) => {
  try {
    const produto = await criarProduto(req.params.categoriaId, req.body);
    res.status(201).json({ data: produto });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/cardapio/produtos/:id
router.patch("/cardapio/produtos/:id", async (req, res) => {
  try {
    const produto = await atualizarProduto(req.params.id, req.body);
    res.json({ data: produto });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/cardapio/produtos/:id
router.delete("/cardapio/produtos/:id", async (req, res) => {
  try {
    await deletarProduto(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/cardapio/tamanhos/:id
router.patch("/cardapio/tamanhos/:id", async (req, res) => {
  try {
    const tamanho = await atualizarTamanho(req.params.id, req.body);
    res.json({ data: tamanho });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/cardapio/tamanhos/:id
router.delete("/cardapio/tamanhos/:id", async (req, res) => {
  try {
    await deletarTamanho(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══ Importação de cardápio via PDF ════════════════════════════════════════════

// POST /admin/cardapio/:restauranteId/importar-pdf
// Etapa 1: envia PDF, retorna preview do que a IA interpretou (sem salvar)
router.post("/cardapio/:restauranteId/importar-pdf", upload.single("pdf"), async (req, res) => {
  const { restauranteId } = req.params;
  if (req.user.role === "restaurante" && req.user.restauranteId !== restauranteId) {
    return res.status(403).json({ error: "Acesso negado" });
  }
  if (!req.file) return res.status(400).json({ error: "Nenhum arquivo PDF enviado" });

  try {
    // 1. Extrai texto do PDF
    const parsed = await pdfParse(req.file.buffer);
    const texto = parsed.text?.trim();
    if (!texto || texto.length < 20) {
      return res.status(422).json({ error: "Não foi possível extrair texto do PDF. Verifique se o arquivo não é uma imagem escaneada." });
    }

    // 2. Chama Claude para interpretar o cardápio
    const openRouterClient = axios.create({
      baseURL: "https://openrouter.ai/api/v1",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.BOT_PUBLIC_URL || "https://bot-restaurante.app",
        "X-Title": "Bot Restaurante",
      },
    });

    const prompt = `Você é um especialista em interpretar cardápios de restaurantes. Analise o texto abaixo extraído de um cardápio em PDF e retorne um JSON estruturado.

REGRAS:
- Identifique as categorias (ex: Pizzas, Hambúrgueres, Bebidas, Sobremesas)
- Para cada categoria, liste os produtos com nome, descrição e preço
- Se um produto tiver variações de tamanho (P, M, G, Individual, Mediana, Grande, etc.), use o campo "tamanhos" com nome, preco e precoComBorda (se houver preço com borda/recheio)
- Se não houver tamanhos, use apenas o campo "preco" (número sem símbolos de moeda)
- Remova símbolos de moeda dos preços — retorne apenas números (ex: 29.90 ou 40000)
- Mantenha o idioma original do cardápio
- Se não conseguir identificar o preço, use 0
- Ignore informações não relacionadas ao cardápio (endereço, horários, telefone, etc.)

FORMATO DE RESPOSTA (apenas o JSON, sem markdown, sem explicações):
[
  {
    "nome": "Nome da Categoria",
    "produtos": [
      {
        "nome": "Nome do Produto",
        "descricao": "Descrição ou ingredientes (opcional)",
        "preco": 0,
        "tamanhos": null
      },
      {
        "nome": "Pizza com tamanhos",
        "descricao": "Ingredientes",
        "preco": null,
        "tamanhos": [
          { "nome": "Pequena", "preco": 30000, "precoComBorda": 40000 },
          { "nome": "Grande", "preco": 50000, "precoComBorda": 60000 }
        ]
      }
    ]
  }
]

TEXTO DO CARDÁPIO:
${texto.slice(0, 8000)}`;

    const { data } = await openRouterClient.post("/chat/completions", {
      model: "anthropic/claude-sonnet-4-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const resposta = data.choices[0].message.content.trim();

    // Remove markdown se houver
    const jsonStr = resposta.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    const cardapio = JSON.parse(jsonStr);

    if (!Array.isArray(cardapio) || !cardapio.length) {
      return res.status(422).json({ error: "A IA não conseguiu identificar categorias no cardápio. Verifique o PDF." });
    }

    res.json({ data: cardapio, totalCategorias: cardapio.length, totalProdutos: cardapio.reduce((acc, c) => acc + c.produtos.length, 0) });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(422).json({ error: "A IA retornou um formato inválido. Tente novamente." });
    }
    console.error("[importar-pdf] erro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/cardapio/:restauranteId/confirmar-importacao
// Etapa 2: salva o cardápio interpretado no banco
router.post("/cardapio/:restauranteId/confirmar-importacao", async (req, res) => {
  const { restauranteId } = req.params;
  if (req.user.role === "restaurante" && req.user.restauranteId !== restauranteId) {
    return res.status(403).json({ error: "Acesso negado" });
  }
  const { cardapio, substituir } = req.body;
  if (!Array.isArray(cardapio) || !cardapio.length) {
    return res.status(400).json({ error: "cardapio inválido" });
  }

  try {
    if (substituir) {
      await importarCardapio(restauranteId, cardapio);
    } else {
      // Adiciona às categorias existentes
      for (let i = 0; i < cardapio.length; i++) {
        const cat = cardapio[i];
        const categoria = await require("../services/cardapioService").criarCategoria(restauranteId, cat.nome, 999 + i);
        for (const p of cat.produtos) {
          await require("../services/cardapioService").criarProduto(categoria.id, p);
        }
      }
    }

    // Invalida cache do restaurante
    const rest = await prisma.restaurante.findUnique({ where: { id: restauranteId }, select: { slugWhatsapp: true } });
    if (rest?.slugWhatsapp) invalidarCache(rest.slugWhatsapp);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
