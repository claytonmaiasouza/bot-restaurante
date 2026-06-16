const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const { notificarStatusPedido, formatNumPedido, proximoNumeroDia } = require("../services/pedidoService");
const { enviarMensagem } = require("../services/evolutionService");

const router = express.Router();
const prisma = new PrismaClient();

// Localização em memória: pedidoId → { lat, lng, updatedAt }
const localizacoesMotoboys = new Map();

// ── Web Push ──────────────────────────────────────────────────────────────────
const VAPID_FILE = "/app/vapid-keys.json";
let _webpush = null;
let _vapidPublicKey = null;
// Push subscriptions em memória: motoboyId → { subscription, slug }
const motoboySubscriptions = new Map();

function getWebPush() {
  if (_webpush) return _webpush;
  try {
    const wp = require("web-push");
    let keys;
    try {
      keys = JSON.parse(require("fs").readFileSync(VAPID_FILE, "utf8"));
    } catch {
      keys = wp.generateVAPIDKeys();
      require("fs").writeFileSync(VAPID_FILE, JSON.stringify(keys));
      console.log("[push] VAPID keys geradas →", VAPID_FILE);
    }
    _vapidPublicKey = keys.publicKey;
    wp.setVapidDetails("mailto:admin@bot.guiafinanceiro.pro", keys.publicKey, keys.privateKey);
    _webpush = wp;
    return wp;
  } catch (err) {
    console.error("[push] web-push indisponível:", err.message);
    return null;
  }
}

function enviarPushMotoboys(slug, pedido) {
  const wp = getWebPush();
  if (!wp) return;
  const num = pedido.numeroDia ? `#${pedido.numeroDia}` : "";
  const payload = JSON.stringify({
    title: "🛵 Nova entrega disponível!",
    body: `Pedido ${num} pronto para despacho. Toque para aceitar.`,
    icon: "/icons/motoboy-icon.svg",
    badge: "/icons/motoboy-icon.svg",
    tag: `entrega-${pedido.id}`,
  });
  for (const [motoboyId, { subscription, slug: s }] of motoboySubscriptions) {
    if (s !== slug) continue;
    wp.sendNotification(subscription, payload).catch(() => {
      motoboySubscriptions.delete(motoboyId);
    });
  }
}

function gerarToken(slug) {
  return crypto
    .createHmac("sha256", process.env.ADMIN_TOKEN || "secret")
    .update(slug)
    .digest("hex")
    .substring(0, 32);
}

function validarToken(req, res, next) {
  const slug = req.query.slug || req.body?.slug;
  const token = req.query.t || req.body?.t;
  if (!slug || !token || token !== gerarToken(slug)) {
    return res.status(401).json({ error: "Token inválido" });
  }
  req.painelSlug = slug;
  next();
}

// GET /painel/token/:slug — gera os links para o admin compartilhar
router.get("/token/:slug", (req, res) => {
  const adminToken = req.headers["x-admin-token"];
  const authHeader = req.headers["authorization"];
  const isAdmin = adminToken === process.env.ADMIN_TOKEN;
  let isJwt = false;
  if (!isAdmin && authHeader?.startsWith("Bearer ")) {
    try {
      const jwt = require("jsonwebtoken");
      const payload = jwt.verify(
        authHeader.slice(7),
        process.env.JWT_SECRET || process.env.ADMIN_TOKEN
      );
      isJwt = !!payload.role;
    } catch {}
  }
  if (!isAdmin && !isJwt) return res.status(401).json({ error: "Não autorizado" });

  const token = gerarToken(req.params.slug);
  const base = process.env.BOT_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  res.json({
    token,
    cozinha: `${base}/cozinha.html?slug=${req.params.slug}&t=${token}`,
    motoboy: `${base}/motoboy.html?slug=${req.params.slug}&t=${token}`,
    garcon:  `${base}/garcon.html?slug=${req.params.slug}&t=${token}`,
  });
});

