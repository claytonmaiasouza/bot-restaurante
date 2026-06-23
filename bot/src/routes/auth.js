const { Router } = require("express");
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const router = Router();
const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET || process.env.ADMIN_TOKEN;
const JWT_EXPIRY = "24h";

// ── POST /auth/login ──────────────────────────────────────────────────────────
// Aceita tanto proprietário (email) quanto usuário do painel (login)
router.post("/login", async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ error: "Email e senha são obrigatórios" });
  }

  try {
    // Tenta primeiro como proprietário do restaurante (por email)
    const restaurante = await prisma.restaurante.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: { id: true, nome: true, slugWhatsapp: true, senhaHash: true, ativo: true, email: true, moeda: true },
    });

    if (restaurante && restaurante.senhaHash) {
      if (!restaurante.ativo) {
        return res.status(403).json({ error: "Restaurante inativo" });
      }
      const senhaValida = await bcrypt.compare(senha, restaurante.senhaHash);
      if (!senhaValida) {
        return res.status(401).json({ error: "Credenciais inválidas" });
      }
      const token = jwt.sign(
        { restauranteId: restaurante.id, slug: restaurante.slugWhatsapp, role: "restaurante", email: restaurante.email },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
      );
      return res.json({
        token,
        role: "restaurante",
        restaurante: { id: restaurante.id, nome: restaurante.nome, slug: restaurante.slugWhatsapp, moeda: restaurante.moeda },
      });
    }

    // Tenta como usuário do painel (por login — pode ser qualquer string, não precisa ser email)
    const usuario = await prisma.usuarioPainel.findFirst({
      where: { login: email.trim() },
      include: { restaurante: { select: { id: true, nome: true, slugWhatsapp: true, moeda: true, ativo: true } } },
    });

    if (!usuario || !usuario.ativo) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }
    if (!usuario.restaurante.ativo) {
      return res.status(403).json({ error: "Restaurante inativo" });
    }
    const senhaValida = await bcrypt.compare(senha, usuario.senhaHash);
    if (!senhaValida) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }
    const token = jwt.sign(
      {
        restauranteId: usuario.restauranteId,
        slug: usuario.restaurante.slugWhatsapp,
        role: "caixa",
        usuarioId: usuario.id,
        permissoes: usuario.permissoes,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );
    return res.json({
      token,
      role: "caixa",
      usuario: { id: usuario.id, nome: usuario.nome, permissoes: usuario.permissoes },
      restaurante: { id: usuario.restaurante.id, nome: usuario.restaurante.nome, slug: usuario.restaurante.slugWhatsapp, moeda: usuario.restaurante.moeda },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /auth/definir-senha ──────────────────────────────────────────────────
// Chamado pelo super admin para criar/resetar senha de um restaurante
router.post("/definir-senha", async (req, res) => {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Não autorizado" });
  }

  const { restauranteId, email, senha } = req.body;
  if (!restauranteId || !email || !senha) {
    return res.status(400).json({ error: "restauranteId, email e senha são obrigatórios" });
  }
  if (senha.length < 6) {
    return res.status(400).json({ error: "Senha deve ter no mínimo 6 caracteres" });
  }

  try {
    const senhaHash = await bcrypt.hash(senha, 10);
    const atualizado = await prisma.restaurante.update({
      where: { id: restauranteId },
      data: { email: email.toLowerCase().trim(), senhaHash },
      select: { id: true, nome: true, email: true },
    });
    res.json({ data: atualizado });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Este email já está em uso" });
    if (err.code === "P2025") return res.status(404).json({ error: "Restaurante não encontrado" });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
