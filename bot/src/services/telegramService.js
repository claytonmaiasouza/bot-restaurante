const axios = require("axios");

function baseUrl() {
  return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
}

async function enviarMensagemTelegram(chatId, texto) {
  try {
    const { data } = await axios.post(`${baseUrl()}/sendMessage`, {
      chat_id: chatId,
      text: texto,
      parse_mode: "Markdown",
    });
    return data;
  } catch (err) {
    console.error("[telegram] erro ao enviar mensagem:", err.response?.data || err.message);
    throw err;
  }
}

async function configurarWebhook(urlWebhook) {
  const { data } = await axios.post(`${baseUrl()}/setWebhook`, {
    url: urlWebhook,
    secret_token: process.env.ADMIN_TOKEN,
    allowed_updates: ["message"],
  });
  console.log("[telegram] webhook configurado:", JSON.stringify(data));
  return data;
}

module.exports = { enviarMensagemTelegram, configurarWebhook };