// GET /painel/motoboy/vapid-key — chave pública VAPID para subscrição push
router.get("/motoboy/vapid-key", validarToken, (req, res) => {
  const wp = getWebPush();
  if (!wp || !_vapidPublicKey) return res.status(503).json({ error: "Push não configurado" });
  res.json({ publicKey: _vapidPublicKey });
});

// POST /painel/motoboy/subscribe — registra subscription push do motoboy
router.post("/motoboy/subscribe", validarToken, async (req, res) => {
  const { motoboyId, subscription } = req.body;
  if (!motoboyId || !subscription?.endpoint)
    return res.status(400).json({ error: "motoboyId e subscription obrigatórios" });
  motoboySubscriptions.set(motoboyId, { subscription, slug: req.painelSlug });
  console.log(`[push] motoboy ${motoboyId} subscribed`);
  res.json({ ok: true });
});

// GET /painel/motoboy/manifest — manifest PWA dinâmico
router.get("/motoboy/manifest", validarToken, (req, res) => {
  const base = process.env.BOT_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  res.setHeader("Content-Type", "application/manifest+json");
  res.json({
    name: "Painel Repartidor",
    short_name: "Entregas",
    description: "Painel de entregas para repartidores",
    start_url: `/motoboy.html?slug=${req.painelSlug}&t=${req.query.t}`,
    display: "standalone",
    orientation: "portrait",
    background_color: "#f1f5f9",
    theme_color: "#f97316",
    icons: [
      { src: `${base}/icons/motoboy-icon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
    ],
  });
});

// GET /painel/garcon/manifest — manifest PWA dinâmico para garçom
router.get("/garcon/manifest", validarToken, (req, res) => {
  const base = process.env.BOT_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
  res.setHeader("Content-Type", "application/manifest+json");
  res.json({
    name: "Painel Garçom",
    short_name: "Garçom",
    description: "Painel de pedidos para garçons",
    start_url: `/garcon.html?slug=${req.painelSlug}&t=${req.query.t}`,
    display: "standalone",
    orientation: "portrait",
    background_color: "#4f46e5",
    theme_color: "#6366f1",
    icons: [
      { src: `${base}/icons/garcon-icon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
    ],
  });
});

// POST /painel/motoboy/cadastrar — motoboy se auto-cadastra via link compartilhado
router.post("/motoboy/cadastrar", validarToken, async (req, res) => {
  const { nome, telefone, cedula, placa, senha } = req.body;
  if (!nome || !telefone || !senha)
    return res.status(400).json({ error: "nome, telefone e senha são obrigatórios" });
  const restaurante = await prisma.restaurante.findFirst({
    where: { slugWhatsapp: req.painelSlug, ativo: true },
    select: { id: true },
  });
  if (!restaurante) return res.status(404).json({ error: "Restaurante não encontrado" });
  const normTel = (t) => t.replace(/\D/g, "");
  const senhaHash = await bcrypt.hash(senha, 10);
  const data = { nome: nome.trim(), telefone: normTel(telefone), restauranteId: restaurante.id, senhaHash };
  if (cedula) data.cedula = cedula.trim();
  if (placa) data.placa = placa.trim().toUpperCase();
  try {
    const motoboy = await prisma.motoboy.create({ data });
    res.json({ ok: true, id: motoboy.id, nome: motoboy.nome });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Repartidor já cadastrado com esse telefone." });
    res.status(500).json({ error: err.message });
  }
});

// GET /painel/motoboy/lista — lista motoboys ativos para o modal de login
router.get("/motoboy/lista", validarToken, async (req, res) => {
  const restaurante = await prisma.restaurante.findFirst({
    where: { slugWhatsapp: req.painelSlug, ativo: true },
    select: { id: true },
  });
  if (!restaurante) return res.status(404).json({ error: "Restaurante não encontrado" });
  const motoboys = await prisma.motoboy.findMany({
    where: { restauranteId: restaurante.id, ativo: true },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  res.json({ data: motoboys });
});

// POST /painel/motoboy/auth — autentica motoboy com senha
router.post("/motoboy/auth", validarToken, async (req, res) => {
  const { motoboyId, senha } = req.body;
  if (!motoboyId || !senha) return res.status(400).json({ error: "motoboyId e senha obrigatórios" });
  const restaurante = await prisma.restaurante.findFirst({
    where: { slugWhatsapp: req.painelSlug, ativo: true },
    select: { id: true },
  });
  if (!restaurante) return res.status(404).json({ error: "Restaurante não encontrado" });
  const motoboy = await prisma.motoboy.findFirst({
    where: { id: motoboyId, restauranteId: restaurante.id, ativo: true },
  });
  if (!motoboy) return res.status(401).json({ error: "Repartidor não encontrado" });
  if (!motoboy.senhaHash) return res.status(401).json({ error: "Senha não configurada. Contate o administrador." });
  const ok = await bcrypt.compare(senha, motoboy.senhaHash);
  if (!ok) return res.status(401).json({ error: "Senha incorreta" });
  res.json({ ok: true, id: motoboy.id, nome: motoboy.nome });
});

// GET /painel/pedidos — lista pedidos para cozinha ou motoboy
router.get("/pedidos", validarToken, async (req, res) => {
  const { tipo } = req.query;
  const restaurante = await prisma.restaurante.findFirst({
    where: { slugWhatsapp: req.painelSlug, ativo: true },
    select: { id: true, nome: true, moeda: true },
  });
  if (!restaurante) return res.status(404).json({ error: "Restaurante não encontrado" });

  let statusFiltro;
  let whereExtra = {};

  if (tipo === "motoboy") {
    statusFiltro = ["AGUARDANDO_DESPACHO", "EM_CAMINHO"];
  } else if (tipo === "historico") {
    statusFiltro = ["CONFIRMADO", "PAGO", "PREPARANDO", "PRONTO_PARA_RETIRADA", "AGUARDANDO_DESPACHO", "EM_CAMINHO", "ENTREGUE", "CANCELADO"];
    const agora = new Date();
    const inicioDia = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 5, 0, 0, 0));
    if (agora < inicioDia) inicioDia.setUTCDate(inicioDia.getUTCDate() - 1);
    whereExtra = { createdAt: { gte: inicioDia } };
  } else if (tipo === "motoboy-historico") {
    statusFiltro = ["ENTREGUE"];
    const trintaDiasAtras = new Date();
    trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);
    whereExtra = { createdAt: { gte: trintaDiasAtras } };
    if (req.query.motoboyId) whereExtra.motoboyId = req.query.motoboyId;
  } else {
    statusFiltro = ["CONFIRMADO", "PAGO", "PREPARANDO"];
  }

  const pedidos = await prisma.pedido.findMany({
    where: { restauranteId: restaurante.id, status: { in: statusFiltro }, ...whereExtra },
    orderBy: (tipo === "historico" || tipo === "motoboy-historico") ? { createdAt: "desc" } : { createdAt: "asc" },
    select: {
      id: true, numeroDia: true, origem: true, status: true,
      clienteNome: true, clienteNumero: true, localizacao: true,
      itens: true, total: true, metodoPagamento: true, mesa: true,
      motoboyNome: true, motoboyId: true, createdAt: true, comprovanteUrl: true,
    },
  });

  // Para motoboy: inclui pedidos ENTREGUE+!pago+dinheiro que ainda precisam de devolução
  let pendenteDevolucao = [];
  if (tipo === "motoboy" && req.query.motoboyId) {
    pendenteDevolucao = await prisma.pedido.findMany({
      where: {
        restauranteId: restaurante.id,
        status: "ENTREGUE",
        pago: false,
        motoboyId: req.query.motoboyId,
        metodoPagamento: { contains: "dinheiro", mode: "insensitive" },
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, numeroDia: true, origem: true, status: true,
        clienteNome: true, localizacao: true,
        itens: true, total: true, metodoPagamento: true,
        motoboyNome: true, motoboyId: true, createdAt: true,
      },
    });
  }

  res.json({ data: pedidos, pendenteDevolucao: pendenteDevolucao.length > 0 ? pendenteDevolucao : undefined, restaurante });
});

