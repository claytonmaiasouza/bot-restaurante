const { Router } = require("express");
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const router = Router();
const prisma = new PrismaClient();

const JWT_SECRET = process.env.JWT_SECRET || process.env.ADMIN_TOKEN;
const JWT_EXPIRY = "24h";

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ error: "Email e senha são obrigatórios" });
  }

  try {
    const restaurante = await prisma.restaurante.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: { id: true, nome: true, slugWhatsapp: true, senhaHash: true, ativo: true, email: true },
    });

    if (!restaurante || !restaurante.senhaHash) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

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

    res.json({
      token,
      restaurante: { id: restaurante.id, nome: restaurante.nome, slug: restaurante.slugWhatsapp },
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
