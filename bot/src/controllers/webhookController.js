const { processarMensagem } = require("../services/claudeService");
const { criarOuBuscarSessao, atualizarSessao, salvarMensagem } = require("../services/sessaoService");
const { enviarMensagem, baixarMidiaBase64 } = require("../services/evolutionService");
const { finalizarPedido } = require("../services/pedidoService");
const { transcreverAudio } = require("../services/transcricaoService");
const { buscarContextoFidelidade } = require("../services/cardapioService");

// ── Verificação de horário de atendimento ─────────────────────────────────────

function verificarHorario(horarioAtendimento) {
  if (!horarioAtendimento) return { aberto: true };

  try {
    const config = typeof horarioAtendimento === "string"
      ? JSON.parse(horarioAtendimento)
      : horarioAtendimento;

    if (!config.ativo) return { aberto: true };

    // Hora atual no fuso de São Paulo
    const agoraBR = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const diaSemana = String(agoraBR.getDay()); // "0"=Dom … "6"=Sáb
    const hhmm = `${String(agoraBR.getHours()).padStart(2, "0")}:${String(agoraBR.getMinutes()).padStart(2, "0")}`;

    const diaConfig = config.dias?.[diaSemana];
    if (!diaConfig || !diaConfig.aberto) {
      return { aberto: false, descricao: config.descricao };
    }

    const { abertura, fechamento } = diaConfig;
    // Fechamento "00:00" significa meia-noite (considera aberto até lá)
    const fechaMeiaNoite = fechamento === "00:00" || fechamento === "24:00";
    if (hhmm < abertura || (!fechaMeiaNoite && hhmm >= fechamento)) {
      return { aberto: false, descricao: config.descricao };
    }

    return { aberto: true };
  } catch {
    return { aberto: true };
  }
}

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
    // ── a) Buscar/criar sessão + contexto de fidelidade ──────────────────────
    const [sessao, fidelidade] = await Promise.all([
      criarOuBuscarSessao(clienteNumero, restaurante.id),
      buscarContextoFidelidade(restaurante.id, clienteNumero).catch(() => null),
    ]);

    const clienteNome = mensagem.pushName || sessao.clienteNome || null;
    if (clienteNome && clienteNome !== sessao.clienteNome) {
      await atualizarSessao(sessao.id, { clienteNome });
      sessao.clienteNome = clienteNome;
    }

    // ── b) Extrair texto/áudio ────────────────────────────────────────────────
    let textoCliente = extrairTexto(mensagem);

    if (!textoCliente && ["audioMessage", "pttMessage"].includes(mensagem.messageType)) {
      const { base64, mimeType } = await baixarMidiaBase64(instanceName, mensagem);
      if (base64) {
        console.log(`[webhook] transcrevendo áudio de ${clienteNumero}...`);
        textoCliente = await transcreverAudio(base64, mimeType);
        console.log(`[webhook] transcrição: "${textoCliente}"`);
      }
    }

    // ── c) Verificar horário de atendimento ──────────────────────────────────
    const horario = verificarHorario(restaurante.horarioAtendimento);
    if (!horario.aberto) {
      const descricao = horario.descricao || "Consulte nossos horários de funcionamento.";
      const msgFechado =
        `Olá${sessao.clienteNome ? `, ${sessao.clienteNome}` : ""}! 😊\n\n` +
        `No momento estamos fora do horário de atendimento.\n\n` +
        `🕐 *Horário de funcionamento:*\n${descricao}\n\n` +
        `Obrigado pelo contato! Assim que abrirmos, teremos o maior prazer em atendê-lo. 🍽️`;
      await enviarMensagem(clienteNumero, msgFechado, instanceName);
      return;
    }

    // ── d) Bot pausado → só salva e notifica o painel, não responde ──────────
    if (sessao.botPausado) {
      const texto = textoCliente || "[mídia]";
      await salvarMensagem(sessao.id, "cliente", texto);
      io?.to("admin").emit("conversa:mensagem", {
        sessaoId: sessao.id,
        mensagem: { role: "cliente", conteudo: texto, createdAt: new Date() },
      });
      return;
    }

    if (!textoCliente && !eMensagemDeLocalizacao(mensagem)) return;

    // ── d) Localização → guardar e perguntar pagamento ───────────────────────
    if (
      sessao.estado === "AGUARDANDO_LOCALIZACAO" &&
      eMensagemDeLocalizacao(mensagem)
    ) {
      const localizacao = extrairLocalizacao(mensagem);

      await salvarMensagem(sessao.id, "cliente", `[localização] ${localizacao}`);
      await atualizarSessao(sessao.id, {
        estado: "AGUARDANDO_PAGAMENTO",
        localizacaoPendente: localizacao,
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
      await enviarMensagem(clienteNumero, msgPagamento, instanceName);
      return;
    }

    // ── e) Pagamento → finalizar pedido ──────────────────────────────────────
    if (sessao.estado === "AGUARDANDO_PAGAMENTO" && textoCliente) {
      const texto = textoCliente.toLowerCase();
      let metodoPagamento = null;
      if (/dinheiro|efectivo|cash|billete/i.test(texto)) metodoPagamento = "Dinheiro";
      else if (/cart[aã]o|m[aá]quina|tarjeta|d[eé]bito|cr[eé]dito/i.test(texto)) metodoPagamento = "Cartão";
      else if (/transfer[eê]ncia|pix|banco/i.test(texto)) metodoPagamento = "Transferência";

      if (!metodoPagamento) {
        const msg =
          `Não entendi. Por favor, escolha uma das formas de pagamento:\n\n` +
          `💵 *Dinheiro*\n` +
          `💳 *Cartão* (maquininha)\n` +
          `🏦 *Transferência* (PIX/transferência bancária)`;
        await salvarMensagem(sessao.id, "cliente", textoCliente);
        await salvarMensagem(sessao.id, "bot", msg);
        io?.to("admin").emit("conversa:mensagem", {
          sessaoId: sessao.id,
          mensagem: { role: "cliente", conteudo: textoCliente, createdAt: new Date() },
        });
        io?.to("admin").emit("conversa:mensagem", {
          sessaoId: sessao.id,
          mensagem: { role: "bot", conteudo: msg, createdAt: new Date() },
        });
        await enviarMensagem(clienteNumero, msg, instanceName);
        return;
      }

      const localizacao = sessao.localizacaoPendente || "Retirada no balcão";
      const tipoEntrega = localizacao === "retirada" ? "retirada" : "delivery";

      const pedido = await finalizarPedido(sessao.id, localizacao, tipoEntrega, metodoPagamento);

      await salvarMensagem(sessao.id, "cliente", textoCliente);

      io?.to("admin").emit("conversa:mensagem", {
        sessaoId: sessao.id,
        mensagem: { role: "cliente", conteudo: textoCliente, createdAt: new Date() },
      });
      io?.to("admin").emit("conversa:encerrada", { sessaoId: sessao.id });
      io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", {
        restauranteId: restaurante.id,
        pedido,
      });
      return;
    }

    if (!textoCliente) return;

    const { resposta, novoEstado, carrinhoAtualizado, pedidoPronto, tipoEntrega } =
      await processarMensagem(sessao, textoCliente, restaurante, cardapio, fidelidade);

    // ── e) Persistir ──────────────────────────────────────────────────────────
    await Promise.all([
      salvarMensagem(sessao.id, "cliente", textoCliente),
      salvarMensagem(sessao.id, "bot", resposta),
    ]);
    await atualizarSessao(sessao.id, {
      estado: novoEstado,
      carrinho: carrinhoAtualizado,
    });

    // Emite mensagens em tempo real para o painel (cliente e bot)
    const agora = new Date();
    io?.to("admin").emit("conversa:mensagem", {
      sessaoId: sessao.id,
      mensagem: { role: "cliente", conteudo: textoCliente, createdAt: agora },
    });
    io?.to("admin").emit("conversa:mensagem", {
      sessaoId: sessao.id,
      mensagem: { role: "bot", conteudo: resposta, createdAt: agora },
    });

    // ── f) Responder ao cliente ───────────────────────────────────────────────
    await enviarMensagem(clienteNumero, resposta, instanceName);

    // ── g) Pedido pronto → perguntar pagamento antes de finalizar ────────────
    if (pedidoPronto && novoEstado === "FINALIZADO") {
      sessao.carrinho = carrinhoAtualizado;
      const localizacao = tipoEntrega === "retirada" ? "retirada" : textoCliente;

      // Guarda localização e muda estado para aguardar pagamento
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
      io?.to("admin").emit("conversa:mensagem", {
        sessaoId: sessao.id,
        mensagem: { role: "bot", conteudo: msgPagamento, createdAt: new Date() },
      });
      await enviarMensagem(clienteNumero, msgPagamento, instanceName);
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