// POST /painel/pedidos/:id/iniciar — CONFIRMADO → PREPARANDO
router.post("/pedidos/:id/iniciar", validarToken, async (req, res) => {
  const pedido = await prisma.pedido.update({
    where: { id: req.params.id },
    data: { status: "PREPARANDO" },
    include: { restaurante: { select: { nome: true, slugWhatsapp: true, moeda: true, taxaEntrega: true } } },
  });
  const io = req.app.get("io");
  io?.to("admin").emit("pedido:atualizado", pedido);
  io?.to(`restaurante:${req.painelSlug}`).emit("pedido:atualizado", pedido);
  notificarStatusPedido(req.params.id, "PREPARANDO").catch(() => {});
  res.json({ ok: true });
});

// POST /painel/pedidos/:id/pronto — PREPARANDO → PRONTO_PARA_RETIRADA (retirada/mesa) ou AGUARDANDO_DESPACHO (delivery)
router.post("/pedidos/:id/pronto", validarToken, async (req, res) => {
  const atual = await prisma.pedido.findUnique({
    where: { id: req.params.id },
    select: { localizacao: true, origem: true, garconId: true },
  });
  const isRetirada =
    !atual.localizacao ||
    atual.localizacao === "Retirada no balcão" ||
    atual.origem === "MESA";
  const novoStatus = isRetirada ? "PRONTO_PARA_RETIRADA" : "AGUARDANDO_DESPACHO";
  const pedido = await prisma.pedido.update({
    where: { id: req.params.id },
    data: { status: novoStatus },
    select: { id: true, mesa: true, itens: true, numeroDia: true, garconId: true, status: true, localizacao: true, origem: true, total: true, metodoPagamento: true },
  });
  const io = req.app.get("io");
  io?.to("admin").emit("pedido:atualizado", pedido);
  io?.to(`restaurante:${req.painelSlug}`).emit("pedido:atualizado", pedido);
  notificarStatusPedido(req.params.id, novoStatus).catch(() => {});
  if (novoStatus === "AGUARDANDO_DESPACHO") enviarPushMotoboys(req.painelSlug, pedido);
  // Notifica o garçom pessoalmente quando pedido de mesa fica pronto
  if (novoStatus === "PRONTO_PARA_RETIRADA" && pedido.garconId) {
    io?.to(`garcon:${pedido.garconId}`).emit("pedido:pronto", {
      id: pedido.id,
      mesa: pedido.mesa,
      itens: pedido.itens,
      garconId: pedido.garconId,
      numeroDia: pedido.numeroDia,
    });
  }
  res.json({ ok: true, status: novoStatus });
});

