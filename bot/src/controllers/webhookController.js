const { processarMensagem } = require("../services/claudeService");
const { criarOuBuscarSessao, atualizarSessao, salvarMensagem } = require("../services/sessaoService");
const { enviarMensagem, enviarMensagemFormatada } = require("../services/evolutionService");
const { finalizarPedido } = require("../services/pedidoService");

// ── Detectores de localização ─────────────────────────────────────────────────

function eMensagemDeLocalizacao(mensagem) {
  if (mensagem.messageType === "locationMessage") return true;
  const texto = extrairTexto(mensagem) || "";
  if (/maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl/i.test(texto)) return true;
  if (/rua|avenida|av\.|travessa|alameda|estrada/i.test(texto)) return true;
  return false;
}

function extrairLocalizacao(mensagem) {
  if (mensagem.messageType === "locationMessage") {
    const loc = mensagem.message?.locationMessage;
    if (loc?.degreesLatitude && loc?.degreesLongitude) {
      return `https://maps.google.com/?q=${loc.degreesLatitude},${loc.degreesLongitude}`;
    }
  }
  return extrairTexto(mensagem);
}

function extrairTexto(mensagem) {
  return (
    mensagem.message?.conversation ||
    mensagem.message?.extendedTextMessage?.text ||
    mensagem.message?.imageMessage?.caption ||
    ""
  );
}

function extrairNumeroCliente(mensagem) {
  return (mensagem.key?.remoteJid || "")
    .replace("@s.whatsapp.net", "")
    .replace("@g.us", "");
}

// ── Controller principal ──────────────────────────────────────────────────────

/**
 * Processa eventos recebidos da Evolution API.
 *
 * O tenantMiddleware já rodou antes deste controller e injetou:
 *   req.restaurante — dados do restaurante (banco local)
 *   req.cardapio    — cardápio atualizado (Strapi)
 */
async function receberMensagem(req, res) {
  // Responde 200 imediatamente para não bloquear a Evolution API
  res.status(200).json({ ok: true });

  const evento = req.body;
  const io = req.app.get("io");

  // Restaurante e cardápio já resolvidos pelo tenantMiddleware
  const restaurante = req.restaurante;
  const cardapio = req.cardapio;

  // Só processa mensagens recebidas
  if (evento.event !== "messages.upsert") return;

  const mensagem = evento.data?.messages?.[0] || evento.data;
  if (!mensagem || mensagem.key?.fromMe) return;

  const clienteNumero = extrairNumeroCliente(mensagem);
  if (!clienteNumero) return;

  const instanceName = evento.instance || restaurante.slugWhatsapp;

  try {
    // ── a) Buscar/criar sessão ────────────────────────────────────────────────
    const sessao = await criarOuBuscarSessao(clienteNumero, restaurante.id);

    const clienteNome = mensagem.pushName || sessao.clienteNome || null;
    if (clienteNome && clienteNome !== sessao.clienteNome) {
      await atualizarSessao(sessao.id, { clienteNome });
      sessao.clienteNome = clienteNome;
    }

    // ── b) Localização → finalizar pedido ─────────────────────────────────────
    if (
      sessao.estado === "AGUARDANDO_LOCALIZACAO" &&
      eMensagemDeLocalizacao(mensagem)
    ) {
      const localizacao = extrairLocalizacao(mensagem);

      const { resposta } = await processarMensagem(
        sessao,
        `Minha localização: ${localizacao}`,
        restaurante,
        cardapio
      );

      const pedido = await finalizarPedido(sessao.id, localizacao);

      await salvarMensagem(sessao.id, "cliente", `[localização] ${localizacao}`);
      await salvarMensagem(sessao.id, "bot", resposta);

      await enviarMensagem(clienteNumero, resposta, instanceName);
      await enviarMensagemFormatada(pedido, instanceName, restaurante.donoWhatsapp);

      io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", {
        restauranteId: restaurante.id,
        pedido,
      });
      return;
    }

    // ── c) Mensagem de texto → Claude ─────────────────────────────────────────
    const textoCliente = extrairTexto(mensagem);
    if (!textoCliente) return;

    const { resposta, novoEstado, carrinhoAtualizado, pedidoPronto } =
      await processarMensagem(sessao, textoCliente, restaurante, cardapio);

    // ── d) Persistir ──────────────────────────────────────────────────────────
    await salvarMensagem(sessao.id, "cliente", textoCliente);
    await salvarMensagem(sessao.id, "bot", resposta);
    await atualizarSessao(sessao.id, {
      estado: novoEstado,
      carrinho: carrinhoAtualizado,
    });

    // ── e) Responder ao cliente ───────────────────────────────────────────────
    await enviarMensagem(clienteNumero, resposta, instanceName);

    // ── f) Pedido pronto via texto (Claude detectou endereço) ─────────────────
    if (pedidoPronto && novoEstado === "FINALIZADO") {
      sessao.carrinho = carrinhoAtualizado;
      const pedido = await finalizarPedido(sessao.id, textoCliente);
      await enviarMensagemFormatada(pedido, instanceName, restaurante.donoWhatsapp);
      io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", {
        restauranteId: restaurante.id,
        pedido,
      });
    }
  } catch (err) {
    console.error(`[webhook] erro (${restaurante.slugWhatsapp}):`, err.message);
    try {
      await enviarMensagem(
        clienteNumero,
        "Desculpe, tive um probleminha aqui. Pode repetir sua mensagem? 😅",
        instanceName
      );
    } catch {
      // silencioso
    }
  }
}

module.exports = { receberMensagem };
