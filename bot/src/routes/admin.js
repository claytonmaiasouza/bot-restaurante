const { Router } = require("express");
const { PrismaClient } = require("@prisma/client");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { confirmarPedido, proximoNumeroDia, formatNumPedido } = require("../services/pedidoService");
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

// Multer: armazena imagem de cardápio em memória
const uploadImagem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    cb(null, allowed.includes(file.mimetype));
  },
});

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

// Multer: salva fotos de cardápio em disco (múltiplas)
const FOTO_EXTS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const uploadDiscoFotos = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = FOTO_EXTS[file.mimetype] || "jpg";
      cb(null, `cardapio-foto-${req.params.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype in FOTO_EXTS),
});

function parseFotos(cardapioPdfUrl) {
  if (!cardapioPdfUrl) return [];
  try {
    const parsed = JSON.parse(cardapioPdfUrl);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

const router = Router();
const prisma = new PrismaClient();

function idCurto(uuid) {
  return uuid.split("-")[0].toUpperCase();
}

const STATUS_VALIDOS = [
  "NOVO", "CONFIRMADO", "PAGO", "PREPARANDO",
  "AGUARDANDO_DESPACHO", "EM_CAMINHO",
  "SAIU_PARA_ENTREGA", "PRONTO_PARA_RETIRADA", "SERVIDO", "ENTREGUE", "CANCELADO",
];

function detectarIdioma(mensagens) {
  const texto = (mensagens || [])
    .filter(m => m.role === "cliente")
    .slice(0, 5)
    .map(m => m.conteudo)
    .join(" ")
    .toLowerCase();
  return /\b(hola|quiero|buenos|gracias|también|necesito|cuanto|cuánto|tengo|puedo|soy|hoy|voy|dónde|cómo)\b/.test(texto) ? "es" : "pt";
}

const NOTIFICACOES_MSGS = {
  pt: {
    CONFIRMADO: (id) => `✅ Seu pedido *#${id}* foi confirmado pelo restaurante! Logo começaremos a preparar. 🍽️`,
    PAGO: (id) => `💳 Pagamento do pedido *#${id}* confirmado! Obrigado! ✅`,
    PREPARANDO: (id) => `👨‍🍳 Seu pedido *#${id}* está sendo preparado com carinho! Em breve ficará pronto. 🍕`,
    SAIU_PARA_ENTREGA: (id) => `🛵 Seu pedido *#${id}* saiu para entrega! Em breve chegará até você. 😊`,
    PRONTO_PARA_RETIRADA: (id) => `🏪 Seu pedido *#${id}* está pronto! Pode vir retirar no balcão. 😊`,
    ENTREGUE: (id) => `✅ Pedido *#${id}* entregue com sucesso! Obrigado pela preferência. 😊`,
    CANCELADO: (id) => `❌ Seu pedido *#${id}* foi cancelado. Entre em contato com o restaurante para mais informações.`,
  },
  es: {
    CONFIRMADO: (id) => `✅ ¡Tu pedido *#${id}* fue confirmado por el restaurante! Pronto comenzaremos a prepararlo. 🍽️`,
    PAGO: (id) => `💳 ¡Pago del pedido *#${id}* confirmado! ¡Gracias! ✅`,
    PREPARANDO: (id) => `👨‍🍳 ¡Tu pedido *#${id}* se está preparando con cariño! Pronto estará listo. 🍕`,
    SAIU_PARA_ENTREGA: (id) => `🛵 ¡Tu pedido *#${id}* salió para entrega! Pronto llegará. 😊`,
    PRONTO_PARA_RETIRADA: (id) => `🏪 ¡Tu pedido *#${id}* está listo! Puedes venir a retirarlo en el mostrador. 😊`,
    ENTREGUE: (id) => `✅ ¡Pedido *#${id}* entregado con éxito! ¡Gracias por tu preferencia! 😊`,
    CANCELADO: (id) => `❌ Tu pedido *#${id}* fue cancelado. Comunícate con el restaurante para más información.`,
  },
};