// POST /painel/pedidos/:id/localizacao — motoboy envia coordenadas GPS
router.post("/pedidos/:id/localizacao", validarToken, (req, res) => {
  const lat = parseFloat(req.body?.lat);
  const lng = parseFloat(req.body?.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: "lat e lng obrigatórios" });
  localizacoesMotoboys.set(req.params.id, { lat, lng, updatedAt: new Date() });
  const io = req.app.get("io");
  io?.to(`rastrear:${req.params.id}`).emit("motoboy:localizacao", { lat, lng });
  res.json({ ok: true });
});

// GET /painel/rastrear/:id — público, retorna info do pedido + última localização conhecida
router.get("/rastrear/:id", async (req, res) => {
  const pedido = await prisma.pedido.findUnique({
    where: { id: req.params.id },
    select: {
      id: true, numeroDia: true, status: true, motoboyNome: true, clienteNome: true,
      restaurante: { select: { nome: true } },
    },
  });
  if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });
  const localizacao = localizacoesMotoboys.get(req.params.id) || null;
  res.json({ pedido, localizacao });
});

// POST /painel/pedidos/:id/aceitar — motoboy aceita entrega → EM_CAMINHO
router.post("/pedidos/:id/aceitar", validarToken, async (req, res) => {
  const { motoboyId } = req.body;
  if (!motoboyId) return res.status(400).json({ error: "motoboyId obrigatório" });

  const restaurante = await prisma.restaurante.findFirst({
    where: { slugWhatsapp: req.painelSlug, ativo: true },
    select: { id: true },
  });

  // Verifica se o pedido ainda está disponível (evita aceite simultâneo)
  const atual = await prisma.pedido.findUnique({
    where: { id: req.params.id },
    select: { status: true, motoboyId: true },
  });
  if (!atual || atual.status !== "AGUARDANDO_DESPACHO" || atual.motoboyId) {
    return res.status(409).json({ error: "Este pedido já foi aceito por outro repartidor." });
  }

  const motoboy = await prisma.motoboy.findFirst({
    where: { id: motoboyId, restauranteId: restaurante?.id },
    select: { nome: true },
  });

  const pedido = await prisma.pedido.update({
    where: { id: req.params.id },
    data: {
      motoboyId,
      motoboyNome: motoboy?.nome || motoboyId,
      status: "EM_CAMINHO",
    },
  });
  const io = req.app.get("io");
  io?.to("admin").emit("pedido:atualizado", pedido);
  io?.to(`restaurante:${req.painelSlug}`).emit("pedido:atualizado", pedido);
  io?.to(`rastrear:${req.params.id}`).emit("pedido:atualizado", { status: "EM_CAMINHO" });
  notificarStatusPedido(req.params.id, "EM_CAMINHO").catch(() => {});
  res.json({ ok: true });
});

