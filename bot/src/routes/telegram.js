const { Router } = require("express");
const { receberUpdateTelegram } = require("../controllers/telegramController");

const router = Router();

function validarTelegram(req, res, next) {
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (!secret || secret !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Não autorizado" });
  }
  next();
}

router.post("/webhook", validarTelegram, receberUpdateTelegram);

module.exports = router;
