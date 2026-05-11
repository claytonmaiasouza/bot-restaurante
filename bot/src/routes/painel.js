const express = require("express");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");

const router = express.Router();
const prisma = new PrismaClient();

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
  });
});

// GET /painel/pedidos — lista pedidos para cozinha ou motoboy
router.get("/pedidos", validarToken, async (req, res) => {
  const { tipo } = req.query;
  const restaurante = await prisma.restaurante.findFirst({
    where: { slugWhatsapp: req.painelSlug, ativo: true },
    select: { id: true, nome: true, moeda: true },
  });
  if (!restaurante) return res.status(404).json({ error: "Restaurante não encontrado" });

  const statusFiltro =
    tipo === "motoboy" ? ["SAIU_PARA_ENTREGA"] : ["CONFIRMADO", "PREPARANDO"];

  const pedidos = await prisma.pedido.findMany({
    where: { restauranteId: restaurante.id, status: { in: statusFiltro } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, numeroDia: true, origem: true, status: true,
      clienteNome: true, clienteNumero: true, localizacao: true,
      itens: true, total: true, metodoPagamento: true, mesa: true,
      motoboyNome: true, createdAt: true,
    },
  });

  res.json({ data: pedidos, restaurante });
});

// POST /painel/pedidos/:id/iniciar — CONFIRMADO → PREPARANDO
router.post("/pedidos/:id/iniciar", validarToken, async (req, res) => {
  const pedido = await prisma.pedido.update({
    where: { id: req.params.id },
    data: { status: "PREPARANDO" },
  });
  const io = req.app.get("io");
  io?.to("admin").emit("pedido:status", { pedidoId: pedido.id, status: "PREPARANDO" });
  io?.to(`restaurante:${req.painelSlug}`).emit("pedido:status", { pedidoId: pedido.id, status: "PREPARANDO" });
  res.json({ ok: true });
});

// POST /painel/pedidos/:id/pronto — PREPARANDO → PRONTO_PARA_RETIRADA ou SAIU_PARA_ENTREGA
router.post("/pedidos/:id/pronto", validarToken, async (req, res) => {
  const atual = await prisma.pedido.findUnique({
    where: { id: req.params.id },
    select: { localizacao: true, origem: true },
  });
  const isRetirada =
    !atual.localizacao ||
    atual.localizacao === "Retirada no balcão" ||
    atual.origem === "MESA";
  const novoStatus = isRetirada ? "PRONTO_PARA_RETIRADA" : "SAIU_PARA_ENTREGA";
  const pedido = await prisma.pedido.update({
    where: { id: req.params.id },
    data: { status: novoStatus },
  });
  const io = req.app.get("io");
  io?.to("admin").emit("pedido:status", { pedidoId: pedido.id, status: novoStatus });
  io?.to(`restaurante:${req.painelSlug}`).emit("pedido:status", { pedidoId: pedido.id, status: novoStatus });
  res.json({ ok: true, status: novoStatus });
});

// POST /painel/pedidos/:id/aceitar — motoboy aceita entrega
router.post("/pedidos/:id/aceitar", validarToken, async (req, res) => {
  const { motoboyNome } = req.body;
  if (!motoboyNome?.trim()) return res.status(400).json({ error: "motoboyNome obrigatório" });
  const pedido = await prisma.pedido.update({
    where: { id: req.params.id },
    data: { motoboyNome: motoboyNome.trim() },
  });
  const io = req.app.get("io");
  io?.to("admin").emit("pedido:motoboy", { pedidoId: pedido.id, motoboyNome: pedido.motoboyNome });
  res.json({ ok: true });
});

// POST /painel/pedidos/:id/entregar — motoboy confirma entrega → ENTREGUE
router.post("/pedidos/:id/entregar", validarToken, async (req, res) => {
  const pedido = await prisma.pedido.update({
    where: { id: req.params.id },
    data: { status: "ENTREGUE", pago: true },
  });
  const io = req.app.get("io");
  io?.to("admin").emit("pedido:status", { pedidoId: pedido.id, status: "ENTREGUE" });
  io?.to(`restaurante:${req.painelSlug}`).emit("pedido:status", { pedidoId: pedido.id, status: "ENTREGUE" });
  res.json({ ok: true });
});

module.exports = router;