// POST /painel/pedidos/:id/solicitar-troco — motoboy solicita troco ao caixa
router.post("/pedidos/:id/solicitar-troco", validarToken, async (req, res) => {
  const { motoboyId, motoboyNome } = req.body;
  const pedido = await prisma.pedido.findUnique({
    where: { id: req.params.id },
    select: { id: true, numeroDia: true, metodoPagamento: true, total: true },
  });
  if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });

  const io = req.app.get("io");
  const payload = { pedidoId: pedido.id, numeroDia: pedido.numeroDia, motoboyId, motoboyNome, metodoPagamento: pedido.metodoPagamento };
  console.log(`[painel] troco solicitado por ${motoboyNome} — emitindo para restaurante:${req.painelSlug}`, payload);
  io?.to(`restaurante:${req.painelSlug}`).to("admin").emit("caixa:troco-solicitado", payload);
  res.json({ ok: true });
});

// POST /painel/pedidos/:id/solicitar-devolucao — motoboy chegou ao restaurante, quer devolver o dinheiro
router.post("/pedidos/:id/solicitar-devolucao", validarToken, async (req, res) => {
  const { motoboyId, motoboyNome, total } = req.body;
  const pedido = await prisma.pedido.findUnique({
    where: { id: req.params.id },
    select: { id: true, numeroDia: true, metodoPagamento: true, total: true },
  });
  if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });
  const io = req.app.get("io");
  const payload = { pedidoId: pedido.id, numeroDia: pedido.numeroDia, motoboyId, motoboyNome, total: pedido.total, metodoPagamento: pedido.metodoPagamento };
  console.log(`[painel] devolução solicitada por ${motoboyNome} — pedido ${pedido.id} — emitindo para restaurante:${req.painelSlug}`);
  io?.to(`restaurante:${req.painelSlug}`).to("admin").emit("caixa:devolucao-solicitada", payload);
  res.json({ ok: true });
});

// POST /painel/pedidos/:id/confirmar-retirada-troco — motoboy confirma que retirou o troco
router.post("/pedidos/:id/confirmar-retirada-troco", validarToken, async (req, res) => {
  const { motoboyId } = req.body;
  const io = req.app.get("io");
  io?.to(`restaurante:${req.painelSlug}`).to("admin").emit("caixa:troco-retirado", {
    pedidoId: req.params.id,
    motoboyId,
  });
  res.json({ ok: true });
});

