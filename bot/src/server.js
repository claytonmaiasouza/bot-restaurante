require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createServer } = require("http");
const { Server } = require("socket.io");

const webhookController = require("./controllers/webhookController");
const adminRoutes = require("./routes/admin");
const onboardingRoutes = require("./routes/onboarding");
const { tenantMiddleware } = require("./middleware/tenantMiddleware");
const { iniciarJobs } = require("./jobs/limpeza");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

app.use(cors());
app.use(express.json());

// Expõe o io para uso nos controllers
app.set("io", io);

// ── Middleware de autenticação do webhook (Evolution API) ─────────────────────
function validarWebhook(req, res, next) {
  const apiKey = req.headers["apikey"] || req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.EVOLUTION_API_KEY) {
    return res.status(401).json({ error: "Não autorizado" });
  }
  next();
}

// ── Rotas ─────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Webhook da Evolution API:
// 1. valida a chave de API da Evolution
// 2. tenantMiddleware resolve o restaurante e injeta req.restaurante + req.cardapio
// 3. controller processa a mensagem
app.post(
  "/webhook/:restauranteSlug",
  validarWebhook,
  tenantMiddleware,
  webhookController.receberMensagem
);

// Onboarding de novos restaurantes
app.use("/onboarding", onboardingRoutes);

// Rotas administrativas internas
app.use("/admin", adminRoutes);

// ── Socket.IO — eventos em tempo real ─────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[socket] conectado: ${socket.id}`);

  // Permite que o dono do restaurante acompanhe pedidos do seu slug
  socket.on("assinar", (slug) => {
    socket.join(`restaurante:${slug}`);
    console.log(`[socket] ${socket.id} assinou restaurante:${slug}`);
  });

  socket.on("disconnect", () => {
    console.log(`[socket] desconectado: ${socket.id}`);
  });
});

// ── Jobs agendados ────────────────────────────────────────────────────────────
iniciarJobs();

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`[server] bot-restaurante rodando na porta ${PORT}`);
});

module.exports = { app, io };
