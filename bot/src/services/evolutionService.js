const axios = require("axios");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const evolutionClient = axios.create({
  baseURL: process.env.EVOLUTION_API_URL,
  headers: {
    apikey: process.env.EVOLUTION_API_KEY,
    "Content-Type": "application/json",
  },
});

// ── Resolução de JID para contatos iOS (@lid) ─────────────────────────────────
// Contatos do iPhone com privacidade ativada têm JID @lid em vez de @s.whatsapp.net.
// Quando o número vem sem sufixo (ex: vindo do banco), buscamos o JID completo.
// Quando vem com @s.whatsapp.net mas o contato é @lid, retentamos com @lid.

async function resolverJid(numero, instanceName) {
  if (!numero) return numero;
  if (numero.includes("@")) return numero; // já tem sufixo, usa direto
  try {
    const rows = await prisma.$queryRaw`
      SELECT c."remoteJid"
      FROM "Contact" c
      JOIN "Instance" i ON c."instanceId" = i.id
      WHERE i.name = ${instanceName}
        AND (c."remoteJid" = ${numero + "@lid"} OR c."remoteJid" = ${numero + "@s.whatsapp.net"})
      ORDER BY CASE WHEN c."remoteJid" LIKE '%@s.whatsapp.net' THEN 0 ELSE 1 END
      LIMIT 1
    `;
    if (rows.length > 0) return rows[0].remoteJid;
  } catch { /* fallback */ }
  return numero + "@s.whatsapp.net";
}

async function _enviarComRetryLid(path, payload, instanceName) {
  try {
    const { data } = await evolutionClient.post(path, payload);
    return data;
  } catch (err) {
    // Se a primeira tentativa falhou com 400 e o JID tem @s.whatsapp.net,
    // é possível que o contato seja @lid (iOS) — retenta com sufixo @lid.
    if (err.response?.status === 400 && payload.number?.includes("@s.whatsapp.net")) {
      const lidNumber = payload.number.replace("@s.whatsapp.net", "@lid");
      try {
        const { data } = await evolutionClient.post(path, { ...payload, number: lidNumber });
        console.log(`[evolution] reenviado via @lid: ${lidNumber}`);
        return data;
      } catch (err2) {
        throw err2;
      }
    }
    throw err;
  }
}

// ── Mensagens ─────────────────────────────────────────────────────────────────

/**
 * Envia uma mensagem de texto simples via Evolution API.
 */
async function enviarMensagem(numero, texto, instanceName) {
  const jid = await resolverJid(numero, instanceName);
  try {
    const data = await _enviarComRetryLid(
      `/message/sendText/${instanceName}`,
      { number: jid, text: texto },
      instanceName
    );
    return data;
  } catch (err) {
    console.error(
      `[evolution] erro ao enviar mensagem para ${jid}:`,
      err.response?.data || err.message
    );
    throw err;
  }
}

/**
 * Envia um documento (PDF, etc.) via Evolution API.
 */
async function enviarDocumento(numero, mediaUrl, fileName, instanceName) {
  const jid = await resolverJid(numero, instanceName);
  try {
    const data = await _enviarComRetryLid(
      `/message/sendMedia/${instanceName}`,
      { number: jid, mediatype: "document", mimetype: "application/pdf", caption: fileName, fileName, media: mediaUrl },
      instanceName
    );
    return data;
  } catch (err) {
    console.error(
      `[evolution] erro ao enviar documento para ${jid}:`,
      err.response?.data || err.message
    );
    throw err;
  }
}

/**
 * Envia uma imagem via Evolution API.
 */
async function enviarImagem(numero, mediaUrl, caption, instanceName) {
  const jid = await resolverJid(numero, instanceName);
  try {
    const data = await _enviarComRetryLid(
      `/message/sendMedia/${instanceName}`,
      { number: jid, mediatype: "image", caption: caption || "", media: mediaUrl },
      instanceName
    );
    return data;
  } catch (err) {
    console.error(
      `[evolution] erro ao enviar imagem para ${jid}:`,
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
    // Extrai QR code da resposta de criação, se disponível
    const qrData = data?.qrcode || data?.hash;
    if (qrData) {
      data._qrcode = {
        qrcode: qrData.code || qrData.qrcode || null,
        base64: qrData.base64 || null,
      };
    }
    return data;
  } catch (err) {
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
    const base64 = data?.qrcode?.base64 || data?.base64 || null;
    const code = data?.qrcode?.code || data?.code || null;
    if (!base64 && !code) return null;
    return { qrcode: code, base64 };
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

async function baixarMidiaBase64(instanceName, mensagem) {
  try {
    const { data } = await evolutionClient.post(
      `/chat/getBase64FromMediaMessage/${instanceName}`,
      { message: mensagem }
    );
    return { base64: data?.base64 || null, mimeType: data?.mimetype || "audio/ogg" };
  } catch (err) {
    console.error("[evolution] erro ao baixar mídia:", err.message);
    return { base64: null, mimeType: null };
  }
}

module.exports = {
  // Mensagens
  enviarMensagem,
  enviarImagem,
  enviarDocumento,
  enviarMensagemFormatada,
  baixarMidiaBase64,
  // Instâncias
  criarInstancia,
  obterQRCode,
  verificarConexao,
  configurarWebhook,
  listarInstancias,
  excluirInstancia,
};