// POST /painel/pedidos/:id/entregar — motoboy confirma entrega → ENTREGUE
router.post("/pedidos/:id/entregar", validarToken, async (req, res) => {
  const atual = await prisma.pedido.findUnique({
    where: { id: req.params.id },
    select: { metodoPagamento: true, pago: true, comprovanteUrl: true, clienteNumero: true, sessaoId: true, localizacao: true, origem: true },
  });

  const isTransferencia = (mp) => mp && /transf/i.test(mp);
  const isDinheiroDelivery = atual && /dinheiro/i.test(atual.metodoPagamento || "") &&
    atual.localizacao !== "Retirada no balcão" && atual.origem !== "MESA";
  // Dinheiro delivery: aguarda retorno físico do motoboy ao caixa antes de marcar pago
  const confirmarPago = atual && !atual.pago && !isTransferencia(atual.metodoPagamento) && !isDinheiroDelivery;

  const pedido = await prisma.pedido.update({
    where: { id: req.params.id },
    data: { status: "ENTREGUE", ...(confirmarPago ? { pago: true } : {}) },
    include: { restaurante: { select: { nome: true, slugWhatsapp: true, moeda: true, taxaEntrega: true } } },
  });

  const io = req.app.get("io");
  io?.to("admin").emit("pedido:atualizado", pedido);
  io?.to(`restaurante:${req.painelSlug}`).emit("pedido:atualizado", pedido);
  io?.to(`rastrear:${req.params.id}`).emit("pedido:atualizado", { status: "ENTREGUE" });
  notificarStatusPedido(req.params.id, "ENTREGUE").catch(() => {});

  // Encerra a conversa no painel admin agora que a entrega foi confirmada
  if (atual?.sessaoId) {
    io?.to("admin").emit("conversa:encerrada", { sessaoId: atual.sessaoId });
  }

  // Transferência sem comprovante: pede comprovante ao cliente
  if (atual && isTransferencia(atual.metodoPagamento) && !atual.pago && !atual.comprovanteUrl) {
    const numFmt = formatNumPedido(pedido);
    const msgComp = `🧾 Seu pedido *#${numFmt}* foi entregue! Para confirmarmos o pagamento, por favor envie o comprovante de transferência aqui. Obrigado!`;
    enviarMensagem(atual.clienteNumero, msgComp, pedido.restaurante.slugWhatsapp).catch(() => {});
  }

  res.json({ ok: true });
});

// ── Garçom ───────────────────────────────────────────────────────────────────

// GET /painel/garcon/lista
router.get("/garcon/lista", validarToken, async (req, res) => {
  const rest = await prisma.restaurante.findFirst({ where: { slugWhatsapp: req.painelSlug, ativo: true }, select: { id: true } });
  if (!rest) return res.status(404).json({ error: "Restaurante não encontrado" });
  const garcons = await prisma.garcon.findMany({
    where: { restauranteId: rest.id, ativo: true },
    select: { id: true, nome: true, cor: true },
    orderBy: { nome: "asc" },
  });
  res.json({ data: garcons });
});

// POST /painel/garcon/auth
router.post("/garcon/auth", validarToken, async (req, res) => {
  const { garconId, senha } = req.body;
  if (!garconId || !senha) return res.status(400).json({ error: "garconId e senha obrigatórios" });
  const rest = await prisma.restaurante.findFirst({ where: { slugWhatsapp: req.painelSlug, ativo: true }, select: { id: true } });
  if (!rest) return res.status(404).json({ error: "Restaurante não encontrado" });
  const garcon = await prisma.garcon.findFirst({ where: { id: garconId, restauranteId: rest.id, ativo: true } });
  if (!garcon) return res.status(401).json({ error: "Garçom não encontrado" });
  if (!garcon.senhaHash) return res.status(401).json({ error: "Senha não configurada. Contate o administrador." });
  const ok = await bcrypt.compare(senha, garcon.senhaHash);
  if (!ok) return res.status(401).json({ error: "Senha incorreta" });
  res.json({ ok: true, id: garcon.id, nome: garcon.nome, cor: garcon.cor });
});

