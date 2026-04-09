const { Router } = require("express");
const { buscarRestaurante } = require("../services/strapiService");
const { sincronizarRestaurantes, invalidarCache } = require("../services/tenantService");
const {
  criarInstancia,
  obterQRCode,
  configurarWebhook,
} = require("../services/evolutionService");
const { PrismaClient } = require("@prisma/client");

const router = Router();
const prisma = new PrismaClient();

// ── Middleware: autenticação por token admin ───────────────────────────────────
router.use((req, res, next) => {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Não autorizado" });
  }
  next();
});

// ── POST /onboarding/restaurante ──────────────────────────────────────────────
/**
 * Registra um novo restaurante no sistema:
 * 1. Sincroniza dados do Strapi
 * 2. Cria instância na Evolution API
 * 3. Configura webhook automaticamente
 * 4. Retorna QR code para o dono escanear
 *
 * Body: { strapiId: number, slug: string }
 */
router.post("/restaurante", async (req, res) => {
  const { strapiId, slug } = req.body;

  if (!strapiId || !slug) {
    return res.status(400).json({ error: "strapiId e slug são obrigatórios" });
  }

  if (!/^\d{10,15}$/.test(slug)) {
    return res.status(400).json({
      error: "slug inválido — use apenas dígitos com DDI (ex: 5511999999999)",
    });
  }

  const webhookBaseUrl = process.env.BOT_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;

  try {
    // a) Busca dados no Strapi
    const strapiDados = await buscarRestaurante(slug);
    if (!strapiDados) {
      return res.status(404).json({ error: `Restaurante com slug "${slug}" não encontrado no Strapi` });
    }

    if (!strapiDados.ativo) {
      return res.status(400).json({ error: "Restaurante está inativo no Strapi" });
    }

    // b) Sincroniza no banco local
    const restaurante = await prisma.restaurante.upsert({
      where: { strapiId: strapiDados.id },
      update: {
        nome: strapiDados.nome,
        slugWhatsapp: strapiDados.slugWhatsapp,
        donoWhatsapp: strapiDados.donoWhatsapp,
        ativo: true,
      },
      create: {
        nome: strapiDados.nome,
        slugWhatsapp: strapiDados.slugWhatsapp,
        donoWhatsapp: strapiDados.donoWhatsapp,
        strapiId: strapiDados.id,
        ativo: true,
      },
    });

    // Invalida cache para garantir dados frescos
    invalidarCache(slug);

    // c) Cria instância na Evolution API
    await criarInstancia(restaurante);

    // d) Configura webhook automaticamente
    await configurarWebhook(restaurante.slugWhatsapp, webhookBaseUrl);

    // e) Obtém QR code para o dono escanear
    const qr = await obterQRCode(restaurante.slugWhatsapp);

    res.status(201).json({
      message: `Restaurante "${restaurante.nome}" cadastrado com sucesso!`,
      restaurante: {
        id: restaurante.id,
        nome: restaurante.nome,
        slug: restaurante.slugWhatsapp,
        webhookUrl: `${webhookBaseUrl}/webhook/${restaurante.slugWhatsapp}`,
      },
      qrcode: qr,
      instrucoes: [
        "1. Abra o WhatsApp Business no celular do restaurante",
        "2. Vá em Configurações → Dispositivos conectados → Conectar dispositivo",
        "3. Escaneie o QR code acima",
        "4. O bot estará ativo assim que a conexão for estabelecida",
      ],
    });
  } catch (err) {
    console.error("[onboarding] erro:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /onboarding/status/:slug ──────────────────────────────────────────────
/**
 * Verifica o status do onboarding de um restaurante específico.
 */
router.get("/status/:slug", async (req, res) => {
  const { slug } = req.params;

  try {
    const restaurante = await prisma.restaurante.findUnique({
      where: { slugWhatsapp: slug },
    });

    if (!restaurante) {
      return res.status(404).json({ error: "Restaurante não encontrado no banco local" });
    }

    const { verificarConexao } = require("../services/evolutionService");
    const conexao = await verificarConexao(slug);

    res.json({
      restaurante: {
        id: restaurante.id,
        nome: restaurante.nome,
        slug: restaurante.slugWhatsapp,
        ativo: restaurante.ativo,
      },
      whatsapp: conexao,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
