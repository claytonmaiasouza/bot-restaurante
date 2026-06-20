const { Router } = require("express");
const { PrismaClient } = require("@prisma/client");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { confirmarPedido, proximoNumeroDia, formatNumPedido } = require("../services/pedidoService");
const { enviarMensagem, listarInstancias, obterQRCode, verificarConexao, criarInstancia, configurarWebhook, excluirInstancia } = require("../services/evolutionService");
const { authMiddleware } = require("../middleware/authMiddleware");
const {
  buscarCardapioDB, buscarCardapioAdmin, criarCategoria, atualizarCategoria, deletarCategoria,
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

// Multer: salva imagem de categoria em disco
const uploadCatImagem = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = FOTO_EXTS[file.mimetype] || "jpg";
      cb(null, `cat-${req.params.id}.${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype in FOTO_EXTS),
});

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

// Multer: salva foto de produto em disco
const uploadProdutoImagem = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = FOTO_EXTS[file.mimetype] || "jpg";
      cb(null, `produto-${req.params.id}-${Date.now()}.${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
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

// ── Helper: bloqueia acesso de um restaurante a recurso de outro tenant ────────
function denegarOutroTenant(req, res, restauranteId) {
  if (req.user.role === "restaurante" && req.user.restauranteId !== restauranteId) {
    res.status(403).json({ error: "Acesso negado" });
    return true;
  }
  return false;
}

// ── GET /admin/restaurantes ───────────────────────────────────────────────────
router.get("/restaurantes", async (req, res) => {
  try {
    const where = req.user.role === "restaurante" ? { id: req.user.restauranteId } : {};
    const restaurantes = await prisma.restaurante.findMany({
      where,
      select: { id: true, nome: true, slugWhatsapp: true, donoWhatsapp: true, moeda: true, taxaEntrega: true, ativo: true, email: true, horarioAtendimento: true, cardapioPdfUrl: true, dadosTransferencia: true, instrucoes: true,
                faturaRuc: true, faturaRazaoSocial: true, faturaEndereco: true, faturaCiudad: true, faturaTelefone: true, faturaTimbrado: true, faturaVencTimbrado: true, faturaInicioVigencia: true, faturaSerie: true, faturaProximoNum: true },
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
    // Pedidos pagos: filtra por updatedAt (quando o pagamento foi confirmado, não quando o pedido foi criado)
    const campoData = where.pago ? "updatedAt" : "createdAt";
    where[campoData] = {};
    if (inicio) where[campoData].gte = new Date(inicio);
    if (fim) where[campoData].lte = new Date(fim + "T23:59:59.999Z");
  }

  try {
    const [pedidos, total] = await prisma.$transaction([
      prisma.pedido.findMany({
        where,
        orderBy: { createdAt: "asc" },
        skip: offset,
        take: limite,
        include: {
          restaurante: { select: { nome: true, slugWhatsapp: true, instanceEvolution: true, moeda: true, taxaEntrega: true } },
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
    const isMaquininha = (mp) => mp && mp.toLowerCase().includes("cartão");
    const isTransferencia = (mp) => mp && /transf/i.test(mp);
    const extraData = {};

    // Busca estado atual (necessário para verificar caixa e lógicas de ENTREGUE/comprovante)
    const atual = await prisma.pedido.findUnique({
      where: { id },
      select: { restauranteId: true, metodoPagamento: true, pago: true, origem: true, comprovanteUrl: true, sessaoId: true, localizacao: true },
    });
    if (!atual) return res.status(404).json({ error: "Pedido não encontrado" });

    // Exige caixa aberto para qualquer alteração de status
    const caixaAberto = await prisma.turnoCaixa.findFirst({
      where: { restauranteId: atual.restauranteId, status: "ABERTO" },
    });
    if (!caixaAberto) {
      return res.status(400).json({ error: "Abra o caixa antes de confirmar pedidos" });
    }

    // Cartão e mesa: ao marcar ENTREGUE, confirma pagamento automaticamente
    // Dinheiro delivery: requer confirmação manual do retorno do motoboy ao caixa
    const isDinheiroDelivery = /dinheiro/i.test(atual.metodoPagamento || "") && atual.origem !== "MESA" && atual.localizacao !== "Retirada no balcão";
    if (status === "ENTREGUE" && atual && !atual.pago && (isMaquininha(atual.metodoPagamento) || atual.origem === "MESA" || (/dinheiro/i.test(atual.metodoPagamento || "") && !isDinheiroDelivery))) {
      extraData.pago = true;
    }

    const pedido = await prisma.pedido.update({
      where: { id },
      data: { status, ...extraData },
      include: { restaurante: { select: { nome: true, slugWhatsapp: true, instanceEvolution: true, moeda: true, taxaEntrega: true } } },
    });

    const numFmt = formatNumPedido(pedido);

    // Notifica o cliente via WhatsApp (bilíngue: detecta idioma da sessão)
    const mensagem = await getNotificacao(status, numFmt, pedido.sessaoId);
    if (mensagem) {
      await enviarMensagem(pedido.clienteNumero, mensagem, pedido.restaurante.instanceEvolution || pedido.restaurante.slugWhatsapp).catch(() => {});
    }

    // Transferência sem comprovante: pede comprovante ao sair para entrega ou ao entregar
    if (["SAIU_PARA_ENTREGA", "ENTREGUE"].includes(status) && atual && isTransferencia(atual.metodoPagamento) && !atual.pago && !atual.comprovanteUrl) {
      let idiomaCliente = "pt";
      if (atual.sessaoId) {
        const sessao = await prisma.sessao.findUnique({
          where: { id: atual.sessaoId },
          include: { mensagens: { where: { role: "cliente" }, orderBy: { createdAt: "asc" }, take: 5 } },
        });
        idiomaCliente = detectarIdioma(sessao?.mensagens || []);
      }
      const msgComp = idiomaCliente === "es"
        ? `🧾 Para confirmar el pago del pedido *#${numFmt}*, por favor envíanos el comprobante de transferencia por aquí. ¡Gracias!`
        : `🧾 Para confirmarmos o pagamento do pedido *#${numFmt}*, por favor envie o comprovante de transferência aqui. Obrigado!`;
      await enviarMensagem(pedido.clienteNumero, msgComp, pedido.restaurante.instanceEvolution || pedido.restaurante.slugWhatsapp).catch(() => {});
    }

    // Emite para o painel em tempo real
    io?.to("admin").emit("pedido:atualizado", pedido);
    io?.to(`restaurante:${pedido.restaurante.slugWhatsapp}`).emit("pedido:atualizado", pedido);

    // Notifica o garçom pessoalmente quando pedido de mesa fica pronto
    if (status === "PRONTO_PARA_RETIRADA" && pedido.garconId) {
      io?.to(`garcon:${pedido.garconId}`).emit("pedido:pronto", {
        id: pedido.id,
        mesa: pedido.mesa,
        itens: pedido.itens,
        garconId: pedido.garconId,
        numeroDia: pedido.numeroDia,
      });
    }

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
    const atual = await prisma.pedido.findUnique({
      where: { id },
      select: { status: true, metodoPagamento: true, clienteNumero: true, sessaoId: true, origem: true, restauranteId: true, motoboyId: true },
    });
    if (!atual) return res.status(404).json({ error: "Pedido não encontrado" });

    // Exige caixa aberto para confirmar pagamento (garante que updatedAt >= turno.abertoEm)
    const caixaAbertoPago = await prisma.turnoCaixa.findFirst({
      where: { restauranteId: atual.restauranteId, status: "ABERTO" },
    });
    if (!caixaAbertoPago) {
      return res.status(400).json({ error: "Abra o caixa antes de confirmar pagamentos" });
    }

    // Marca como pago sem regredir o status — só avança para PAGO se ainda não chegou lá
    const statusAntesDePago = ["NOVO", "CONFIRMADO"];
    const novoStatus = statusAntesDePago.includes(atual.status) ? "PAGO" : atual.status;

    const pedido = await prisma.pedido.update({
      where: { id },
      data: { pago: true, status: novoStatus },
      include: { restaurante: { select: { nome: true, slugWhatsapp: true, instanceEvolution: true, moeda: true, taxaEntrega: true } } },
    });

    // Retorno de troco ao caixa: motoboy retornou com pedido dinheiro com troco
    if (/dinheiro/i.test(atual.metodoPagamento || "") && /levar troco/i.test(atual.metodoPagamento || "")) {
      const caixaRetorno = await prisma.turnoCaixa.findFirst({
        where: { restauranteId: atual.restauranteId, status: "ABERTO" },
      });
      if (caixaRetorno) {
        const trocoMatch = (atual.metodoPagamento || "").match(/levar troco:\s*[^\d]*([\d.,]+)/i);
        if (trocoMatch) {
          const trocoValor = parseFloat(trocoMatch[1].replace(/\./g, "").replace(",", "."));
          if (!isNaN(trocoValor) && trocoValor > 0) {
            const sangrias = [...(caixaRetorno.sangrias || []), {
              valor: -trocoValor,
              motivo: `Retorno de troco — Pedido #${formatNumPedido(pedido)}`,
              registradoPor: req.user?.email || "sistema",
              criadoEm: new Date().toISOString(),
            }];
            const totalSangrias = sangrias.reduce((acc, s) => acc + s.valor, 0);
            await prisma.turnoCaixa.update({ where: { id: caixaRetorno.id }, data: { sangrias, totalSangrias } });
          }
        }
      }
    }

    if (novoStatus === "PAGO") {
      const mensagem = await getNotificacao("PAGO", formatNumPedido(pedido), pedido.sessaoId);
      if (mensagem) {
        await enviarMensagem(pedido.clienteNumero, mensagem, pedido.restaurante.instanceEvolution || pedido.restaurante.slugWhatsapp).catch(() => {});
      }
    } else if (atual.status === "ENTREGUE" && /transf/i.test(atual.metodoPagamento || "") && atual.origem !== "MESA") {
      // Pedido entregue com transferência confirmada — notifica o cliente
      let idioma = "pt";
      if (atual.sessaoId) {
        const sessao = await prisma.sessao.findUnique({
          where: { id: atual.sessaoId },
          include: { mensagens: { where: { role: "cliente" }, orderBy: { createdAt: "asc" }, take: 5 } },
        });
        idioma = detectarIdioma(sessao?.mensagens || []);
      }
      const numFmt = formatNumPedido(pedido);
      const msgConfirmado = idioma === "es"
        ? `✅ ¡Pago del pedido *#${numFmt}* confirmado! Muchas gracias. 😊\n\nSi deseas hacer otro pedido, escríbenos cuando quieras.`
        : `✅ Pagamento do pedido *#${numFmt}* confirmado! Muito obrigado. 😊\n\nSe quiser fazer outro pedido, é só nos chamar!`;
      await enviarMensagem(atual.clienteNumero, msgConfirmado, pedido.restaurante.instanceEvolution || pedido.restaurante.slugWhatsapp).catch(() => {});
    }

    io?.to("admin").emit("pedido:atualizado", pedido);
    io?.to(`restaurante:${pedido.restaurante.slugWhatsapp}`).emit("pedido:atualizado", pedido);
    // Notifica motoboy que a devolução foi confirmada e remove banner do caixa
    if (atual.motoboyId) {
      io?.to(`restaurante:${pedido.restaurante.slugWhatsapp}`).emit("motoboy:devolucao-confirmada", { pedidoId: id, motoboyId: atual.motoboyId });
    }
    io?.to(`restaurante:${pedido.restaurante.slugWhatsapp}`).emit("caixa:devolucao-confirmada", { pedidoId: id });

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

    const trocoDispatch = (pedido.metodoPagamento || "").match(/levar troco:\s*([^\n(]+)/i);
    const devolverAoCaixa = trocoDispatch ? `\n💵 *Devolver ao caixa: ${fmt(pedido.total)}*` : "";

    const mensagem =
      `🛵 *ENTREGA #${formatNumPedido(pedido)}*\n\n` +
      `👤 *Cliente:* ${pedido.clienteNome || "Não identificado"}\n` +
      `📱 *WhatsApp:* ${pedido.clienteNumero}\n\n` +
      `🛒 *Itens:*\n${itensTexto}\n\n` +
      `💰 *Total: ${fmt(pedido.total)}*${pagamento}${devolverAoCaixa}\n\n` +
      `📍 *Endereço:*\n${pedido.localizacao || "Não informado"}`;

    // Salva o motoboy no pedido independentemente do sucesso da mensagem WA
    await prisma.pedido.update({
      where: { id },
      data: { motoboyId: motoboy.id, motoboyNome: motoboy.nome },
    });


    let avisoWa = null;
    try {
      await enviarMensagem(motoboy.telefone, mensagem, pedido.restaurante.instanceEvolution || pedido.restaurante.slugWhatsapp);
    } catch (errWa) {
      console.error("[despachar] falha ao notificar motoboy via WA:", errWa.response?.data || errWa.message);
      avisoWa = "Motoboy atribuído, mas a mensagem WhatsApp não foi enviada.";
    }

    res.json({ ok: true, motoboy: motoboy.nome, aviso: avisoWa });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/pedidos/:id/liberar-troco — caixa aprova sangria de troco para motoboy
router.post("/pedidos/:id/liberar-troco", async (req, res) => {
  const { id } = req.params;
  const { motoboyId, motoboyNome } = req.body;
  const io = req.app.get("io");

  try {
    const pedido = await prisma.pedido.findUnique({
      where: { id },
      include: { restaurante: { select: { slugWhatsapp: true, instanceEvolution: true } } },
    });
    if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });

    const trocoMatch = (pedido.metodoPagamento || "").match(/levar troco:\s*[^\d]*([\d.,]+)/i);
    let trocoValor;
    if (trocoMatch) {
      trocoValor = parseFloat(trocoMatch[1].replace(/\./g, "").replace(",", "."));
    } else {
      // Fallback: pedido sem "(levar troco: X)" pré-calculado (loja online ou parse falhou)
      // Extrai o valor com que o cliente vai pagar e calcula o troco
      const pagarComMatch = (pedido.metodoPagamento || "").match(/troco(?:\s+p\/|\s+para)\s+[^\d]*([\d.,]+)/i);
      if (!pagarComMatch) return res.status(400).json({ error: "Pedido não tem troco definido" });
      const pagarCom = parseFloat(pagarComMatch[1].replace(/\./g, "").replace(",", "."));
      trocoValor = pagarCom - (pedido.total || 0);
    }
    if (isNaN(trocoValor) || trocoValor <= 0) return res.status(400).json({ error: "Valor de troco inválido" });

    const caixaAberto = await prisma.turnoCaixa.findFirst({
      where: { restauranteId: pedido.restauranteId, status: "ABERTO" },
    });
    if (!caixaAberto) return res.status(400).json({ error: "Nenhum caixa aberto" });

    const sangrias = [...(caixaAberto.sangrias || []), {
      valor: trocoValor,
      motivo: `Troco Pedido #${formatNumPedido(pedido)} — Motoboy: ${motoboyNome || "?"}`,
      registradoPor: req.user?.email || "caixa",
      criadoEm: new Date().toISOString(),
    }];
    const totalSangrias = sangrias.reduce((acc, s) => acc + s.valor, 0);
    await prisma.turnoCaixa.update({ where: { id: caixaAberto.id }, data: { sangrias, totalSangrias } });

    io?.to(`restaurante:${pedido.restaurante.slugWhatsapp}`).emit("motoboy:troco-aprovado", {
      pedidoId: id,
      motoboyId,
      trocoValor,
    });

    res.json({ ok: true });
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
  const pendingDelivery = { pedido: { is: { status: { notIn: ["ENTREGUE", "CANCELADO"] } } } };
  let where;
  if (encerradas === "true") {
    where = { estado: "FINALIZADO", NOT: pendingDelivery };
  } else {
    where = { OR: [{ estado: { not: "FINALIZADO" } }, { estado: "FINALIZADO", ...pendingDelivery }] };
  }
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

    // Resolve números LID (> 13 dígitos) para o telefone real via tabela Contact
    const lidSessoes = sessoes.filter(s => s.clienteNumero && s.clienteNumero.length > 13 && !s.clienteNumero.includes('@'));
    if (lidSessoes.length > 0) {
      const lidJids = lidSessoes.map(s => s.clienteNumero + '@lid');
      const resolved = await prisma.$queryRaw`
        SELECT c1."remoteJid" AS lid, REPLACE(c2."remoteJid", '@s.whatsapp.net', '') AS telefone
        FROM "Contact" c1
        JOIN "Contact" c2 ON c2."instanceId" = c1."instanceId"
          AND c2."pushName" = c1."pushName"
          AND c2."remoteJid" LIKE '%@s.whatsapp.net'
        WHERE c1."remoteJid" = ANY(${lidJids})
      `;
      const lidMap = Object.fromEntries(resolved.map(r => [r.lid.replace('@lid', ''), r.telefone]));
      for (const s of lidSessoes) {
        if (lidMap[s.clienteNumero]) {
          // Corrige no banco e retorna o número real
          await prisma.sessao.update({ where: { id: s.id }, data: { clienteNumero: lidMap[s.clienteNumero] } }).catch(() => {});
          s.clienteNumero = lidMap[s.clienteNumero];
        }
      }
    }

    res.json({ data: sessoes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/conversas/:id/mensagens", async (req, res) => {
  try {
    const sessao = await prisma.sessao.findUnique({ where: { id: req.params.id }, select: { restauranteId: true } });
    if (!sessao) return res.status(404).json({ error: "Sessão não encontrada" });
    if (denegarOutroTenant(req, res, sessao.restauranteId)) return;
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
    if (denegarOutroTenant(req, res, sessao.restauranteId)) return;

    const atualizada = await prisma.sessao.update({
      where: { id: req.params.id },
      data: { botPausado: !sessao.botPausado },
    });

    // Propaga botPausado para todas as outras sessões ativas do mesmo cliente
    await prisma.sessao.updateMany({
      where: {
        clienteNumero: sessao.clienteNumero,
        restauranteId: sessao.restauranteId,
        estado: { not: "FINALIZADO" },
        id: { not: sessao.id },
      },
      data: { botPausado: atualizada.botPausado },
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
    if (denegarOutroTenant(req, res, sessao.restauranteId)) return;

    const instanceName = sessao.restaurante.instanceEvolution || sessao.restaurante.slugWhatsapp;
    const despedida = "Olá! 👋 Esta conversa foi encerrada pelo nosso atendimento. Caso precise de mais alguma coisa, é só nos chamar. Obrigado! 😊";
    enviarMensagem(sessao.clienteNumero, despedida, instanceName).catch(e =>
      console.error("[admin] erro ao enviar despedida:", e.message)
    );
    await prisma.mensagem.create({
      data: { sessaoId: sessao.id, role: "bot", conteudo: `[admin] ${despedida}` },
    });

    // Finaliza todas as sessões ativas do mesmo cliente neste restaurante
    await prisma.sessao.updateMany({
      where: {
        clienteNumero: sessao.clienteNumero,
        restauranteId: sessao.restauranteId,
        estado: { not: "FINALIZADO" },
      },
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
    if (denegarOutroTenant(req, res, sessao.restauranteId)) return;

    const instanceName = sessao.restaurante.instanceEvolution || sessao.restaurante.slugWhatsapp;
    await enviarMensagem(sessao.clienteNumero, mensagem.trim(), instanceName);

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

// ══ WhatsApp: reconectar instância do restaurante (admin ou próprio restaurante) ══

router.post("/restaurantes/:id/reconectar-whatsapp", async (req, res) => {
  const { id } = req.params;
  if (req.user.role === "restaurante" && req.user.restauranteId !== id) {
    return res.status(403).json({ error: "Acesso negado" });
  }
  try {
    const restaurante = await prisma.restaurante.findUnique({ where: { id } });
    if (!restaurante) return res.status(404).json({ error: "Restaurante não encontrado" });

    const slugAtual = restaurante.slugWhatsapp;
    const novoSlug = req.body?.novoSlug?.trim().replace(/\D/g, "") || "";
    const slugFinal = novoSlug && novoSlug !== slugAtual ? novoSlug : slugAtual;

    try { await excluirInstancia(slugAtual); } catch {}

    if (slugFinal !== slugAtual) {
      await prisma.restaurante.update({ where: { id }, data: { slugWhatsapp: slugFinal } });
      const { invalidarCache } = require("../services/tenantService");
      invalidarCache(slugAtual);
    }

    await criarInstancia({ ...restaurante, slugWhatsapp: slugFinal });

    const webhookBaseUrl = process.env.BOT_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
    try { await configurarWebhook(slugFinal, webhookBaseUrl); } catch {}

    let qr = null;
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 2000));
      qr = await obterQRCode(slugFinal);
      if (qr?.qrcode || qr?.base64) break;
    }

    if (!qr) {
      const conexao = await verificarConexao(slugFinal);
      if (conexao.connected) return res.json({ connected: true, slugUsado: slugFinal });
      return res.status(202).json({ message: "QR ainda gerando, tente novamente em instantes" });
    }

    res.json({ qrcode: qr, slugUsado: slugFinal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/restaurantes/:id/qrcode-whatsapp", async (req, res) => {
  const { id } = req.params;
  if (req.user.role === "restaurante" && req.user.restauranteId !== id) {
    return res.status(403).json({ error: "Acesso negado" });
  }
  try {
    const restaurante = await prisma.restaurante.findUnique({ where: { id }, select: { slugWhatsapp: true } });
    if (!restaurante) return res.status(404).json({ error: "Restaurante não encontrado" });

    const slug = restaurante.slugWhatsapp;
    const conexao = await verificarConexao(slug);
    if (conexao.connected) return res.json({ connected: true, number: conexao.number });

    const qr = await obterQRCode(slug);
    if (qr?.qrcode || qr?.base64) return res.json({ qrcode: qr });

    res.status(202).json({ message: "QR não disponível" });
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

  const { nome, donoWhatsapp, moeda, taxaEntrega, email, senha, ativo, horarioAtendimento, dadosTransferencia, instrucoes,
          faturaRuc, faturaRazaoSocial, faturaEndereco, faturaCiudad, faturaTelefone, faturaTimbrado, faturaVencTimbrado, faturaInicioVigencia, faturaSerie } = req.body;

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
    if (faturaRuc !== undefined)           dados.faturaRuc = faturaRuc || null;
    if (faturaRazaoSocial !== undefined)   dados.faturaRazaoSocial = faturaRazaoSocial || null;
    if (faturaEndereco !== undefined)      dados.faturaEndereco = faturaEndereco || null;
    if (faturaCiudad !== undefined)        dados.faturaCiudad = faturaCiudad || null;
    if (faturaTelefone !== undefined)      dados.faturaTelefone = faturaTelefone || null;
    if (faturaTimbrado !== undefined)      dados.faturaTimbrado = faturaTimbrado || null;
    if (faturaVencTimbrado !== undefined)    dados.faturaVencTimbrado = faturaVencTimbrado || null;
    if (faturaInicioVigencia !== undefined) dados.faturaInicioVigencia = faturaInicioVigencia || null;
    if (faturaSerie !== undefined)           dados.faturaSerie = faturaSerie || "001-001";
    // Só admin pode ativar/desativar
    if (ativo !== undefined && req.user.role === "admin") dados.ativo = ativo;

    const restaurante = await prisma.restaurante.update({
      where: { id },
      data: dados,
      select: { id: true, nome: true, slugWhatsapp: true, donoWhatsapp: true, moeda: true, taxaEntrega: true, ativo: true, email: true, horarioAtendimento: true, cardapioPdfUrl: true, dadosTransferencia: true, instrucoes: true,
                faturaRuc: true, faturaRazaoSocial: true, faturaEndereco: true, faturaCiudad: true, faturaTelefone: true, faturaTimbrado: true, faturaVencTimbrado: true, faturaInicioVigencia: true, faturaSerie: true, faturaProximoNum: true },
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

  const filePath = path.resolve(UPLOADS_DIR, filename);
  if (!filePath.startsWith(UPLOADS_DIR + path.sep)) {
    return res.status(400).json({ error: "Nome de arquivo inválido" });
  }
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
      buscarCardapioAdmin(restauranteId),
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
  const { nome, ordem, tamanhos, tipoTamanhos, bordas, estacaoTipo, canais } = req.body;
  if (!nome) return res.status(400).json({ error: "nome é obrigatório" });
  try {
    const cat = await criarCategoria(restauranteId, nome, ordem, tamanhos || [], tipoTamanhos || "simples", bordas || [], estacaoTipo || "GERAL", canais || ["SALAO", "DELIVERY", "WEB"]);
    await invalidarCachePorRestauranteId(restauranteId);
    res.status(201).json({ data: cat });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/cardapio/categorias/:id
router.patch("/cardapio/categorias/:id", async (req, res) => {
  try {
    const existing = await prisma.categoria.findUnique({ where: { id: req.params.id }, select: { restauranteId: true } });
    if (!existing) return res.status(404).json({ error: "Categoria não encontrada" });
    if (denegarOutroTenant(req, res, existing.restauranteId)) return;
    const cat = await atualizarCategoria(req.params.id, req.body);
    await invalidarCachePorCategoriaId(req.params.id);
    res.json({ data: cat });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/cardapio/categorias/:id/imagem
router.post("/cardapio/categorias/:id/imagem", uploadCatImagem.single("imagem"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });
    const ext = FOTO_EXTS[req.file.mimetype] || "jpg";
    const url = `${process.env.BOT_PUBLIC_URL}/uploads/cat-${req.params.id}.${ext}`;
    await atualizarCategoria(req.params.id, { imagemUrl: url });
    await invalidarCachePorCategoriaId(req.params.id);
    res.json({ data: { imagemUrl: url } });
  } catch (e) {
    console.error("[admin] POST categorias/:id/imagem", e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /admin/cardapio/categorias/:id
router.delete("/cardapio/categorias/:id", async (req, res) => {
  try {
    const existing = await prisma.categoria.findUnique({ where: { id: req.params.id }, select: { restauranteId: true } });
    if (!existing) return res.status(404).json({ error: "Categoria não encontrada" });
    if (denegarOutroTenant(req, res, existing.restauranteId)) return;
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
    const existing = await prisma.produto.findUnique({ where: { id: req.params.id }, select: { categoria: { select: { restauranteId: true } } } });
    if (!existing) return res.status(404).json({ error: "Produto não encontrado" });
    if (denegarOutroTenant(req, res, existing.categoria.restauranteId)) return;
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
    const existing = await prisma.produto.findUnique({ where: { id: req.params.id }, select: { categoria: { select: { restauranteId: true } } } });
    if (!existing) return res.status(404).json({ error: "Produto não encontrado" });
    if (denegarOutroTenant(req, res, existing.categoria.restauranteId)) return;
    await invalidarCachePorProdutoId(req.params.id);
    await deletarProduto(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/cardapio/produtos/:id/foto — upload de foto do produto
router.post("/cardapio/produtos/:id/foto", uploadProdutoImagem.single("foto"), async (req, res) => {
  try {
    const existing = await prisma.produto.findUnique({
      where: { id: req.params.id },
      select: { categoria: { select: { restauranteId: true } } },
    });
    if (!existing) return res.status(404).json({ error: "Produto não encontrado" });
    if (denegarOutroTenant(req, res, existing.categoria.restauranteId)) return;
    if (!req.file) return res.status(400).json({ error: "Nenhuma imagem enviada" });
    const imagemUrl = `${process.env.BOT_PUBLIC_URL}/uploads/${req.file.filename}`;
    await prisma.produto.update({ where: { id: req.params.id }, data: { imagemUrl } });
    await invalidarCachePorProdutoId(req.params.id);
    res.json({ data: { imagemUrl } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/cardapio/produtos/:id/gerar-foto — busca foto real na internet pelo sabor
router.post("/cardapio/produtos/:id/gerar-foto", async (req, res) => {
  try {
    const existing = await prisma.produto.findUnique({
      where: { id: req.params.id },
      select: { nome: true, categoria: { select: { restauranteId: true, nome: true } } },
    });
    if (!existing) return res.status(404).json({ error: "Produto não encontrado" });
    if (denegarOutroTenant(req, res, existing.categoria.restauranteId)) return;

    // Extrai sabor: remove prefixo "pizza" para buscar só o sabor
    const isPizza = /pizza/i.test(existing.nome) || /pizza/i.test(existing.categoria.nome);
    const sabor = existing.nome.replace(/^pizza\s+/i, '').trim();
    const searchQuery = isPizza ? `pizza ${sabor} brasileira` : `${existing.nome} ${existing.categoria.nome} foto comida`;

    console.log(`[gerar-foto] buscando imagem: "${searchQuery}"`);

    // Busca no Bing Images
    const bingRes = await axios.get(
      `https://www.bing.com/images/search?q=${encodeURIComponent(searchQuery)}&form=HDRSC2&first=1&count=20`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: 15000,
      }
    );

    // Extrai URLs das imagens do HTML do Bing (suporta aspas normais e HTML-encoded &quot;)
    const html = bingRes.data;
    let imageUrls = [];

    // Padrão 1: HTML-encoded — &quot;murl&quot;:&quot;URL&quot; (formato mais comum)
    const enc = [...html.matchAll(/&quot;murl&quot;:&quot;(https?:[^&]+)&quot;/g)];
    if (enc.length) imageUrls = enc.map(m => m[1]);

    // Padrão 2: JSON puro — "murl":"URL" (fallback)
    if (!imageUrls.length) {
      const raw = [...html.matchAll(/"murl":"(https?:[^"]+)"/g)];
      imageUrls = raw.map(m => m[1]);
    }

    imageUrls = imageUrls.filter(url => /\.(jpg|jpeg|png|webp)/i.test(url));
    console.log(`[gerar-foto] ${imageUrls.length} URLs encontradas`);

    if (!imageUrls.length) return res.status(500).json({ error: `Nenhuma imagem encontrada para "${sabor}". Verifique o nome do produto.` });

    // Tenta baixar as primeiras 5 URLs até uma funcionar
    let imgBuffer = null;
    for (const url of imageUrls.slice(0, 5)) {
      try {
        const imgRes = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
        const contentType = imgRes.headers['content-type'] || '';
        if (contentType.startsWith('image/') && imgRes.data.byteLength > 5000) {
          imgBuffer = imgRes.data;
          break;
        }
      } catch { continue; }
    }

    if (!imgBuffer) return res.status(500).json({ error: 'Não foi possível baixar imagem. Tente novamente.' });

    const filename = `produto-${req.params.id}-${Date.now()}.jpg`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), imgBuffer);

    const imagemUrl = `${process.env.BOT_PUBLIC_URL}/uploads/${filename}`;
    await prisma.produto.update({ where: { id: req.params.id }, data: { imagemUrl } });
    await invalidarCachePorProdutoId(req.params.id);
    res.json({ data: { imagemUrl } });
  } catch (err) {
    console.error("[gerar-foto]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/cardapio/tamanhos/:id
router.patch("/cardapio/tamanhos/:id", async (req, res) => {
  try {
    const existing = await prisma.tamanho.findUnique({ where: { id: req.params.id }, select: { produto: { select: { categoria: { select: { restauranteId: true } } } } } });
    if (!existing) return res.status(404).json({ error: "Tamanho não encontrado" });
    if (denegarOutroTenant(req, res, existing.produto.categoria.restauranteId)) return;
    const tamanho = await atualizarTamanho(req.params.id, req.body);
    res.json({ data: tamanho });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/cardapio/tamanhos/:id
router.delete("/cardapio/tamanhos/:id", async (req, res) => {
  try {
    const existing = await prisma.tamanho.findUnique({ where: { id: req.params.id }, select: { produto: { select: { categoria: { select: { restauranteId: true } } } } } });
    if (!existing) return res.status(404).json({ error: "Tamanho não encontrado" });
    if (denegarOutroTenant(req, res, existing.produto.categoria.restauranteId)) return;
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
  const existing = await prisma.itemEstoque.findUnique({ where: { id: req.params.id }, select: { restauranteId: true } });
  if (!existing) return res.status(404).json({ error: "Item não encontrado" });
  if (denegarOutroTenant(req, res, existing.restauranteId)) return;
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
  const existing = await prisma.itemEstoque.findUnique({ where: { id: req.params.id }, select: { restauranteId: true } });
  if (!existing) return res.status(404).json({ error: "Item não encontrado" });
  if (denegarOutroTenant(req, res, existing.restauranteId)) return;
  await prisma.itemEstoque.update({ where: { id: req.params.id }, data: { ativo: false } });
  res.json({ ok: true });
});

router.post("/estoque/:id/movimentacao", async (req, res) => {
  const { tipo, quantidade, precoUnitario, motivo, observacao } = req.body;
  const qtd = Number(quantidade);
  if (!tipo || !qtd || !motivo) return res.status(400).json({ error: "tipo, quantidade e motivo são obrigatórios" });
  const item = await prisma.itemEstoque.findUnique({ where: { id: req.params.id } });
  if (!item) return res.status(404).json({ error: "Item não encontrado" });
  if (denegarOutroTenant(req, res, item.restauranteId)) return;

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
  const existing = await prisma.itemEstoque.findUnique({ where: { id: req.params.id }, select: { restauranteId: true } });
  if (!existing) return res.status(404).json({ error: "Item não encontrado" });
  if (denegarOutroTenant(req, res, existing.restauranteId)) return;
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

  res.json({ total: totalCombinado, itens: todosItens, pedidosEncerrados: pedidosAtivos.length, pedidoIds: pedidosAtivos.map(p => p.id) });
});

router.patch("/pedidos/:id/mesa", async (req, res) => {
  const { itens, metodoPagamento } = req.body;
  const existing = await prisma.pedido.findUnique({ where: { id: req.params.id }, select: { restauranteId: true } });
  if (!existing) return res.status(404).json({ error: "Pedido não encontrado" });
  if (denegarOutroTenant(req, res, existing.restauranteId)) return;
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
    take: 5,
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

    // Usa o fechadoEm do turno anterior como corte (cobre pedidos pagos no intervalo
    // entre o fechamento do caixa anterior e a abertura deste)
    const turnoAnterior = await prisma.turnoCaixa.findFirst({
      where: { restauranteId: turno.restauranteId, status: "FECHADO", id: { not: id } },
      orderBy: { fechadoEm: "desc" },
    });
    const dataCorte = turnoAnterior?.fechadoEm ?? new Date(0);

    const pedidosPagos = await prisma.pedido.findMany({
      where: { restauranteId: turno.restauranteId, pago: true, updatedAt: { gte: dataCorte } },
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

// ══ Promoções ══════════════════════════════════════════════════════════════════

router.get("/promocoes", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  if (!restauranteId) return res.status(400).json({ error: "restauranteId obrigatório" });
  try {
    const data = await prisma.promocao.findMany({ where: { restauranteId }, orderBy: { createdAt: "asc" } });
    res.json({ data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/promocoes", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  if (!restauranteId) return res.status(400).json({ error: "restauranteId obrigatório" });
  const { nome, descricao, precoPromocional, ativa, tipo, itens, regra, recorrencia, mostrarDelivery } = req.body;
  if (!nome) return res.status(400).json({ error: "nome obrigatório" });
  try {
    const data = await prisma.promocao.create({
      data: {
        restauranteId,
        nome,
        descricao: descricao || null,
        precoPromocional: precoPromocional != null ? parseFloat(precoPromocional) : null,
        ativa: ativa !== false,
        tipo: tipo || "MANUAL",
        itens: itens || [],
        regra: regra || {},
        recorrencia: Array.isArray(recorrencia) ? recorrencia : [],
        mostrarDelivery: mostrarDelivery !== false,
      },
    });
    res.json({ data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put("/promocoes/:id", async (req, res) => {
  const { id } = req.params;
  const { nome, descricao, precoPromocional, ativa, tipo, itens, regra, recorrencia, mostrarDelivery } = req.body;
  try {
    const existing = await prisma.promocao.findUnique({ where: { id }, select: { restauranteId: true } });
    if (!existing) return res.status(404).json({ error: "Promoção não encontrada" });
    if (denegarOutroTenant(req, res, existing.restauranteId)) return;
    const data = await prisma.promocao.update({
      where: { id },
      data: {
        ...(nome && { nome }),
        descricao: descricao ?? undefined,
        precoPromocional: precoPromocional != null ? parseFloat(precoPromocional) : null,
        ...(ativa !== undefined && { ativa }),
        ...(tipo !== undefined && { tipo }),
        ...(itens !== undefined && { itens }),
        ...(regra !== undefined && { regra }),
        ...(recorrencia !== undefined && { recorrencia: Array.isArray(recorrencia) ? recorrencia : [] }),
        ...(mostrarDelivery !== undefined && { mostrarDelivery }),
      },
    });
    res.json({ data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/promocoes/gerar-ia", async (req, res) => {
  const restauranteId = resolverRestauranteId(req);
  if (!restauranteId) return res.status(400).json({ error: "restauranteId obrigatório" });
  const { descricao, cardapio } = req.body;
  if (!descricao) return res.status(400).json({ error: "descricao obrigatória" });
  try {
    const cardapioTexto = (cardapio || []).map(cat =>
      `${cat.nome}: ${(cat.produtos || []).map(p => p.nome + (p.preco ? ` (${p.preco})` : '')).join(', ')}`
    ).join('\n');

    const systemPrompt = `Você é um assistente de restaurante especializado em criar promoções de vendas.
O usuário irá descrever uma promoção em linguagem natural e você deve retornar um JSON estruturado.

Cardápio disponível:
${cardapioTexto || '(não informado)'}

Responda APENAS com um JSON válido neste formato (sem texto extra):
{
  "nome": "Nome curto da promoção",
  "descricao": "Descrição clara para o cliente",
  "tipo": "DESCONTO" | "COMPRE_PAGUE" | "BRINDE" | "MANUAL",
  "regra": {
    // para DESCONTO: { "tipoDesconto": "%" | "fixo", "valor": número }
    // para COMPRE_PAGUE: { "comprarQtd": número, "pagarQtd": número }
    // para BRINDE: { "brindeNome": "nome do brinde", "brindeQtd": número }
    // para MANUAL: {}
  },
  "precoPromocional": número | null,
  "sugestaoItens": ["nome do produto 1", "nome do produto 2"]
}`;

    const response = await axios.post(
      `${process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1"}/chat/completions`,
      {
        model: "anthropic/claude-haiku-4-5",
        max_tokens: 512,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: descricao },
        ],
      },
      { headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" } }
    );

    const text = response.data.choices[0]?.message?.content || "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: "IA não retornou JSON válido" });

    const promo = JSON.parse(jsonMatch[0]);
    res.json({ data: promo });
  } catch (err) {
    console.error("[promo-ia]", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete("/promocoes/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await prisma.promocao.findUnique({ where: { id }, select: { restauranteId: true } });
    if (!existing) return res.status(404).json({ error: "Promoção não encontrada" });
    if (denegarOutroTenant(req, res, existing.restauranteId)) return;
    await prisma.promocao.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Garçons ───────────────────────────────────────────────────────────────────
const bcryptAdmin = require("bcryptjs");

router.get("/garcons/:restauranteId", authMiddleware, async (req, res) => {
  const garcons = await prisma.garcon.findMany({
    where: { restauranteId: req.params.restauranteId, ativo: true },
    select: { id: true, nome: true, telefone: true, cedula: true, cor: true, createdAt: true },
    orderBy: { nome: "asc" },
  });
  res.json({ data: garcons });
});

router.post("/garcons", authMiddleware, async (req, res) => {
  const { nome, telefone, cedula, cor, senha, restauranteId } = req.body;
  if (!nome || !senha || !restauranteId) return res.status(400).json({ error: "nome, senha e restauranteId são obrigatórios" });
  const senhaHash = await bcryptAdmin.hash(senha, 10);
  const garcon = await prisma.garcon.create({
    data: { nome: nome.trim(), telefone: telefone?.trim() || null, cedula: cedula?.trim() || null, cor: cor || "#6366f1", senhaHash, restauranteId },
  });
  res.json({ data: { id: garcon.id, nome: garcon.nome, telefone: garcon.telefone, cedula: garcon.cedula, cor: garcon.cor } });
});

router.put("/garcons/:id", authMiddleware, async (req, res) => {
  const { nome, telefone, cedula, cor, senha } = req.body;
  const data = {};
  if (nome) data.nome = nome.trim();
  if (telefone !== undefined) data.telefone = telefone?.trim() || null;
  if (cedula !== undefined) data.cedula = cedula?.trim() || null;
  if (cor) data.cor = cor;
  if (senha) data.senhaHash = await bcryptAdmin.hash(senha, 10);
  const garcon = await prisma.garcon.update({ where: { id: req.params.id }, data });
  res.json({ data: { id: garcon.id, nome: garcon.nome, telefone: garcon.telefone, cedula: garcon.cedula, cor: garcon.cor } });
});

router.delete("/garcons/:id", authMiddleware, async (req, res) => {
  await prisma.garcon.update({ where: { id: req.params.id }, data: { ativo: false } });
  res.json({ ok: true });
});

// ── Estações ──────────────────────────────────────────────────────────────────
router.get("/estacoes/:restauranteId", authMiddleware, async (req, res) => {
  try {
    const estacoes = await prisma.estacao.findMany({
      where: { restauranteId: req.params.restauranteId, ativo: true },
      select: { id: true, nome: true, tipo: true, cor: true, createdAt: true },
      orderBy: { nome: "asc" },
    });
    res.json({ data: estacoes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/estacoes", authMiddleware, async (req, res) => {
  try {
    const { nome, tipo, cor, senha, restauranteId } = req.body;
    if (!nome || !restauranteId) return res.status(400).json({ error: "nome e restauranteId são obrigatórios" });
    const data = { nome: nome.trim(), tipo: tipo || "GERAL", cor: cor || "#6366f1", restauranteId };
    if (senha) data.senhaHash = await bcryptAdmin.hash(senha, 10);
    const estacao = await prisma.estacao.create({ data });
    res.json({ data: { id: estacao.id, nome: estacao.nome, tipo: estacao.tipo, cor: estacao.cor } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put("/estacoes/:id", authMiddleware, async (req, res) => {
  try {
    const { nome, tipo, cor, senha } = req.body;
    const data = {};
    if (nome) data.nome = nome.trim();
    if (tipo) data.tipo = tipo;
    if (cor) data.cor = cor;
    if (senha) data.senhaHash = await bcryptAdmin.hash(senha, 10);
    const estacao = await prisma.estacao.update({ where: { id: req.params.id }, data });
    res.json({ data: { id: estacao.id, nome: estacao.nome, tipo: estacao.tipo, cor: estacao.cor } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete("/estacoes/:id", authMiddleware, async (req, res) => {
  try {
    await prisma.estacao.update({ where: { id: req.params.id }, data: { ativo: false } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Balcão ────────────────────────────────────────────────────────────────────
router.post("/pedidos/balcao", authMiddleware, async (req, res) => {
  const { itens, clienteNome, mesa, metodoPagamento, restauranteId } = req.body;
  const rid = restauranteId || resolverRestauranteId(req);
  if (!rid || !itens?.length) return res.status(400).json({ error: "restauranteId e itens obrigatórios" });
  const total = itens.reduce((s, i) => s + (i.preco * (i.quantidade || 1)), 0);
  const sessao = await prisma.sessao.create({
    data: { clienteNumero: `balcao-${Date.now()}`, clienteNome: clienteNome || "Balcão", restauranteId: rid, estado: "FINALIZADO" },
  });
  const numeroDia = await proximoNumeroDia(rid);
  const pedido = await prisma.pedido.create({
    data: {
      sessaoId: sessao.id, restauranteId: rid,
      clienteNumero: sessao.clienteNumero, clienteNome: clienteNome || "Balcão",
      itens, total, metodoPagamento: metodoPagamento || null,
      mesa: mesa ? Number(mesa) : null, origem: "BALCAO", numeroDia, status: "CONFIRMADO",
    },
    include: { restaurante: { select: { slugWhatsapp: true } } },
  });
  const io = req.app.get("io");
  io?.to("admin").emit("pedido:novo", pedido);
  if (pedido.restaurante?.slugWhatsapp) io?.to(`restaurante:${pedido.restaurante.slugWhatsapp}`).emit("pedido:novo", pedido);
  res.json({ data: pedido });
});

// ── Ticket reimpressão ────────────────────────────────────────────────────────
router.put("/pedidos/:id/ticket", authMiddleware, async (req, res) => {
  const { ticketHtml } = req.body;
  const existing = await prisma.pedido.findUnique({ where: { id: req.params.id }, select: { restauranteId: true } });
  if (!existing) return res.status(404).json({ error: "Pedido não encontrado" });
  if (denegarOutroTenant(req, res, existing.restauranteId)) return;
  await prisma.pedido.update({ where: { id: req.params.id }, data: { ticketHtml } });
  res.json({ ok: true });
});

// ── Factura Legal (Paraguay) ──────────────────────────────────────────────────
router.post("/facturas/proximo-numero", authMiddleware, async (req, res) => {
  const rid = resolverRestauranteId(req);
  if (!rid) return res.status(400).json({ error: "restauranteId obrigatório" });
  const rest = await prisma.restaurante.update({
    where: { id: rid },
    data: { faturaProximoNum: { increment: 1 } },
    select: { faturaProximoNum: true, faturaSerie: true, faturaTimbrado: true, faturaRuc: true, faturaRazaoSocial: true, faturaEndereco: true, faturaCiudad: true, faturaTelefone: true, faturaVencTimbrado: true, faturaInicioVigencia: true },
  });
  const num = rest.faturaProximoNum - 1; // consumed number
  const serie = rest.faturaSerie || "001-001";
  res.json({ numero: `${serie}-${String(num).padStart(7, "0")}`, timbrado: rest.faturaTimbrado || "", ruc: rest.faturaRuc, razaoSocial: rest.faturaRazaoSocial, endereco: rest.faturaEndereco, ciudad: rest.faturaCiudad, telefone: rest.faturaTelefone, vencTimbrado: rest.faturaVencTimbrado, inicioVigencia: rest.faturaInicioVigencia });
});

// ── Envio de link de acesso via WhatsApp ──────────────────────────────────────
function _gerarTokenAcesso(slug) {
  return crypto
    .createHmac("sha256", process.env.ADMIN_TOKEN || "secret")
    .update(slug)
    .digest("hex")
    .substring(0, 32);
}

router.post("/enviar-link-acesso", authMiddleware, async (req, res) => {
  const { telefone, tipo, restauranteId } = req.body;
  if (!telefone || !tipo || !restauranteId)
    return res.status(400).json({ error: "telefone, tipo e restauranteId obrigatórios" });

  const rest = await prisma.restaurante.findUnique({
    where: { id: restauranteId },
    select: { slugWhatsapp: true, instanceEvolution: true },
  });
  if (!rest) return res.status(404).json({ error: "Restaurante não encontrado" });

  const slug = rest.slugWhatsapp;
  const token = _gerarTokenAcesso(slug);
  const base = process.env.BOT_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  const instanceName = rest.instanceEvolution || slug;

  const links = {
    motoboy: `${base}/motoboy.html?slug=${slug}&t=${token}`,
    garcon:  `${base}/garcon.html?slug=${slug}&t=${token}`,
  };
  const nomes = { motoboy: "motoboy", garcon: "garçom" };

  const link = links[tipo];
  if (!link) return res.status(400).json({ error: "tipo inválido (motoboy ou garcon)" });

  const mensagem = `Olá! Aqui está o seu link de acesso ao painel de ${nomes[tipo]}:\n${link}\n\nFaça login com seu nome e senha cadastrados.`;

  try {
    await enviarMensagem(telefone, mensagem, instanceName);
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] erro ao enviar link via WA:", err.message);
    res.status(500).json({ error: "Erro ao enviar mensagem no WhatsApp" });
  }
});

// GET /admin/consultar-ruc/:ruc — proxy para turuc.com.py (evita CORS no browser)
router.get('/consultar-ruc/:ruc', authMiddleware, async (req, res) => {
  try {
    const ruc = req.params.ruc.replace(/[^0-9\-]/g, '');
    if (!ruc) return res.status(400).json({ error: 'RUC inválido' });
    const resp = await fetch(`https://turuc.com.py/api/contribuyente/${ruc}`);
    if (!resp.ok) return res.status(404).json({ error: 'RUC não encontrado' });
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao consultar RUC' });
  }
});

// ── Facturas emitidas (auditoria) ────────────────────────────────────────────

router.post('/facturas/salvar', authMiddleware, async (req, res) => {
  try {
    const rid = resolverRestauranteId(req);
    if (!rid) return res.status(400).json({ error: 'restauranteId obrigatório' });
    const { numero, timbrado, cliNome, cliRuc, cliDirec, cliTel, condicion, itens, total, iva5, iva10, origem, mesa } = req.body;
    if (!numero || total == null) return res.status(400).json({ error: 'numero e total obrigatórios' });
    const factura = await prisma.factura.create({
      data: {
        restauranteId: rid,
        numero,
        timbrado: timbrado || '',
        cliNome: cliNome || 'CONSUMIDOR FINAL',
        cliRuc: cliRuc || null,
        cliDirec: cliDirec || null,
        cliTel: cliTel || null,
        condicion: condicion || 'contado',
        itens: Array.isArray(itens) ? itens : [],
        total: Number(total),
        iva5: Number(iva5 || 0),
        iva10: Number(iva10 || 0),
        origem: origem || 'PEDIDO',
        mesa: mesa != null ? Number(mesa) : null,
      }
    });
    res.json(factura);
  } catch (e) {
    console.error('[admin] erro ao salvar factura:', e.message);
    res.status(500).json({ error: 'Erro ao salvar factura' });
  }
});

router.get('/facturas/historico', authMiddleware, async (req, res) => {
  try {
    const rid = resolverRestauranteId(req);
    if (!rid) return res.status(400).json({ error: 'restauranteId obrigatório' });
    const { pagina = 1, limite = 100, inicio, fim } = req.query;
    const where = { restauranteId: rid };
    if (inicio || fim) {
      where.createdAt = {};
      if (inicio) where.createdAt.gte = new Date(inicio);
      if (fim) where.createdAt.lte = new Date(fim + 'T23:59:59');
    }
    const [facturas, total] = await Promise.all([
      prisma.factura.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (Number(pagina) - 1) * Number(limite),
        take: Number(limite),
      }),
      prisma.factura.count({ where }),
    ]);
    res.json({ facturas, total });
  } catch (e) {
    console.error('[admin] erro ao listar facturas:', e.message);
    res.status(500).json({ error: 'Erro ao listar facturas' });
  }
});

module.exports = router;