// GET /painel/garcon/cardapio
router.get("/garcon/cardapio", validarToken, async (req, res) => {
  const rest = await prisma.restaurante.findFirst({ where: { slugWhatsapp: req.painelSlug, ativo: true }, select: { id: true, moeda: true } });
  if (!rest) return res.status(404).json({ error: "Restaurante não encontrado" });
  const categorias = await prisma.categoria.findMany({
    where: { restauranteId: rest.id, ativo: true },
    include: { produtos: { where: { ativo: true }, include: { tamanhos: true }, orderBy: { nome: "asc" } } },
    orderBy: { ordem: "asc" },
  });
  res.json({ data: categorias, moeda: rest.moeda });
});

// GET /painel/garcon/mesas
router.get("/garcon/mesas", validarToken, async (req, res) => {
  const rest = await prisma.restaurante.findFirst({ where: { slugWhatsapp: req.painelSlug, ativo: true }, select: { id: true, moeda: true } });
  if (!rest) return res.status(404).json({ error: "Restaurante não encontrado" });
  const pedidos = await prisma.pedido.findMany({
    where: { restauranteId: rest.id, origem: "MESA", status: { notIn: ["ENTREGUE", "CANCELADO"] } },
    select: { id: true, mesa: true, itens: true, total: true, status: true, garconId: true, garconNome: true, garconCor: true, createdAt: true },
    orderBy: { mesa: "asc" },
  });
  res.json({ data: pedidos, moeda: rest.moeda });
});

// POST /painel/garcon/mesas — abre nova mesa
router.post("/garcon/mesas", validarToken, async (req, res) => {
  const { mesa, garconId, garconNome, garconCor } = req.body;
  if (!mesa) return res.status(400).json({ error: "mesa obrigatório" });
  const rest = await prisma.restaurante.findFirst({ where: { slugWhatsapp: req.painelSlug, ativo: true }, select: { id: true } });
  if (!rest) return res.status(404).json({ error: "Restaurante não encontrado" });
  const existing = await prisma.pedido.findFirst({
    where: { restauranteId: rest.id, mesa: Number(mesa), origem: "MESA", status: { notIn: ["ENTREGUE", "CANCELADO"] } },
    select: { id: true, mesa: true, itens: true, total: true, status: true, garconId: true, garconNome: true, garconCor: true },
  });
  if (existing) return res.status(409).json({ error: "Mesa já aberta", data: existing });
  const sessao = await prisma.sessao.create({
    data: { clienteNumero: `mesa-${mesa}`, clienteNome: `Mesa ${mesa}`, restauranteId: rest.id, estado: "FINALIZADO", carrinho: [] },
  });
  const numeroDia = await proximoNumeroDia(rest.id).catch(() => null);
  const pedido = await prisma.pedido.create({
    data: {
      sessaoId: sessao.id, restauranteId: rest.id,
      clienteNumero: `mesa-${mesa}`, clienteNome: `Mesa ${mesa}`,
      itens: [], total: 0, status: "CONFIRMADO",
      mesa: Number(mesa), origem: "MESA", numeroDia,
      garconId: garconId || null, garconNome: garconNome || null, garconCor: garconCor || null,
    },
  });
  const io = req.app.get("io");
  io?.to("admin").emit("pedido:novo", pedido);
  io?.to(`restaurante:${req.painelSlug}`).emit("pedido:novo", pedido);
  res.json({ ok: true, data: pedido });
});

