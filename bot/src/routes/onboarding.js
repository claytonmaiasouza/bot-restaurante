const { Router } = require("express");

const router = Router();

// Middleware de autenticação
router.use((req, res, next) => {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Não autorizado" });
  }
  next();
});

// Rota legada — redireciona para a nova rota admin
router.post("/restaurante", (req, res) => {
  res.status(301).json({
    error: "Esta rota foi descontinuada. Use POST /admin/restaurantes para criar restaurantes.",
  });
});

module.exports = router;
