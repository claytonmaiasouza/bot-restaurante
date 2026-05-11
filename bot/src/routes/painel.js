const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const { notificarStatusPedido } = require("../services/pedidoService");

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

  const statusFiltro =
    tipo === "motoboy"
      ? ["AGUARDANDO_DESPACHO", "EM_CAMINHO"]
      : ["CONFIRMADO", "PREPARANDO"];

  const pedidos = await prisma.pedido.findMany({
    where: { restauranteId: restaurante.id, status: { in: statusFiltro } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, numeroDia: true, origem: true, status: true,
      clienteNome: true, clienteNumero: true, localizacao: true,
      itens: true, total: true, metodoPagamento: true, mesa: true,
      motoboyNome: true, motoboyId: true, createdAt: true, comprovanteUrl: true,
    },
  });

  res.json({ data: pedidos, restaurante });
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
    select: { localizacao: true, origem: true },
  });
  const isRetirada =
    !atual.localizacao ||
    atual.localizacao === "Retirada no balcão" ||
    atual.origem === "MESA";
  const novoStatus = isRetirada ? "PRONTO_PARA_RETIRADA" : "AGUARDANDO_DESPACHO";
  const pedido = await prisma.pedido.update({
    where: { id: req.params.id },
    data: { status: novoStatus },
  });
  const io = req.app.get("io");
  io?.to("admin").emit("pedido:atualizado", pedido);
  io?.to(`restaurante:${req.painelSlug}`).emit("pedido:atualizado", pedido);
  notificarStatusPedido(req.params.id, novoStatus).catch(() => {});
  res.json({ ok: true, status: novoStatus });
});

// POST /painel/pedidos/:id/aceitar — motoboy aceita entrega → EM_CAMINHO
router.post("/pedidos/:id/aceitar", validarToken, async (req, res) => {
  const { motoboyId } = req.body;
  if (!motoboyId) return res.status(400).json({ error: "motoboyId obrigatório" });

  const restaurante = await prisma.restaurante.findFirst({
    where: { slugWhatsapp: req.painelSlug, ativo: true },
    select: { id: true },
  });
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
  notificarStatusPedido(req.params.id, "EM_CAMINHO").catch(() => {});
  res.json({ ok: true });
});

// POST /painel/pedidos/:id/entregar — motoboy confirma entrega → ENTREGUE
router.post("/pedidos/:id/entregar", validarToken, async (req, res) => {
  const pedido = await prisma.pedido.update({
    where: { id: req.params.id },
    data: { status: "ENTREGUE", pago: true },
    include: { restaurante: { select: { nome: true, slugWhatsapp: true, moeda: true, taxaEntrega: true } } },
  });
  const io = req.app.get("io");
  io?.to("admin").emit("pedido:atualizado", pedido);
  io?.to(`restaurante:${req.painelSlug}`).emit("pedido:atualizado", pedido);
  notificarStatusPedido(req.params.id, "ENTREGUE").catch(() => {});
  res.json({ ok: true });
});

module.exports = router;