// POST /painel/garcon/mesas/:pedidoId/itens — adiciona itens a uma mesa aberta
router.post("/garcon/mesas/:pedidoId/itens", validarToken, async (req, res) => {
  const { itens, garconId, garconNome, garconCor } = req.body;
  if (!itens?.length) return res.status(400).json({ error: "itens obrigatórios" });
  const pedido = await prisma.pedido.findUnique({
    where: { id: req.params.pedidoId },
    select: { itens: true, total: true, garconId: true },
  });
  if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });
  const itensAtuais = Array.isArray(pedido.itens) ? pedido.itens : [];
  const totalExtra = itens.reduce((s, i) => s + i.preco * i.quantidade, 0);
  const data = { itens: [...itensAtuais, ...itens], total: pedido.total + totalExtra };
  if (!pedido.garconId && garconId) { data.garconId = garconId; data.garconNome = garconNome; data.garconCor = garconCor; }
  const updated = await prisma.pedido.update({ where: { id: req.params.pedidoId }, data });
  const io = req.app.get("io");
  io?.to("admin").emit("pedido:atualizado", updated);
  io?.to(`restaurante:${req.painelSlug}`).emit("pedido:atualizado", updated);
  res.json({ ok: true, data: updated });
});

// POST /painel/garcon/mesas/:pedidoId/solicitar-fechamento
router.post("/garcon/mesas/:pedidoId/solicitar-fechamento", validarToken, async (req, res) => {
  const { garconId, garconNome, garconCor } = req.body;
  const pedido = await prisma.pedido.findUnique({
    where: { id: req.params.pedidoId },
    select: { id: true, numeroDia: true, mesa: true, total: true, itens: true },
  });
  if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });
  const io = req.app.get("io");
  io?.to("admin").to(`restaurante:${req.painelSlug}`).emit("garcon:solicitar-fechamento", {
    pedidoId: pedido.id, numeroDia: pedido.numeroDia, mesa: pedido.mesa,
    total: pedido.total, garconId, garconNome, garconCor,
  });
  res.json({ ok: true });
});

// GET /painel/garcon/prontos — pedidos PRONTO_PARA_RETIRADA do garçom logado
router.get("/garcon/prontos", validarToken, async (req, res) => {
  const { garconId } = req.query;
  if (!garconId) return res.json({ data: [] });
  const rest = await prisma.restaurante.findFirst({ where: { slugWhatsapp: req.painelSlug, ativo: true }, select: { id: true } });
  if (!rest) return res.status(404).json({ error: "Restaurante não encontrado" });
  const pedidos = await prisma.pedido.findMany({
    where: { restauranteId: rest.id, garconId, status: "PRONTO_PARA_RETIRADA" },
    select: { id: true, mesa: true, itens: true, numeroDia: true, garconId: true },
    orderBy: { createdAt: "asc" },
  });
  res.json({ data: pedidos });
});

// PUT /painel/pedidos/:id/servir — garçom marca pedido como entregue à mesa
router.put("/pedidos/:id/servir", validarToken, async (req, res) => {
  const { id } = req.params;
  const rest = await prisma.restaurante.findFirst({ where: { slugWhatsapp: req.painelSlug, ativo: true }, select: { id: true, slugWhatsapp: true } });
  if (!rest) return res.status(404).json({ error: "Restaurante não encontrado" });
  const atual = await prisma.pedido.findUnique({ where: { id }, select: { restauranteId: true, status: true } });
  if (!atual) return res.status(404).json({ error: "Pedido não encontrado" });
  if (atual.restauranteId !== rest.id) return res.status(403).json({ error: "Sem permissão" });
  if (atual.status !== "PRONTO_PARA_RETIRADA") return res.status(400).json({ error: "Pedido não está pronto" });
  const pedido = await prisma.pedido.update({
    where: { id },
    data: { status: "ENTREGUE" },
    include: { restaurante: { select: { slugWhatsapp: true } } },
  });
  const io = req.app.get("io");
  io?.to("admin").emit("pedido:atualizado", pedido);
  io?.to(`restaurante:${rest.slugWhatsapp}`).emit("pedido:atualizado", pedido);
  res.json({ ok: true });
});

module.exports = router;
