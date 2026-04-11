const axios = require("axios");

const evolutionClient = axios.create({
  baseURL: process.env.EVOLUTION_API_URL,
  headers: {
    apikey: process.env.EVOLUTION_API_KEY,
    "Content-Type": "application/json",
  },
});

// ── Mensagens ─────────────────────────────────────────────────────────────────

/**
 * Envia uma mensagem de texto simples via Evolution API.
 */
async function enviarMensagem(numero, texto, instanceName) {
  try {
    const { data } = await evolutionClient.post(
      `/message/sendText/${instanceName}`,
      { number: numero, text: texto }
    );
    return data;
  } catch (err) {
    console.error(
      `[evolution] erro ao enviar mensagem para ${numero}:`,
      err.response?.data || err.message
    );
    throw err;
  }
}

/**
 * Envia resumo formatado do pedido para o dono e confirmação ao cliente.
 */
async function enviarMensagemFormatada(pedido, instanceName, donoNumero) {
  const itensFormatados = pedido.itens
    .map(
      (i) =>
        `  • ${i.quantidade}x *${i.nome}* — R$ ${(i.preco * i.quantidade).toFixed(2)}`
    )
    .join("\n");

  const mensagemDono =
    `🔔 *Novo Pedido!*\n\n` +
    `👤 *Cliente:* ${pedido.clienteNome || pedido.clienteNumero}\n` +
    `📱 *WhatsApp:* ${pedido.clienteNumero}\n\n` +
    `🛒 *Itens:*\n${itensFormatados}\n\n` +
    `💰 *Total:* R$ ${pedido.total.toFixed(2)}\n\n` +
    `📍 *Endereço/Localização:*\n${pedido.localizacao || "Não informado"}\n\n` +
    `🕐 *Pedido em:* ${new Date(pedido.createdAt).toLocaleString("pt-BR")}`;

  const mensagemCliente =
    `✅ *Pedido confirmado!*\n\n` +
    `Recebemos seu pedido e já notificamos o restaurante. Em breve você receberá mais informações sobre o tempo de entrega. 🍽️\n\n` +
    `Obrigado pela preferência! 😊`;

  await enviarMensagem(donoNumero, mensagemDono, instanceName);
  await enviarMensagem(pedido.clienteNumero, mensagemCliente, instanceName);
}

// ── Gestão de instâncias ──────────────────────────────────────────────────────

/**
 * Cria uma instância na Evolution API para um restaurante.
 * O nome da instância é o slug (número WhatsApp) do restaurante.
 *
 * @param {object} restaurante - { slugWhatsapp, nome }
 * @returns {object}           - Dados da instância criada
 */
async function criarInstancia(restaurante) {
  try {
    const { data } = await evolutionClient.post("/instance/create", {
      instanceName: restaurante.slugWhatsapp,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
    });
    console.log(`[evolution] instância criada: ${restaurante.slugWhatsapp}`);
    return data;
  } catch (err) {
    // Ignora erro se a instância já existe (409 ou 403 dependendo da versão da Evolution)
    const jaExiste =
      err.response?.status === 409 ||
      err.response?.status === 403 ||
      err.response?.data?.response?.message?.some?.((m) => m.includes("already in use")) ||
      err.response?.data?.error?.includes?.("already exists");
    if (jaExiste) {
      console.log(`[evolution] instância já existe: ${restaurante.slugWhatsapp}`);
      return { instanceName: restaurante.slugWhatsapp, exists: true };
    }
    console.error(`[evolution] erro ao criar instância ${restaurante.slugWhatsapp}:`, err.response?.data || err.message);
    throw err;
  }
}

/**
 * Retorna o QR code atual de uma instância para conexão via WhatsApp Business.
 *
 * @param {string} instanceName - Nome da instância (slug do restaurante)
 * @returns {{ qrcode: string, base64: string } | null}
 */
async function obterQRCode(instanceName) {
  try {
    const { data } = await evolutionClient.get(`/instance/connect/${instanceName}`);
    return {
      qrcode: data?.qrcode?.code || data?.code || null,
      base64: data?.qrcode?.base64 || data?.base64 || null,
    };
  } catch (err) {
    console.error(`[evolution] erro ao obter QR code de ${instanceName}:`, err.response?.data || err.message);
    return null;
  }
}

/**
 * Verifica o status de conexão de uma instância.
 *
 * @param {string} instanceName
 * @returns {{ connected: boolean, status: string, number: string | null }}
 */
async function verificarConexao(instanceName) {
  try {
    const { data } = await evolutionClient.get(`/instance/connectionState/${instanceName}`);
    const state = data?.instance?.state || data?.state || "unknown";
    return {
      connected: state === "open",
      status: state,
      number: data?.instance?.ownerJid?.replace("@s.whatsapp.net", "") || null,
    };
  } catch (err) {
    if (err.response?.status === 404) {
      return { connected: false, status: "not_found", number: null };
    }
    console.error(`[evolution] erro ao verificar conexão de ${instanceName}:`, err.response?.data || err.message);
    return { connected: false, status: "error", number: null };
  }
}

/**
 * Configura o webhook de uma instância para apontar para o endpoint do bot.
 *
 * @param {string} instanceName - Nome da instância
 * @param {string} webhookUrl   - URL base do bot (ex: https://meubot.com)
 */
async function configurarWebhook(instanceName, webhookUrl) {
  const url = `${webhookUrl}/webhook/${instanceName}`;

  try {
    const { data } = await evolutionClient.post(`/webhook/set/${instanceName}`, {
      webhook: {
        enabled: true,
        url,
        webhookByEvents: false,
        webhookBase64: false,
        events: [
          "MESSAGES_UPSERT",
          "CONNECTION_UPDATE",
        ],
        headers: {
          apikey: process.env.EVOLUTION_API_KEY,
        },
      },
    });
    console.log(`[evolution] webhook configurado: ${instanceName} → ${url}`);
    return data;
  } catch (err) {
    console.error(`[evolution] erro ao configurar webhook de ${instanceName}:`, err.response?.data || err.message);
    throw err;
  }
}

/**
 * Lista todas as instâncias registradas na Evolution API.
 *
 * @returns {Array<{ instanceName: string, status: string }>}
 */
async function listarInstancias() {
  try {
    const { data } = await evolutionClient.get("/instance/fetchInstances");
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("[evolution] erro ao listar instâncias:", err.response?.data || err.message);
    return [];
  }
}

/**
 * Desconecta e exclui uma instância da Evolution API.
 */
async function excluirInstancia(instanceName) {
  try {
    await evolutionClient.delete(`/instance/delete/${instanceName}`);
    console.log(`[evolution] instância excluída: ${instanceName}`);
  } catch (err) {
    console.error(`[evolution] erro ao excluir instância ${instanceName}:`, err.response?.data || err.message);
    throw err;
  }
}

module.exports = {
  // Mensagens
  enviarMensagem,
  enviarMensagemFormatada,
  // Instâncias
  criarInstancia,
  obterQRCode,
  verificarConexao,
  configurarWebhook,
  listarInstancias,
  excluirInstancia,
};