async function getNotificacao(status, numPedido, sessaoId) {
  let idioma = "pt";
  if (sessaoId) {
    const sessao = await prisma.sessao.findUnique({
      where: { id: sessaoId },
      include: { mensagens: { where: { role: "cliente" }, orderBy: { createdAt: "asc" }, take: 5 } },
    });
    idioma = detectarIdioma(sessao?.mensagens || []);
  }
  return (NOTIFICACOES_MSGS[idioma] || NOTIFICACOES_MSGS.pt)[status]?.(numPedido);
}

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
      select: { id: true, nome: true, slugWhatsapp: true, donoWhatsapp: true, moeda: true, taxaEntrega: true, ativo: true, email: true, horarioAtendimento: true, cardapioPdfUrl: true, dadosTransferencia: true, instrucoes: true },
      orderBy: { nome: "asc" },
    });
    res.json({ data: restaurantes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/pedidos?restauranteId=X&status=NOVO&pagina=1&inicio=&fim= ──────
router.get("/pedidos", async (req, res) => {
  const { status, pagina = 1, inicio, fim, limite: limiteQuery } = req.query;
  const restauranteId = resolverRestauranteId(req);
  const limite = limiteQuery ? Math.min(Number(limiteQuery), 200) : 50;
  const offset = (Number(pagina) - 1) * limite;

  const where = {};
  if (restauranteId) where.restauranteId = restauranteId;
  if (status && status !== "Todos") {
    if (status === "PAGO") {
      where.pago = true;
    } else if (status === "CONFIRMADO") {
      where.status = { notIn: ["NOVO", "CANCELADO"] };
    } else {
      where.status = status;
    }
  }
  if (inicio || fim) {
    where.createdAt = {};
    if (inicio) where.createdAt.gte = new Date(inicio);
    if (fim) where.createdAt.lte = new Date(fim + "T23:59:59.999Z");
  }

  try {
    const [pedidos, total] = await prisma.$transaction([
      prisma.pedido.findMany({
        where,
        orderBy: { createdAt: "asc" },
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
    // Maquininha de cartão e mesa: ao marcar ENTREGUE, confirma pagamento automaticamente
    const isMaquininha = (mp) => mp && mp.toLowerCase().includes("cartão");
    const extraData = {};
    if (status === "ENTREGUE") {
      const atual = await prisma.pedido.findUnique({ where: { id }, select: { metodoPagamento: true, pago: true, origem: true } });
      if (atual && !atual.pago && (isMaquininha(atual.metodoPagamento) || atual.origem === "MESA")) {
        extraData.pago = true;
      }
    }

    const pedido = await prisma.pedido.update({
      where: { id },
      data: { status, ...extraData },
      include: { restaurante: { select: { nome: true, slugWhatsapp: true, moeda: true, taxaEntrega: true } } },
    });

    // Notifica o cliente via WhatsApp (bilíngue: detecta idioma da sessão)
    const mensagem = await getNotificacao(status, formatNumPedido(pedido), pedido.sessaoId);
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

    // Marca como pago sem regredir o status — só avança para PAGO se ainda não chegou lá
    const statusAntesDePago = ["NOVO", "CONFIRMADO"];
    const novoStatus = statusAntesDePago.includes(atual.status) ? "PAGO" : atual.status;

    const pedido = await prisma.pedido.update({
      where: { id },
      data: { pago: true, status: novoStatus },
      include: { restaurante: { select: { nome: true, slugWhatsapp: true, moeda: true, taxaEntrega: true } } },
    });

    if (novoStatus === "PAGO") {
      const mensagem = await getNotificacao("PAGO", formatNumPedido(pedido), pedido.sessaoId);
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

// ══ Motoboys ══════════════════════════════════════════════════════════════════

router.get("/motoboys", async (req, res) => {
  try {
    const restauranteId = resolverRestauranteId(req);
    if (!restauranteId) return res.status(400).json({ error: "restauranteId obrigatório" });
    const motoboys = await prisma.motoboy.findMany({
      where: { restauranteId },
      orderBy: { nome: "asc" },
    });
    res.json({ data: motoboys });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const normalizarTelefone = (t) => t ? t.replace(/\D/g, "") : t;

router.post("/motoboys", async (req, res) => {
  try {
    const restauranteId = resolverRestauranteId(req);
    if (!restauranteId) return res.status(400).json({ error: "restauranteId obrigatório" });
    const { nome, telefone, cedula, placa, senha } = req.body;
    if (!nome || !telefone) return res.status(400).json({ error: "nome e telefone são obrigatórios" });
    const data = { nome, telefone: normalizarTelefone(telefone), restauranteId };
    if (cedula) data.cedula = cedula.trim();
    if (placa) data.placa = placa.trim().toUpperCase();
    if (senha) data.senhaHash = await bcrypt.hash(senha, 10);
    const motoboy = await prisma.motoboy.create({ data });
    res.json({ data: motoboy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/motoboys/:id", async (req, res) => {
  const { id } = req.params;
  const { nome, telefone, ativo, cedula, placa, senha } = req.body;
  const data = {};
  if (nome !== undefined) data.nome = nome;
  if (telefone !== undefined) data.telefone = normalizarTelefone(telefone);
  if (ativo !== undefined) data.ativo = ativo;
  if (cedula !== undefined) data.cedula = cedula?.trim() || null;
  if (placa !== undefined) data.placa = placa?.trim().toUpperCase() || null;
  if (senha) data.senhaHash = await bcrypt.hash(senha, 10);
  try {
    const motoboy = await prisma.motoboy.update({ where: { id }, data });
    res.json({ data: motoboy });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Motoboy não encontrado" });
    res.status(500).json({ error: err.message });
  }
});

router.delete("/motoboys/:id", async (req, res) => {
  try {
    await prisma.motoboy.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Motoboy não encontrado" });
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/pedidos/:id/despachar — envia pedido para motoboy via WhatsApp
router.post("/pedidos/:id/despachar", async (req, res) => {
  const { id } = req.params;
  const { motoboyId } = req.body;
  if (!motoboyId) return res.status(400).json({ error: "motoboyId obrigatório" });

  try {
    const [pedido, motoboy] = await Promise.all([
      prisma.pedido.findUnique({
        where: { id },
        include: { restaurante: true },
      }),
      prisma.motoboy.findUnique({ where: { id: motoboyId } }),
    ]);

    if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });
    if (!motoboy) return res.status(404).json({ error: "Motoboy não encontrado" });

    const moeda = pedido.restaurante.moeda || "R$";
    const temDecimal = ["R$", "$", "€"].includes(moeda);
    const fmt = (v) => temDecimal ? `${moeda} ${v.toFixed(2)}` : `${moeda} ${Math.round(v).toLocaleString()}`;

    const itens = Array.isArray(pedido.itens) ? pedido.itens : [];
    const itensTexto = itens.map(i => `• ${i.quantidade || 1}x ${i.nome} — ${fmt(i.preco * (i.quantidade || 1))}`).join("\n");

    const pagamento = pedido.metodoPagamento ? `\n💳 *Pagamento:* ${pedido.metodoPagamento}` : "";

    const mensagem =
      `🛵 *ENTREGA #${formatNumPedido(pedido)}*\n\n` +
      `👤 *Cliente:* ${pedido.clienteNome || "Não identificado"}\n` +
      `📱 *WhatsApp:* ${pedido.clienteNumero}\n\n` +
      `🛒 *Itens:*\n${itensTexto}\n\n` +
      `💰 *Total: ${fmt(pedido.total)}*${pagamento}\n\n` +
      `📍 *Endereço:*\n${pedido.localizacao || "Não informado"}`;

    // Salva o motoboy no pedido independentemente do sucesso da mensagem WA
    await prisma.pedido.update({
      where: { id },
      data: { motoboyId: motoboy.id, motoboyNome: motoboy.nome },
    });

    let avisoWa = null;
    try {
      await enviarMensagem(motoboy.telefone, mensagem, pedido.restaurante.slugWhatsapp);
    } catch (errWa) {
      console.error("[despachar] falha ao notificar motoboy via WA:", errWa.response?.data || errWa.message);
      avisoWa = "Motoboy atribuído, mas a mensagem WhatsApp não foi enviada.";
    }

    res.json({ ok: true, motoboy: motoboy.nome, aviso: avisoWa });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/motoboys/despachos?restauranteId=xxx — estatísticas de despachos por motoboy
router.get("/motoboys/despachos", async (req, res) => {
  const rid = resolverRestauranteId(req);
  if (!rid) return res.status(400).json({ error: "restauranteId obrigatório" });

  try {
    const agora = new Date();
    const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
    const inicioHoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());

    const [total, mes, hoje] = await Promise.all([
      prisma.pedido.groupBy({
        by: ["motoboyId", "motoboyNome"],
        where: { restauranteId: rid, motoboyId: { not: null } },
        _count: { id: true },
        _max: { createdAt: true },
      }),
      prisma.pedido.groupBy({
        by: ["motoboyId"],
        where: { restauranteId: rid, motoboyId: { not: null }, createdAt: { gte: inicioMes } },
        _count: { id: true },
      }),
      prisma.pedido.groupBy({
        by: ["motoboyId"],
        where: { restauranteId: rid, motoboyId: { not: null }, createdAt: { gte: inicioHoje } },
        _count: { id: true },
      }),
    ]);

    const mesPorId = Object.fromEntries(mes.map(x => [x.motoboyId, x._count.id]));
    const hojePorId = Object.fromEntries(hoje.map(x => [x.motoboyId, x._count.id]));

    const data = total
      .map(item => ({
        motoboyId: item.motoboyId,
        motoboyNome: item.motoboyNome || "Desconhecido",
        total: item._count.id,
        mes: mesPorId[item.motoboyId] || 0,
        hoje: hojePorId[item.motoboyId] || 0,
        ultimoDespacho: item._max.createdAt,
      }))
      .sort((a, b) => b.total - a.total);

    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/motoboys/:id/historico?restauranteId=xxx&page=1&limit=20
router.get("/motoboys/:id/historico", async (req, res) => {
  const rid = resolverRestauranteId(req);
  if (!rid) return res.status(400).json({ error: "restauranteId obrigatório" });

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const skip = (page - 1) * limit;

  try {
    const where = { restauranteId: rid, motoboyId: req.params.id };
    const [total, pedidos] = await Promise.all([
      prisma.pedido.count({ where }),
      prisma.pedido.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          numeroDia: true,
          clienteNome: true,
          clienteNumero: true,
          localizacao: true,
          total: true,
          status: true,
          metodoPagamento: true,
          createdAt: true,
        },
      }),
    ]);

    res.json({ data: pedidos, total, page, pages: Math.ceil(total / limit) });
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

// ── GET /admin/stats?restauranteId=X ─────────────────────────────────────────
router.get("/stats", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  const where = {};
  if (restauranteId) where.restauranteId = restauranteId;

  const inicioDia = new Date();
  inicioDia.setHours(0, 0, 0, 0);
  const fimDia = new Date();
  fimDia.setHours(23, 59, 59, 999);
  const whereHoje = { ...where, createdAt: { gte: inicioDia, lte: fimDia } };
  const whereAberto = { ...where, status: { notIn: ["ENTREGUE", "CANCELADO"] } };
  const wherePago = { ...where, pago: true };
  const wherePagoHoje = { ...where, pago: true, createdAt: { gte: inicioDia, lte: fimDia } };

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

// ── GET /admin/metricas?restauranteId=X&inicio=YYYY-MM-DD&fim=YYYY-MM-DD&utcOffset=N ──
router.get("/metricas", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  const { inicio, fim } = req.query;
  const utcOffset = parseFloat(req.query.utcOffset) || 0; // hours, e.g. -3 for UTC-3

  const dataFim = fim ? new Date(fim + "T23:59:59.999Z") : new Date();
  const dataInicio = inicio
    ? new Date(inicio + "T00:00:00.000Z")
    : new Date(dataFim.getTime() - 29 * 24 * 60 * 60 * 1000);
  dataInicio.setUTCHours(0, 0, 0, 0);

  const where = { createdAt: { gte: dataInicio, lte: dataFim } };
  if (restauranteId) where.restauranteId = restauranteId;
  const whereNaoCancelado = { ...where, status: { not: "CANCELADO" } };

  try {
    const [pedidos, pedidosCancelados] = await prisma.$transaction([
      prisma.pedido.findMany({
        where: whereNaoCancelado,
        select: { id: true, total: true, createdAt: true, itens: true, localizacao: true, status: true, clienteNumero: true, origem: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.pedido.count({ where: { ...where, status: "CANCELADO" } }),
    ]);

    // KPIs
    const totalPedidos = pedidos.length;
    const totalFaturamento = pedidos.reduce((s, p) => s + (p.total || 0), 0);
    const ticketMedio = totalPedidos ? totalFaturamento / totalPedidos : 0;
    const clientesUnicos = new Set(pedidos.map((p) => p.clienteNumero)).size;

    // Pedidos + faturamento por dia (agrupa por data local do cliente)
    const porDiaMap = {};
    pedidos.forEach((p) => {
      const localMs = new Date(p.createdAt).getTime() + utcOffset * 3600000;
      const dia = new Date(localMs).toISOString().slice(0, 10);
      if (!porDiaMap[dia]) porDiaMap[dia] = { count: 0, revenue: 0 };
      porDiaMap[dia].count++;
      porDiaMap[dia].revenue += p.total || 0;
    });
    const porDia = [];
    // itera por datas locais dentro do intervalo
    const curLocal = new Date(dataInicio.getTime() + utcOffset * 3600000);
    curLocal.setUTCHours(0, 0, 0, 0);
    const fimLocal = new Date(dataFim.getTime() + utcOffset * 3600000);
    while (curLocal <= fimLocal) {
      const d = curLocal.toISOString().slice(0, 10);
      porDia.push({ data: d, pedidos: porDiaMap[d]?.count || 0, faturamento: porDiaMap[d]?.revenue || 0 });
      curLocal.setUTCDate(curLocal.getUTCDate() + 1);
    }

    // Por hora do dia (ajustado ao timezone do cliente)
    const porHora = Array.from({ length: 24 }, (_, h) => ({ hora: h, count: 0 }));
    pedidos.forEach((p) => {
      const localHour = (new Date(p.createdAt).getUTCHours() + utcOffset + 24) % 24;
      porHora[Math.floor(localHour)].count++;
    });

    // Por dia da semana (0=Dom … 6=Sáb), ajustado ao timezone do cliente
    const porDiaSemana = Array.from({ length: 7 }, (_, d) => ({ dia: d, count: 0 }));
    pedidos.forEach((p) => {
      const d = new Date(p.createdAt);
      const localMs = d.getTime() + utcOffset * 3600000;
      const localDay = new Date(localMs).getUTCDay();
      porDiaSemana[localDay].count++;
    });

    // Ranking de itens
    const itensMap = {};
    pedidos.forEach((p) => {
      const itens = Array.isArray(p.itens) ? p.itens : [];
      itens.forEach((item) => {
        const nome = item.nome || "?";
        const qtd = item.quantidade || 1;
        if (!itensMap[nome]) itensMap[nome] = { nome, quantidade: 0, revenue: 0 };
        itensMap[nome].quantidade += qtd;
        itensMap[nome].revenue += (item.preco || 0) * qtd;
      });
    });
    const itensSorted = Object.values(itensMap).sort((a, b) => b.quantidade - a.quantidade);
    const topItens = itensSorted.slice(0, 10);
    const bottomItens = [...itensSorted].sort((a, b) => a.quantidade - b.quantidade).slice(0, 5);

    // Canal de pedidos: Salão (MESA) | Delivery | Retirada
    const salao    = pedidos.filter((p) => p.origem === "MESA").length;
    const delivery = pedidos.filter((p) => p.origem !== "MESA" && p.localizacao !== null).length;
    const retirada = pedidos.filter((p) => p.origem !== "MESA" && p.localizacao === null).length;

    // Funil de status
    const statusCount = {};
    pedidos.forEach((p) => { statusCount[p.status] = (statusCount[p.status] || 0) + 1; });

    res.json({
      data: {
        periodo: { inicio: dataInicio.toISOString().slice(0, 10), fim: dataFim.toISOString().slice(0, 10) },
        kpis: { totalPedidos, totalFaturamento, ticketMedio, clientesUnicos, pedidosCancelados },
        porDia,
        porHora,
        porDiaSemana,
        topItens,
        bottomItens,
        entrega: { delivery, retirada, salao },
        statusCount,
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
  where.clienteNumero = { not: { startsWith: "mesa-" } };

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

router.delete("/conversas/:id", async (req, res) => {
  const io = req.app.get("io");
  try {
    const sessao = await prisma.sessao.findUnique({
      where: { id: req.params.id },
      include: { restaurante: true },
    });
    if (!sessao) return res.status(404).json({ error: "Sessão não encontrada" });

    const despedida = "Olá! 👋 Esta conversa foi encerrada pelo nosso atendimento. Caso precise de mais alguma coisa, é só nos chamar. Obrigado! 😊";
    await enviarMensagem(sessao.clienteNumero, despedida, sessao.restaurante.slugWhatsapp);
    await prisma.mensagem.create({
      data: { sessaoId: sessao.id, role: "bot", conteudo: `[admin] ${despedida}` },
    });

    await prisma.sessao.update({
      where: { id: req.params.id },
      data: { estado: "FINALIZADO" },
    });

    io?.to("admin").emit("conversa:encerrada", { sessaoId: req.params.id });
    res.json({ ok: true });
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
  const restauranteId = resolverRestauranteId(req);
  const limite = 50;
  const offset = (Number(pagina) - 1) * limite;

  try {
    const where = {};
    if (restauranteId) where.restauranteId = restauranteId;
    if (busca) {
      where.OR = [
        { nome: { contains: busca, mode: "insensitive" } },
        { numero: { contains: busca } },
      ];
    }

    const [clientes, total] = await prisma.$transaction([
      prisma.clienteFidelidade.findMany({ where, orderBy: { ultimoPedido: "desc" }, skip: offset, take: limite }),
      prisma.clienteFidelidade.count({ where }),
    ]);

    res.json({ data: clientes, meta: { total, pagina: Number(pagina), limite, paginas: Math.ceil(total / limite) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /admin/clientes/:id ─────────────────────────────────────────────────
router.patch("/clientes/:id", async (req, res) => {
  const { nome, numero, totalPedidos } = req.body;
  try {
    const data = {};
    if (nome !== undefined) data.nome = nome || null;
    if (numero !== undefined) data.numero = numero;
    if (totalPedidos !== undefined) data.totalPedidos = Number(totalPedidos);
    const cliente = await prisma.clienteFidelidade.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ data: cliente });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Cliente não encontrado" });
    if (err.code === "P2002") return res.status(409).json({ error: "Número já cadastrado para outro cliente" });
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /admin/clientes/:id ────────────────────────────────────────────────
router.delete("/clientes/:id", async (req, res) => {
  try {
    await prisma.clienteFidelidade.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
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

    const clientesDoRestaurante = await prisma.clienteFidelidade.findMany({ where: { restauranteId: rid } });

    if (filtro && filtro !== "todos") {
      const programa = await prisma.programaFidelidade.findUnique({ where: { id: filtro } });
      if (!programa) return res.status(404).json({ error: "Programa não encontrado" });
      numeros = clientesDoRestaurante.filter((c) => clienteQualificado(c, programa)).map((c) => c.numero);
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
function clienteQualificado(cliente, programa) {
  const resgatesFeitos = cliente.resgates || 0;
  const progresso = programa.tipo === "PEDIDOS" ? (cliente.totalPedidos || 0) : (cliente.totalGasto || 0);
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

    const clientes = await prisma.clienteFidelidade.findMany({ where: { restauranteId: programa.restauranteId } });
    const qualificados = clientes
      .filter((c) => clienteQualificado(c, programa))
      .map((c) => ({
        id: c.id,
        nome: c.nome,
        numero: c.numero,
        pedidos: c.totalPedidos,
        gasto: c.totalGasto,
        resgates: c.resgates,
      }));

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

    const cliente = await prisma.clienteFidelidade.findUnique({
      where: { numero_restauranteId: { numero: clienteNumero, restauranteId: programa.restauranteId } },
    });
    if (!cliente) return res.status(400).json({ error: "Cliente sem histórico neste restaurante" });

    if (!clienteQualificado(cliente, programa)) {
      return res.status(400).json({ error: "Cliente não qualificado para resgate" });
    }

    const registradoPor = req.user.role === "admin" ? "super-admin" : (req.user.email || req.user.restauranteId || "restaurante");

    await prisma.$transaction([
      prisma.clienteFidelidade.update({
        where: { numero_restauranteId: { numero: clienteNumero, restauranteId: programa.restauranteId } },
        data: { resgates: { increment: 1 } },
      }),
      prisma.resgateFidelidade.create({
        data: {
          programaId: programa.id,
          clienteNumero,
          clienteNome: cliente.nome || null,
          registradoPor,
        },
      }),
    ]);

    res.json({ ok: true, resgatesTotal: cliente.resgates + 1 });
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

  const { nome, donoWhatsapp, moeda, taxaEntrega, email, senha, ativo, horarioAtendimento, dadosTransferencia, instrucoes } = req.body;

  try {
    const dados = {};
    if (nome !== undefined)               dados.nome = nome;
    if (donoWhatsapp !== undefined)        dados.donoWhatsapp = donoWhatsapp;
    if (moeda !== undefined)               dados.moeda = moeda;
    if (taxaEntrega !== undefined)         dados.taxaEntrega = parseFloat(taxaEntrega);
    if (email !== undefined)               dados.email = email ? email.toLowerCase().trim() : null;
    if (senha)                             dados.senhaHash = await bcrypt.hash(senha, 10);
    if (horarioAtendimento !== undefined)  dados.horarioAtendimento = horarioAtendimento ? JSON.stringify(horarioAtendimento) : null;
    if (dadosTransferencia !== undefined)  dados.dadosTransferencia = dadosTransferencia || null;
    if (instrucoes !== undefined)          dados.instrucoes = instrucoes || null;
    // Só admin pode ativar/desativar
    if (ativo !== undefined && req.user.role === "admin") dados.ativo = ativo;

    const restaurante = await prisma.restaurante.update({
      where: { id },
      data: dados,
      select: { id: true, nome: true, slugWhatsapp: true, donoWhatsapp: true, moeda: true, taxaEntrega: true, ativo: true, email: true, horarioAtendimento: true, cardapioPdfUrl: true, dadosTransferencia: true, instrucoes: true },
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

// POST /admin/restaurantes/:id/upload-cardapio-fotos — adiciona fotos ao array
router.post("/restaurantes/:id/upload-cardapio-fotos", uploadDiscoFotos.array("fotos", 10), async (req, res) => {
  const { id } = req.params;

  if (req.user.role === "restaurante" && req.user.restauranteId !== id) {
    return res.status(403).json({ error: "Acesso negado" });
  }
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Nenhuma imagem recebida (aceito: JPG, PNG, WebP, máx 10)" });
  }

  // Remove PDF anterior se existir
  const pdfPath = path.join(UPLOADS_DIR, `cardapio-${id}.pdf`);
  if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);

  const restaurante = await prisma.restaurante.findUnique({ where: { id }, select: { cardapioPdfUrl: true } });
  const fotos = parseFotos(restaurante.cardapioPdfUrl);

  const botUrl = process.env.BOT_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  for (const file of req.files) {
    fotos.push(`${botUrl}/uploads/${file.filename}`);
  }

  await prisma.restaurante.update({ where: { id }, data: { cardapioPdfUrl: JSON.stringify(fotos) } });
  res.json({ data: { fotos } });
});

// DELETE /admin/restaurantes/:id/upload-cardapio-fotos/:filename — remove uma foto do array
router.delete("/restaurantes/:id/upload-cardapio-fotos/:filename", async (req, res) => {
  const { id, filename } = req.params;

  if (req.user.role === "restaurante" && req.user.restauranteId !== id) {
    return res.status(403).json({ error: "Acesso negado" });
  }

  const restaurante = await prisma.restaurante.findUnique({ where: { id }, select: { cardapioPdfUrl: true } });
  const fotos = parseFotos(restaurante.cardapioPdfUrl).filter(url => !url.endsWith(`/${filename}`));

  const filePath = path.join(UPLOADS_DIR, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  const newValue = fotos.length > 0 ? JSON.stringify(fotos) : null;
  await prisma.restaurante.update({ where: { id }, data: { cardapioPdfUrl: newValue } });
  res.json({ data: { fotos } });
});

// DELETE /admin/restaurantes/:id/upload-cardapio-pdf — remove PDF ou todas as fotos
router.delete("/restaurantes/:id/upload-cardapio-pdf", async (req, res) => {
  const { id } = req.params;

  if (req.user.role === "restaurante" && req.user.restauranteId !== id) {
    return res.status(403).json({ error: "Acesso negado" });
  }

  const restaurante = await prisma.restaurante.findUnique({ where: { id }, select: { cardapioPdfUrl: true } });

  // Remove PDF
  const pdfPath = path.join(UPLOADS_DIR, `cardapio-${id}.pdf`);
  if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);

  // Remove todas as fotos do array (se houver)
  for (const url of parseFotos(restaurante.cardapioPdfUrl)) {
    const filename = url.split("/uploads/")[1];
    if (filename) {
      const fotoPath = path.join(UPLOADS_DIR, filename);
      if (fs.existsSync(fotoPath)) fs.unlinkSync(fotoPath);
    }
  }

  await prisma.restaurante.update({ where: { id }, data: { cardapioPdfUrl: null } });
  res.json({ data: { cardapioPdfUrl: null } });
});

// ══ Criação / Exclusão de Restaurante (somente super admin) ══════════════════

// DELETE /admin/restaurantes/:id — remove restaurante e todos os dados relacionados
router.delete("/restaurantes/:id", async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Acesso restrito ao super admin" });

  const { id } = req.params;
  try {
    // Cascade manual: Prisma só faz cascade se configurado no schema.
    // A ordem importa para evitar violações de FK.
    await prisma.$transaction([
      prisma.mensagem.deleteMany({ where: { sessao: { restauranteId: id } } }),
      prisma.resgateFidelidade.deleteMany({ where: { programa: { restauranteId: id } } }),
      prisma.programaFidelidade.deleteMany({ where: { restauranteId: id } }),
      prisma.pedido.deleteMany({ where: { restauranteId: id } }),
      prisma.sessao.deleteMany({ where: { restauranteId: id } }),
      prisma.tamanho.deleteMany({ where: { produto: { categoria: { restauranteId: id } } } }),
      prisma.produto.deleteMany({ where: { categoria: { restauranteId: id } } }),
      prisma.categoria.deleteMany({ where: { restauranteId: id } }),
      prisma.motoboy.deleteMany({ where: { restauranteId: id } }),
      prisma.restaurante.delete({ where: { id } }),
    ]);

    res.json({ ok: true });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ error: "Restaurante não encontrado" });
    res.status(500).json({ error: err.message });
  }
});

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
    const instancia = await criarInstancia(restaurante);
    await configurarWebhook(restaurante.slugWhatsapp, webhookBaseUrl);

    // Tenta usar QR da própria resposta de criação; se não, aguarda e busca
    let qr = instancia?._qrcode?.base64 ? instancia._qrcode : null;
    if (!qr?.base64) {
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        qr = await obterQRCode(restaurante.slugWhatsapp);
        if (qr?.base64) break;
      }
    }

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
    const [cardapio, rest] = await Promise.all([
      buscarCardapioDB(restauranteId),
      prisma.restaurante.findUnique({ where: { id: restauranteId }, select: { instrucoes: true } }),
    ]);
    res.json({ data: cardapio, instrucoes: rest?.instrucoes || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: invalida o cache do bot pelo restauranteId (busca o slug no banco)
async function invalidarCachePorRestauranteId(restauranteId) {
  const r = await prisma.restaurante.findUnique({ where: { id: restauranteId }, select: { slugWhatsapp: true } });
  if (r?.slugWhatsapp) invalidarCache(r.slugWhatsapp);
}

// Helper: invalida cache pelo categoriaId (faz join para chegar ao restaurante)
async function invalidarCachePorCategoriaId(categoriaId) {
  const cat = await prisma.categoria.findUnique({ where: { id: categoriaId }, select: { restauranteId: true } });
  if (cat) await invalidarCachePorRestauranteId(cat.restauranteId);
}

// Helper: invalida cache pelo produtoId
async function invalidarCachePorProdutoId(produtoId) {
  const prod = await prisma.produto.findUnique({
    where: { id: produtoId },
    select: { categoria: { select: { restauranteId: true } } },
  });
  if (prod?.categoria) await invalidarCachePorRestauranteId(prod.categoria.restauranteId);
}

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
    await invalidarCachePorRestauranteId(restauranteId);
    res.status(201).json({ data: cat });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/cardapio/categorias/:id
router.patch("/cardapio/categorias/:id", async (req, res) => {
  try {
    const cat = await atualizarCategoria(req.params.id, req.body);
    await invalidarCachePorCategoriaId(req.params.id);
    res.json({ data: cat });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/cardapio/categorias/:id
router.delete("/cardapio/categorias/:id", async (req, res) => {
  try {
    await invalidarCachePorCategoriaId(req.params.id);
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
    await invalidarCachePorCategoriaId(req.params.categoriaId);
    res.status(201).json({ data: produto });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/cardapio/produtos/:id
router.patch("/cardapio/produtos/:id", async (req, res) => {
  try {
    const produto = await atualizarProduto(req.params.id, req.body);
    await invalidarCachePorProdutoId(req.params.id);
    res.json({ data: produto });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/cardapio/produtos/:id
router.delete("/cardapio/produtos/:id", async (req, res) => {
  try {
    await invalidarCachePorProdutoId(req.params.id);
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

// POST /admin/cardapio/:restauranteId/importar-imagem
// Etapa 1 (foto): envia imagem, Claude Vision interpreta, retorna preview
router.post("/cardapio/:restauranteId/importar-imagem", uploadImagem.single("imagem"), async (req, res) => {
  const { restauranteId } = req.params;
  if (req.user.role === "restaurante" && req.user.restauranteId !== restauranteId) {
    return res.status(403).json({ error: "Acesso negado" });
  }
  if (!req.file) return res.status(400).json({ error: "Imagem não recebida ou formato inválido (use JPG, PNG, WEBP ou GIF)" });

  try {
    const base64 = req.file.buffer.toString("base64");
    const mediaType = req.file.mimetype;

    const openRouterClient = axios.create({
      baseURL: "https://openrouter.ai/api/v1",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.BOT_PUBLIC_URL || "https://bot-restaurante.app",
        "X-Title": "Bot Restaurante",
      },
    });

    const prompt = `Analise esta foto de cardápio de restaurante e retorne um JSON estruturado com as categorias e produtos visíveis.\n\nREGRAS:\n- Identifique as categorias (ex: Pizzas, Hambúrgueres, Bebidas, Sobremesas)\n- Para cada categoria, liste os produtos com nome, descrição e preço\n- Se um produto tiver variações de tamanho (P, M, G, Individual, Mediana, Grande, etc.), use o campo "tamanhos" com nome, preco e precoComBorda (se houver)\n- Se não houver tamanhos, use apenas o campo "preco" (número sem símbolos de moeda)\n- Remova símbolos de moeda dos preços — retorne apenas números (ex: 29.90 ou 40000)\n- Mantenha o idioma original do cardápio\n- Se não conseguir identificar o preço, use 0\n- Ignore informações não relacionadas ao cardápio (endereço, horários, telefone, etc.)\n\nFORMATO DE RESPOSTA (apenas o JSON, sem markdown, sem explicações):\n[\n  {\n    "nome": "Nome da Categoria",\n    "produtos": [\n      {\n        "nome": "Nome do Produto",\n        "descricao": "Descrição ou ingredientes (opcional)",\n        "preco": 0,\n        "tamanhos": null\n      }\n    ]\n  }\n]`;

    const { data } = await openRouterClient.post("/chat/completions", {
      model: "anthropic/claude-sonnet-4-5",
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64}` } },
          { type: "text", text: prompt },
        ],
      }],
    });

    const resposta = data.choices[0].message.content.trim();
    const jsonStr = resposta.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    const cardapio = JSON.parse(jsonStr);

    if (!Array.isArray(cardapio) || !cardapio.length) {
      return res.status(422).json({ error: "A IA não conseguiu identificar categorias na imagem. Tente uma foto mais clara." });
    }

    res.json({ data: cardapio, totalCategorias: cardapio.length, totalProdutos: cardapio.reduce((acc, c) => acc + c.produtos.length, 0) });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(422).json({ error: "A IA retornou um formato inválido. Tente novamente com uma foto mais clara." });
    }
    console.error("[importar-imagem] erro:", err.message);
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

// ══ CRM ═══════════════════════════════════════════════════════════════════════

function calcularSegmentos(clientes, programas) {
  const agora = Date.now();
  const dias30 = new Date(agora - 30 * 86400000);
  const dias60 = new Date(agora - 60 * 86400000);

  const sorted = [...clientes].sort((a, b) => b.totalGasto - a.totalGasto);
  const vipIdx = Math.max(0, Math.floor(sorted.length * 0.2) - 1);
  const vipThreshold = sorted[vipIdx]?.totalGasto || 0;

  const pertenceSegmento = (c, seg) => {
    if (seg === 'todos') return true;
    if (seg === 'novos') return c.totalPedidos === 1;
    if (seg === 'recorrentes') return c.totalPedidos >= 3;
    if (seg === 'vip') return vipThreshold > 0 && c.totalGasto >= vipThreshold;
    if (seg === 'emRisco') return c.ultimoPedido && new Date(c.ultimoPedido) < dias30 && new Date(c.ultimoPedido) >= dias60;
    if (seg === 'inativos') return c.ultimoPedido && new Date(c.ultimoPedido) < dias60;
    if (seg === 'fidelidade') return programas.some(p => {
      const prog = p.tipo === 'PEDIDOS' ? c.totalPedidos : c.totalGasto;
      return Math.floor(prog / p.meta) > (c.resgates || 0);
    });
    return true;
  };

  return { pertenceSegmento, vipThreshold };
}

// ── GET /admin/crm/segmentos?restauranteId=X ─────────────────────────────────
router.get("/crm/segmentos", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  if (!restauranteId) return res.status(400).json({ error: "restauranteId obrigatório" });

  try {
    const [clientes, programas] = await Promise.all([
      prisma.clienteFidelidade.findMany({
        where: { restauranteId },
        select: { totalPedidos: true, totalGasto: true, resgates: true, ultimoPedido: true },
      }),
      prisma.programaFidelidade.findMany({ where: { restauranteId, ativo: true } }),
    ]);

    const { pertenceSegmento } = calcularSegmentos(clientes, programas);
    const segs = ['todos', 'novos', 'recorrentes', 'vip', 'emRisco', 'inativos', 'fidelidade'];
    const counts = {};
    segs.forEach(s => { counts[s] = clientes.filter(c => pertenceSegmento(c, s)).length; });

    res.json({ data: counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/crm/clientes?restauranteId=X&segmento=todos&busca=&pagina=1 ───
router.get("/crm/clientes", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  const { segmento = 'todos', busca, pagina = 1 } = req.query;
  const limite = 50;
  if (!restauranteId) return res.status(400).json({ error: "restauranteId obrigatório" });

  try {
    const [todos, programas] = await Promise.all([
      prisma.clienteFidelidade.findMany({ where: { restauranteId }, orderBy: { totalGasto: "desc" } }),
      prisma.programaFidelidade.findMany({ where: { restauranteId, ativo: true } }),
    ]);

    const { pertenceSegmento, vipThreshold } = calcularSegmentos(todos, programas);

    let filtrados = todos.filter(c => pertenceSegmento(c, segmento));
    if (busca) {
      const b = busca.toLowerCase();
      filtrados = filtrados.filter(c => (c.nome || '').toLowerCase().includes(b) || c.numero.includes(busca));
    }

    const total = filtrados.length;
    const paginated = filtrados.slice((Number(pagina) - 1) * limite, Number(pagina) * limite);

    res.json({ data: paginated, meta: { total, pagina: Number(pagina), paginas: Math.ceil(total / limite) || 1 }, vipThreshold });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/crm/cliente/:numero?restauranteId=X ───────────────────────────
router.get("/crm/cliente/:numero", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  if (!restauranteId) return res.status(400).json({ error: "restauranteId obrigatório" });

  try {
    const [cliente, pedidos] = await Promise.all([
      prisma.clienteFidelidade.findUnique({
        where: { numero_restauranteId: { numero: req.params.numero, restauranteId } },
      }),
      prisma.pedido.findMany({
        where: { clienteNumero: req.params.numero, restauranteId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, total: true, status: true, createdAt: true, itens: true, localizacao: true, metodoPagamento: true },
      }),
    ]);

    if (!cliente) return res.status(404).json({ error: "Cliente não encontrado" });
    res.json({ data: { ...cliente, pedidos } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/crm/campanha ──────────────────────────────────────────────────
router.post("/crm/campanha", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  const { titulo, mensagem, segmento, destinatarios } = req.body;
  if (!restauranteId || !mensagem?.trim() || !destinatarios?.length) {
    return res.status(400).json({ error: "mensagem e destinatarios são obrigatórios" });
  }

  try {
    const restaurante = await prisma.restaurante.findUnique({
      where: { id: restauranteId },
      select: { slugWhatsapp: true, nome: true },
    });
    if (!restaurante) return res.status(404).json({ error: "Restaurante não encontrado" });

    let enviados = 0;
    let erros = 0;

    for (const { numero, nome } of destinatarios) {
      const msg = mensagem
        .replace(/\{\{nome\}\}/gi, nome || 'cliente')
        .replace(/\{\{restaurante\}\}/gi, restaurante.nome);
      try {
        await enviarMensagem(numero, msg, restaurante.slugWhatsapp);
        enviados++;
        await new Promise(r => setTimeout(r, 800));
      } catch {
        erros++;
      }
    }

    await prisma.campanhaMarketing.create({
      data: {
        restauranteId,
        titulo: titulo?.trim() || `Campanha ${new Date().toLocaleDateString('pt-BR')}`,
        mensagem,
        segmento: segmento || 'custom',
        totalEnviados: enviados,
        totalErros: erros,
        criadoPor: req.user?.email || req.user?.role || 'admin',
      },
    });

    res.json({ ok: true, enviados, erros });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/crm/campanhas?restauranteId=X ─────────────────────────────────
router.get("/crm/campanhas", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  if (!restauranteId) return res.status(400).json({ error: "restauranteId obrigatório" });

  try {
    const campanhas = await prisma.campanhaMarketing.findMany({
      where: { restauranteId },
      orderBy: { criadoEm: "desc" },
      take: 50,
    });
    res.json({ data: campanhas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ESTOQUE ───────────────────────────────────────────────────────────────────
router.get("/estoque", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  if (!restauranteId) return res.status(400).json({ error: "restauranteId obrigatório" });
  const itens = await prisma.itemEstoque.findMany({
    where: { restauranteId, ativo: true },
    orderBy: [{ categoria: "asc" }, { nome: "asc" }],
  });
  res.json({ data: itens });
});

router.post("/estoque", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  const { nome, categoria, unidade, quantidadeAtual, quantidadeMinima, precoUnitario, fornecedor } = req.body;
  if (!restauranteId || !nome || !categoria || !unidade)
    return res.status(400).json({ error: "nome, categoria e unidade são obrigatórios" });
  const item = await prisma.itemEstoque.create({
    data: {
      restauranteId, nome, categoria, unidade,
      quantidadeAtual: Number(quantidadeAtual) || 0,
      quantidadeMinima: Number(quantidadeMinima) || 0,
      precoUnitario: Number(precoUnitario) || 0,
      fornecedor: fornecedor || null,
    },
  });
  res.json({ data: item });
});

router.put("/estoque/:id", async (req, res) => {
  const { nome, categoria, unidade, quantidadeAtual, quantidadeMinima, precoUnitario, fornecedor } = req.body;
  const item = await prisma.itemEstoque.update({
    where: { id: req.params.id },
    data: {
      nome, categoria, unidade,
      quantidadeAtual: Number(quantidadeAtual),
      quantidadeMinima: Number(quantidadeMinima),
      precoUnitario: Number(precoUnitario),
      fornecedor: fornecedor || null,
    },
  });
  res.json({ data: item });
});

router.delete("/estoque/:id", async (req, res) => {
  await prisma.itemEstoque.update({ where: { id: req.params.id }, data: { ativo: false } });
  res.json({ ok: true });
});

router.post("/estoque/:id/movimentacao", async (req, res) => {
  const { tipo, quantidade, precoUnitario, motivo, observacao } = req.body;
  const qtd = Number(quantidade);
  if (!tipo || !qtd || !motivo) return res.status(400).json({ error: "tipo, quantidade e motivo são obrigatórios" });
  const item = await prisma.itemEstoque.findUnique({ where: { id: req.params.id } });
  if (!item) return res.status(404).json({ error: "Item não encontrado" });

  let novaQtd = item.quantidadeAtual;
  if (tipo === "ENTRADA") novaQtd += qtd;
  else if (tipo === "SAIDA") novaQtd = Math.max(0, novaQtd - qtd);
  else if (tipo === "AJUSTE") novaQtd = qtd;

  await prisma.$transaction([
    prisma.movimentacaoEstoque.create({
      data: {
        restauranteId: item.restauranteId, itemId: req.params.id,
        tipo, quantidade: qtd,
        precoUnitario: precoUnitario ? Number(precoUnitario) : null,
        motivo, observacao: observacao || null,
      },
    }),
    prisma.itemEstoque.update({ where: { id: req.params.id }, data: { quantidadeAtual: novaQtd } }),
  ]);
  res.json({ ok: true, quantidadeAtual: novaQtd });
});

router.get("/estoque/:id/movimentacoes", async (req, res) => {
  const movs = await prisma.movimentacaoEstoque.findMany({
    where: { itemId: req.params.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json({ data: movs });
});

// ── CUSTOS MENSAIS ────────────────────────────────────────────────────────────
router.get("/custos", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  const { mes } = req.query;
  if (!restauranteId) return res.status(400).json({ error: "restauranteId obrigatório" });
  const where = { restauranteId };
  if (mes) where.mes = mes;
  const custos = await prisma.custoMensal.findMany({
    where,
    orderBy: [{ categoria: "asc" }, { subcategoria: "asc" }, { createdAt: "asc" }],
  });
  res.json({ data: custos });
});

router.post("/custos", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  const { nome, categoria, subcategoria, valor, mes, observacao } = req.body;
  if (!restauranteId || !nome || !categoria || !subcategoria || !valor || !mes)
    return res.status(400).json({ error: "campos obrigatórios faltando" });
  const custo = await prisma.custoMensal.create({
    data: { restauranteId, nome, categoria, subcategoria, valor: Number(valor), mes, observacao: observacao || null },
  });
  res.json({ data: custo });
});

router.put("/custos/:id", async (req, res) => {
  const { nome, categoria, subcategoria, valor, mes, observacao } = req.body;
  const custo = await prisma.custoMensal.update({
    where: { id: req.params.id },
    data: { nome, categoria, subcategoria, valor: Number(valor), mes, observacao: observacao || null },
  });
  res.json({ data: custo });
});

router.delete("/custos/:id", async (req, res) => {
  await prisma.custoMensal.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// ── FINANCEIRO (DRE mensal) ───────────────────────────────────────────────────
router.get("/financeiro", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  if (!restauranteId) return res.status(400).json({ error: "restauranteId obrigatório" });

  const mesAtual = req.query.mes || new Date().toISOString().slice(0, 7);
  const [year, month] = mesAtual.split("-").map(Number);
  const inicio = new Date(Date.UTC(year, month - 1, 1));
  const fim = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  const tendMeses = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    tendMeses.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  const inicioTend = new Date(Date.UTC(year, month - 6, 1));

  const [pedidosMes, custos, pedidosTend, custosTend, movCMV] = await Promise.all([
    prisma.pedido.findMany({
      where: { restauranteId, status: { not: "CANCELADO" }, createdAt: { gte: inicio, lte: fim } },
      select: { total: true },
    }),
    prisma.custoMensal.findMany({
      where: { restauranteId, mes: mesAtual },
      orderBy: [{ categoria: "asc" }, { subcategoria: "asc" }],
    }),
    prisma.pedido.findMany({
      where: { restauranteId, status: { not: "CANCELADO" }, createdAt: { gte: inicioTend, lte: fim } },
      select: { total: true, createdAt: true },
    }),
    prisma.custoMensal.findMany({
      where: { restauranteId, mes: { in: tendMeses } },
      select: { mes: true, valor: true },
    }),
    prisma.movimentacaoEstoque.findMany({
      where: { restauranteId, tipo: "SAIDA", motivo: "PRODUCAO", createdAt: { gte: inicio, lte: fim } },
      include: { item: { select: { precoUnitario: true } } },
    }),
  ]);

  const faturamento = pedidosMes.reduce((s, p) => s + (p.total || 0), 0);
  const fixos = custos.filter((c) => c.categoria === "FIXO");
  const variaveis = custos.filter((c) => c.categoria === "VARIAVEL");
  const totalFixos = fixos.reduce((s, c) => s + c.valor, 0);
  const totalVariaveis = variaveis.reduce((s, c) => s + c.valor, 0);
  const cmv = movCMV.reduce((s, m) => s + m.quantidade * (m.item?.precoUnitario || 0), 0);
  const lucroBruto = faturamento - cmv;
  const lucroLiquido = lucroBruto - totalFixos - totalVariaveis;
  const margem = faturamento > 0 ? (lucroLiquido / faturamento) * 100 : 0;

  const fatByMes = {};
  pedidosTend.forEach((p) => {
    const m = p.createdAt.toISOString().slice(0, 7);
    fatByMes[m] = (fatByMes[m] || 0) + (p.total || 0);
  });
  const custosByMes = {};
  custosTend.forEach((c) => { custosByMes[c.mes] = (custosByMes[c.mes] || 0) + c.valor; });

  res.json({
    data: {
      mes: mesAtual, faturamento, cmv, totalFixos, totalVariaveis,
      lucroBruto, lucroLiquido, margem, fixos, variaveis,
      tendencia: tendMeses.map((m) => ({
        mes: m,
        faturamento: fatByMes[m] || 0,
        custos: custosByMes[m] || 0,
      })),
    },
  });
});

// ── Mesas ─────────────────────────────────────────────────────────────────────
router.get("/mesas", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  const pedidosAtivos = await prisma.pedido.findMany({
    where: { restauranteId, mesa: { not: null }, status: { notIn: ["ENTREGUE", "CANCELADO"] } },
    orderBy: { createdAt: "asc" },
  });
  const mesas = Array.from({ length: 30 }, (_, i) => i + 1).map((num) => ({
    mesa: num,
    pedido: pedidosAtivos.find((p) => p.mesa === num) || null,
  }));
  res.json({ mesas });
});

router.post("/pedidos/mesa", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  const { mesa, itens, metodoPagamento, status } = req.body;
  if (!mesa || !itens?.length) return res.status(400).json({ error: "mesa e itens são obrigatórios" });
  const total = itens.reduce((s, i) => s + i.preco * i.quantidade, 0);
  const numeroDia = await proximoNumeroDia(restauranteId);
  const statusPedido = status === "NOVO" ? "NOVO" : "CONFIRMADO";
  const sessao = await prisma.sessao.create({
    data: { clienteNumero: `mesa-${mesa}`, clienteNome: `Mesa ${mesa}`, restauranteId, estado: "FINALIZADO", carrinho: itens },
  });
  const pedido = await prisma.pedido.create({
    data: {
      sessaoId: sessao.id, restauranteId,
      clienteNumero: `mesa-${mesa}`, clienteNome: `Mesa ${mesa}`,
      itens, total, metodoPagamento: metodoPagamento || null,
      status: statusPedido, mesa: Number(mesa), origem: "MESA", numeroDia,
    },
  });
  const io = req.app.get("io");
  io?.to("admin").emit("pedido:novo", { restauranteId, pedido });
  res.json(pedido);
});

router.post("/mesas/:num/fechar", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  const mesa = Number(req.params.num);
  const { metodoPagamento } = req.body;
  const io = req.app.get("io");

  const pedidosAtivos = await prisma.pedido.findMany({
    where: { restauranteId, mesa, status: { notIn: ["ENTREGUE", "CANCELADO"] } },
    include: { restaurante: { select: { slugWhatsapp: true } } },
  });

  if (!pedidosAtivos.length) return res.status(404).json({ error: "Nenhum pedido ativo para esta mesa" });

  const todosItens = pedidosAtivos.flatMap(p => Array.isArray(p.itens) ? p.itens : []);
  const totalCombinado = todosItens.reduce((s, i) => s + i.preco * (i.quantidade || 1), 0);

  const upd = { status: "ENTREGUE", pago: true };
  if (metodoPagamento) upd.metodoPagamento = metodoPagamento;

  await prisma.pedido.updateMany({
    where: { id: { in: pedidosAtivos.map(p => p.id) } },
    data: upd,
  });

  const slug = pedidosAtivos[0]?.restaurante?.slugWhatsapp;
  pedidosAtivos.forEach(p => {
    io?.to("admin").emit("pedido:status", { pedidoId: p.id, status: "ENTREGUE" });
    if (slug) io?.to(`restaurante:${slug}`).emit("pedido:status", { pedidoId: p.id, status: "ENTREGUE" });
  });

  res.json({ total: totalCombinado, itens: todosItens, pedidosEncerrados: pedidosAtivos.length });
});

router.patch("/pedidos/:id/mesa", async (req, res) => {
  const { itens, metodoPagamento } = req.body;
  const total = itens.reduce((s, i) => s + i.preco * i.quantidade, 0);
  const upd = { itens, total };
  if (metodoPagamento !== undefined) upd.metodoPagamento = metodoPagamento;
  const pedido = await prisma.pedido.update({ where: { id: req.params.id }, data: upd });
  res.json(pedido);
});

router.get("/mesas/:num/historico", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  const mesa = Number(req.params.num);
  const historico = await prisma.pedido.findMany({
    where: { restauranteId, mesa, status: { in: ["ENTREGUE", "CANCELADO"] } },
    orderBy: { createdAt: "desc" },
    take: 3,
  });
  res.json({ historico });
});

// ══ Caixa ═════════════════════════════════════════════════════════════════════

router.get("/caixa/atual", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  if (!restauranteId) return res.status(400).json({ error: "restauranteId obrigatório" });
  try {
    const turno = await prisma.turnoCaixa.findFirst({
      where: { restauranteId, status: "ABERTO" },
      orderBy: { abertoEm: "desc" },
    });
    res.json({ data: turno || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/caixa/abrir", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  if (!restauranteId) return res.status(400).json({ error: "restauranteId obrigatório" });
  const { valorAbertura = 0, abertoPor } = req.body;
  try {
    const aberto = await prisma.turnoCaixa.findFirst({ where: { restauranteId, status: "ABERTO" } });
    if (aberto) return res.status(409).json({ error: "Já existe um caixa aberto" });
    const turno = await prisma.turnoCaixa.create({
      data: { restauranteId, valorAbertura: parseFloat(valorAbertura) || 0, abertoPor: abertoPor || req.user?.email || null },
    });
    res.json({ data: turno });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/caixa/:id/sangria", async (req, res) => {
  const { id } = req.params;
  const { valor, motivo } = req.body;
  if (!valor || !motivo) return res.status(400).json({ error: "valor e motivo são obrigatórios" });
  try {
    const turno = await prisma.turnoCaixa.findUnique({ where: { id } });
    if (!turno || turno.status !== "ABERTO") return res.status(400).json({ error: "Turno não encontrado ou já fechado" });
    const sangrias = [...(turno.sangrias || []), {
      valor: parseFloat(valor),
      motivo,
      registradoPor: req.user?.email || "admin",
      criadoEm: new Date().toISOString(),
    }];
    const totalSangrias = sangrias.reduce((acc, s) => acc + s.valor, 0);
    const updated = await prisma.turnoCaixa.update({ where: { id }, data: { sangrias, totalSangrias } });
    res.json({ data: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/caixa/:id/fechar", async (req, res) => {
  const { id } = req.params;
  const { valorFechamento, fechadoPor, observacao } = req.body;
  try {
    const turno = await prisma.turnoCaixa.findUnique({ where: { id } });
    if (!turno || turno.status !== "ABERTO") return res.status(400).json({ error: "Turno não encontrado ou já fechado" });

    const pedidosPagos = await prisma.pedido.findMany({
      where: { restauranteId: turno.restauranteId, pago: true, createdAt: { gte: turno.abertoEm } },
      select: { total: true, metodoPagamento: true },
    });

    let totalVendas = 0, totalDinheiro = 0, totalCartao = 0, totalPix = 0, totalOutros = 0;
    for (const p of pedidosPagos) {
      totalVendas += p.total;
      const met = (p.metodoPagamento || "").toLowerCase();
      if (met.includes("dinheiro")) totalDinheiro += p.total;
      else if (met.includes("cart")) totalCartao += p.total;
      else if (met.includes("pix") || met.includes("transfer")) totalPix += p.total;
      else totalOutros += p.total;
    }

    const updated = await prisma.turnoCaixa.update({
      where: { id },
      data: {
        status: "FECHADO",
        valorFechamento: valorFechamento != null ? parseFloat(valorFechamento) : null,
        fechadoPor: fechadoPor || req.user?.email || null,
        fechadoEm: new Date(),
        observacao: observacao || null,
        totalVendas, totalDinheiro, totalCartao, totalPix, totalOutros,
      },
    });
    res.json({ data: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/caixa/historico", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  if (!restauranteId) return res.status(400).json({ error: "restauranteId obrigatório" });
  try {
    const turnos = await prisma.turnoCaixa.findMany({
      where: { restauranteId },
      orderBy: { abertoEm: "desc" },
      take: 30,
    });
    res.json({ data: turnos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/comprovantes — pedidos com comprovante de pagamento ────────────
router.get("/comprovantes", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  if (!restauranteId) return res.status(400).json({ error: "restauranteId obrigatório" });
  const { pago, inicio, fim } = req.query;
  const where = { restauranteId, comprovanteUrl: { not: null } };
  if (pago === "true") where.pago = true;
  if (pago === "false") where.pago = false;
  if (inicio || fim) {
    where.createdAt = {};
    if (inicio) where.createdAt.gte = new Date(inicio + "T00:00:00");
    if (fim) where.createdAt.lte = new Date(fim + "T23:59:59");
  }
  try {
    const pedidos = await prisma.pedido.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        id: true, numeroDia: true, origem: true, localizacao: true,
        clienteNome: true, clienteNumero: true,
        total: true, metodoPagamento: true, pago: true, status: true,
        comprovanteUrl: true, createdAt: true, itens: true,
        restaurante: { select: { moeda: true } },
      },
    });
    res.json({ data: pedidos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
