const { processarMensagem } = require("../services/claudeService");
const { criarOuBuscarSessao, atualizarSessao, salvarMensagem } = require("../services/sessaoService");
const { enviarMensagemTelegram } = require("../services/telegramService");
const { finalizarPedido } = require("../services/pedidoService");
const { buscarContextoFidelidade } = require("../services/cardapioService");
const { resolverRestaurante } = require("../services/tenantService");

async function receberUpdateTelegram(req, res) {
  res.status(200).json({ ok: true });

  const io = req.app.get("io");
  const update = req.body;

  const message = update.message;
  if (!message || message.from?.is_bot) return;

  const chatId = message.chat.id;
  const clienteNumero = `tg_${message.from.id}`;
  const clienteNome = message.from.first_name || message.from.username || null;

  const slug = process.env.TELEGRAM_RESTAURANTE_SLUG;
  if (!slug) {
    console.error("[telegram] TELEGRAM_RESTAURANTE_SLUG não configurado");
    return;
  }

  let restaurante, cardapio;
  try {
    ({ restaurante, cardapio } = await resolverRestaurante(slug));
  } catch (err) {
    console.error("[telegram] erro ao resolver restaurante:", err.message);
    return;
  }

  try {
    const [sessao, fidelidade] = await Promise.all([
      criarOuBuscarSessao(clienteNumero, restaurante.id),
      buscarContextoFidelidade(restaurante.id, clienteNumero).catch(() => null),
    ]);

    if (clienteNome && clienteNome !== sessao.clienteNome) {
      await atualizarSessao(sessao.id, { clienteNome });
      sessao.clienteNome = clienteNome;
    }

    // ── Bot pausado → só salva e notifica o painel ────────────────────────────
    if (sessao.botPausado) {
      const texto = message.text || "[mídia]";
      await salvarMensagem(sessao.id, "cliente", texto);
      io?.to("admin").emit("conversa:mensagem", {
        sessaoId: sessao.id,
        mensagem: { role: "cliente", conteudo: texto, createdAt: new Date() },
      });
      return;
    }

    // ── Extração de texto e localização ──────────────────────────────────────
    let textoCliente = message.text || message.caption || "";
    let eLocalizacao = false;
    let linkLocalizacao = null;

    if (message.location) {
      eLocalizacao = true;
      linkLocalizacao = `https://maps.google.com/?q=${message.location.latitude},${message.location.longitude}`;
      textoCliente = linkLocalizacao;
    } else if (/maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl/i.test(textoCliente)) {
      eLocalizacao = true;
      linkLocalizacao = textoCliente;
    }

    // ── Localização recebida ──────────────────────────────────────────────────
    if (sessao.estado === "AGUARDANDO_LOCALIZACAO" && eLocalizacao) {
      await salvarMensagem(sessao.id, "cliente", `[localização] ${linkLocalizacao}`);
      await atualizarSessao(sessao.id, {
        estado: "AGUARDANDO_PAGAMENTO",
        localizacaoPendente: linkLocalizacao,
      });

      const msgPagamento =
        `📍 Localização recebida!\n\n` +
        `Qual será a forma de pagamento?\n\n` +
        `💵 *Dinheiro*\n` +
        `💳 *Cartão* (maquininha)\n` +
        `🏦 *Transferência* (PIX/transferência bancária)`;

      await salvarMensagem(sessao.id, "bot", msgPagamento);
      io?.to("admin").emit("conversa:mensagem", {
        sessaoId: sessao.id,
        mensagem: { role: "bot", conteudo: msgPagamento, createdAt: new Date() },
      });
      await enviarMensagemTelegram(chatId, msgPagamento);
      return;
    }

    // ── Pagamento ─────────────────────────────────────────────────────────────
    if (sessao.estado === "AGUARDANDO_PAGAMENTO" && textoCliente) {
      const texto = textoCliente.toLowerCase();
      let metodoPagamento = null;
      if (/dinheiro|efectivo|cash|billete/i.test(texto)) metodoPagamento = "Dinheiro";
      else if (/cart[aã]o|m[aá]quina|tarjeta|d[eé]bito|cr[eé]dito/i.test(texto)) metodoPagamento = "Cartão";
      else if (/transfer[eê]ncia|pix|banco/i.test(texto)) metodoPagamento = "Transferência";

      if (!metodoPagamento) {
        const msg =
          `Não entendi. Por favor, escolha uma das formas de pagamento:\n\n` +
          `💵 *Dinheiro*\n💳 *Cartão* (maquininha)\n🏦 *Transferência* (PIX/transferência bancária)`;
        await salvarMensagem(sessao.id, "cliente", textoCliente);
        await salvarMensagem(sessao.id, "bot", msg);
        io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "cliente", conteudo: textoCliente, createdAt: new Date() } });
        io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "bot", conteudo: msg, createdAt: new Date() } });
        await enviarMensagemTelegram(chatId, msg);
        return;
      }

      await salvarMensagem(sessao.id, "cliente", textoCliente);
      io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "cliente", conteudo: textoCliente, createdAt: new Date() } });

      if (metodoPagamento === "Dinheiro") {
        await atualizarSessao(sessao.id, { estado: "AGUARDANDO_TROCO" });
        const msgTroco = `💵 Ótimo! Pagamento em dinheiro.\n\nTroco para quanto? (Digite o valor ou "sem troco" se não precisar)`;
        await salvarMensagem(sessao.id, "bot", msgTroco);
        io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "bot", conteudo: msgTroco, createdAt: new Date() } });
        await enviarMensagemTelegram(chatId, msgTroco);
        return;
      }

      if (metodoPagamento === "Cartão") {
        const locPendente = sessao.localizacaoPendente || "retirada";
        const tipoEntrega = locPendente === "retirada" ? "retirada" : "delivery";
        const localizacao = tipoEntrega === "retirada" ? "Retirada no balcão" : locPendente;
        const pedido = await finalizarPedido(sessao.id, localizacao, tipoEntrega, metodoPagamento,
          tipoEntrega === "delivery" ? "\n\n💳 O entregador levará a maquininha de cartão." : "");
        io?.to("admin").emit("conversa:encerrada", { sessaoId: sessao.id });
        io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", { restauranteId: restaurante.id, pedido });
        return;
      }

      if (metodoPagamento === "Transferência") {
        const locPendente = sessao.localizacaoPendente || "retirada";
        const tipoEntrega = locPendente === "retirada" ? "retirada" : "delivery";
        const localizacao = tipoEntrega === "retirada" ? "Retirada no balcão" : locPendente;
        const dadosTrans = restaurante.dadosTransferencia
          ? `\n\n🏦 *Dados para transferência:*\n${restaurante.dadosTransferencia}`
          : "";
        const pedido = await finalizarPedido(sessao.id, localizacao, tipoEntrega, metodoPagamento, dadosTrans);
        io?.to("admin").emit("conversa:encerrada", { sessaoId: sessao.id });
        io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", { restauranteId: restaurante.id, pedido });
        return;
      }
    }

    // ── Troco ─────────────────────────────────────────────────────────────────
    if (sessao.estado === "AGUARDANDO_TROCO" && textoCliente) {
      const semTroco = /sem troco|sin cambio|não precisa|no necesito|exato|exacto/i.test(textoCliente);
      const trocoInfo = semTroco ? "sem troco" : textoCliente.trim();
      const metodoPagamento = semTroco ? "Dinheiro (sem troco)" : `Dinheiro - Troco para ${trocoInfo}`;

      await salvarMensagem(sessao.id, "cliente", textoCliente);
      io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "cliente", conteudo: textoCliente, createdAt: new Date() } });

      const locPendente = sessao.localizacaoPendente || "retirada";
      const tipoEntrega = locPendente === "retirada" ? "retirada" : "delivery";
      const localizacao = tipoEntrega === "retirada" ? "Retirada no balcão" : locPendente;
      const pedido = await finalizarPedido(sessao.id, localizacao, tipoEntrega, metodoPagamento,
        semTroco ? "" : `\n\n💵 Troco para: *${trocoInfo}*`);

      io?.to("admin").emit("conversa:encerrada", { sessaoId: sessao.id });
      io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", { restauranteId: restaurante.id, pedido });
      return;
    }

    if (!textoCliente) return;

    // ── Claude AI ─────────────────────────────────────────────────────────────
    const { resposta, novoEstado, carrinhoAtualizado, pedidoPronto, tipoEntrega } =
      await processarMensagem(sessao, textoCliente, restaurante, cardapio, fidelidade);

    await Promise.all([
      salvarMensagem(sessao.id, "cliente", textoCliente),
      salvarMensagem(sessao.id, "bot", resposta),
    ]);
    await atualizarSessao(sessao.id, {
      estado: novoEstado,
      carrinho: carrinhoAtualizado,
    });

    const agora = new Date();
    io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "cliente", conteudo: textoCliente, createdAt: agora } });
    io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "bot", conteudo: resposta, createdAt: agora } });

    await enviarMensagemTelegram(chatId, resposta);

    if (pedidoPronto && novoEstado === "FINALIZADO") {
      const localizacao = tipoEntrega === "retirada" ? "Retirada no balcão" : textoCliente;
      await atualizarSessao(sessao.id, {
        estado: "AGUARDANDO_PAGAMENTO",
        localizacaoPendente: localizacao,
      });

      const msgPagamento =
        `\n\nQual será a forma de pagamento?\n\n` +
        `💵 *Dinheiro*\n` +
        `💳 *Cartão* (maquininha)\n` +
        `🏦 *Transferência* (PIX/transferência bancária)`;

      await salvarMensagem(sessao.id, "bot", msgPagamento);
      io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "bot", conteudo: msgPagamento, createdAt: new Date() } });
      await enviarMensagemTelegram(chatId, msgPagamento);
    }
  } catch (err) {
    console.error(`[telegram] erro:`, err.message);
    try {
      await enviarMensagemTelegram(chatId, "Desculpe, tive um probleminha aqui. Pode repetir sua mensagem? 😅");
    } catch { /* silencioso */ }
  }
}

module.exports = { receberUpdateTelegram };
