const fs = require("fs");
const path = require("path");
const { processarMensagem } = require("../services/claudeService");
const { criarOuBuscarSessao, atualizarSessao, salvarMensagem, buscarSessaoFinalizada } = require("../services/sessaoService");
const { enviarMensagem, enviarImagem, enviarDocumento, baixarMidiaBase64 } = require("../services/evolutionService");
const { finalizarPedido, salvarComprovante, buscarPedidoAtivoDaSessao, formatNumPedido } = require("../services/pedidoService");
const { transcreverAudio } = require("../services/transcricaoService");
const { buscarContextoFidelidade } = require("../services/cardapioService");

// ── Detecção de idioma ────────────────────────────────────────────────────────

function detectarIdioma(mensagens) {
  const texto = (mensagens || [])
    .filter(m => m.role === "cliente")
    .slice(0, 5)
    .map(m => m.conteudo)
    .join(" ")
    .toLowerCase();
  // Apenas palavras exclusivamente espanholas (não existem no português brasileiro)
  return /\b(hola|quiero|buenos|gracias|también|necesito|cuanto|cuánto|tengo|puedo|soy|hoy|voy|dónde|cómo)\b/.test(texto) ? "es" : "pt";
}

const T = {
  pt: {
    comprovanteRecebido: "✅ Comprovante recebido! Seu pedido foi confirmado e a cozinha já foi notificada. 👨‍🍳",
    fechado: (nome, desc) =>
      `Olá${nome ? `, ${nome}` : ""}! 😊\n\nNo momento estamos fora do horário de atendimento.\n\n🕐 *Horário de funcionamento:*\n${desc}\n\nObrigado pelo contato! Assim que abrirmos, teremos o maior prazer em atendê-lo. 🍽️`,
    formaPagamento: "📍 Localização recebida!\n\nQual será a forma de pagamento?\n\n💵 *Dinheiro*\n💳 *Cartão* (maquininha)\n🏦 *Transferência* (PIX/transferência bancária)",
    formaPagamentoPedido: "\n\nQual será a forma de pagamento?\n\n💵 *Dinheiro*\n💳 *Cartão* (maquininha)\n🏦 *Transferência* (PIX/transferência bancária)",
    pagamentoInvalido: "Não entendi. Por favor, escolha uma das formas de pagamento:\n\n💵 *Dinheiro*\n💳 *Cartão* (maquininha)\n🏦 *Transferência* (PIX/transferência bancária)",
    troco: `💵 Ótimo! Pagamento em dinheiro.\n\nTroco para quanto? (Digite o valor ou "sem troco" se não precisar)`,
    trocoInfo: (v) => `\n\n💵 Troco para: *${v}*`,
    maquininha: "\n\n💳 O entregador levará a maquininha de cartão.",
  },
  es: {
    comprovanteRecebido: "✅ ¡Comprobante recibido! Tu pedido fue confirmado y ya notificamos a la cocina. 👨‍🍳",
    fechado: (nome, desc) =>
      `¡Hola${nome ? `, ${nome}` : ""}! 😊\n\nEn este momento estamos fuera del horario de atención.\n\n🕐 *Horario de atención:*\n${desc}\n\n¡Gracias por contactarnos! En cuanto abramos, será un placer atenderte. 🍽️`,
    formaPagamento: "📍 ¡Ubicación recibida!\n\n¿Cuál será el método de pago?\n\n💵 *Efectivo*\n💳 *Tarjeta* (datáfono)\n🏦 *Transferencia* (transferencia bancaria)",
    formaPagamentoPedido: "\n\n¿Cuál será el método de pago?\n\n💵 *Efectivo*\n💳 *Tarjeta* (datáfono)\n🏦 *Transferencia* (transferencia bancaria)",
    pagamentoInvalido: "No entendí. Por favor, elige una forma de pago:\n\n💵 *Efectivo*\n💳 *Tarjeta* (datáfono)\n🏦 *Transferencia* (transferencia bancaria)",
    troco: `💵 ¡Perfecto! Pago en efectivo.\n\n¿Cambio para cuánto? (Escribe el valor o "sin cambio" si no necesitas)`,
    trocoInfo: (v) => `\n\n💵 Cambio para: *${v}*`,
    maquininha: "\n\n💳 El repartidor llevará el datáfono.",
  },
};

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
    // ── Comprovante: imagem/PDF enviado após pedido finalizado ────────────────
    // Deve ser checado ANTES de criarOuBuscarSessao (que ignora sessões FINALIZADO)
    const tiposMidia = ["imageMessage", "documentMessage", "documentWithCaptionMessage"];
    if (tiposMidia.includes(mensagem.messageType)) {
      const sessaoFinalizada = await buscarSessaoFinalizada(clienteNumero, restaurante.id);
      if (sessaoFinalizada) {
        const { base64, mimeType } = await baixarMidiaBase64(instanceName, mensagem);
        if (base64) {
          const isPdf = mimeType?.includes("pdf");
          const ext = isPdf ? "pdf" : mimeType?.includes("png") ? "png" : mimeType?.includes("webp") ? "webp" : "jpg";
          const filename = `comprovante-${sessaoFinalizada.id}-${Date.now()}.${ext}`;
          const uploadsDir = path.resolve(__dirname, "../../public/uploads/comprovantes");
          if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
          fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from(base64, "base64"));
          const comprovanteUrl = `${process.env.BOT_PUBLIC_URL}/uploads/comprovantes/${filename}`;
          const { pedidoId, pedido: pedidoAtualizado, statusChanged } = await salvarComprovante(sessaoFinalizada.id, comprovanteUrl);
          if (pedidoId) {
            io?.to("admin").emit("pedido:comprovante", { pedidoId, comprovanteUrl });
            io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:comprovante", { pedidoId, comprovanteUrl });
            if (statusChanged) {
              io?.to("admin").emit("pedido:novo", { restauranteId: restaurante.id, pedido: pedidoAtualizado });
              io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", { restauranteId: restaurante.id, pedido: pedidoAtualizado });
            }
          }
          await salvarMensagem(sessaoFinalizada.id, "cliente", `[comprovante] ${comprovanteUrl}`);
          io?.to("admin").emit("conversa:mensagem", {
            sessaoId: sessaoFinalizada.id,
            mensagem: { role: "cliente", conteudo: `[comprovante] ${comprovanteUrl}`, createdAt: new Date() },
          });
          const idiomaComp = detectarIdioma(sessaoFinalizada.mensagens || []);
          await enviarMensagem(clienteNumero, T[idiomaComp].comprovanteRecebido, instanceName);
          console.log(`[webhook] comprovante salvo: ${comprovanteUrl}`);
        }
        return;
      }
    }

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

    const idioma = detectarIdioma(sessao.mensagens || []);

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
      const descricao = horario.descricao || (idioma === "es" ? "Consulte nuestros horarios de atención." : "Consulte nossos horários de funcionamento.");
      await enviarMensagem(clienteNumero, T[idioma].fechado(sessao.clienteNome, descricao), instanceName);
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

    // ── e) Sessão FINALIZADO com pedido ativo → informa status, não inicia nova ─
    if (sessao.estado === "FINALIZADO") {
      const pedidoAtivo = await buscarPedidoAtivoDaSessao(sessao.id);
      if (pedidoAtivo) {
        await salvarMensagem(sessao.id, "cliente", textoCliente);
        io?.to("admin").emit("conversa:mensagem", {
          sessaoId: sessao.id,
          mensagem: { role: "cliente", conteudo: textoCliente, createdAt: new Date() },
        });

        const statusMsgs = {
          pt: {
            NOVO: "Recebemos seu pedido e estamos aguardando a confirmação do restaurante. Em breve retornaremos! 🍽️",
            CONFIRMADO: "Ótima notícia! O restaurante confirmou seu pedido e já está preparando. 👨‍🍳",
            PAGO: "Pagamento confirmado! O restaurante está preparando seu pedido. 👨‍🍳",
            PREPARANDO: "Seu pedido está sendo preparado com carinho! Logo ficará pronto. ⏳",
            SAIU_PARA_ENTREGA: "Seu pedido saiu para entrega! O motoboy está a caminho. 🛵",
            PRONTO_PARA_RETIRADA: "Seu pedido está pronto para retirada no balcão! 🏪",
            padrao: "Seu pedido está em andamento. Em breve temos novidades! 😊",
          },
          es: {
            NOVO: "¡Recibimos tu pedido y estamos esperando la confirmación del restaurante. ¡Pronto te avisamos! 🍽️",
            CONFIRMADO: "¡Buenas noticias! El restaurante confirmó tu pedido y ya lo está preparando. 👨‍🍳",
            PAGO: "¡Pago confirmado! El restaurante está preparando tu pedido. 👨‍🍳",
            PREPARANDO: "¡Tu pedido se está preparando con cariño! Ya casi está listo. ⏳",
            SAIU_PARA_ENTREGA: "¡Tu pedido salió para entrega! El repartidor ya va en camino. 🛵",
            PRONTO_PARA_RETIRADA: "¡Tu pedido está listo para retirarlo en el mostrador! 🏪",
            padrao: "Tu pedido está en proceso. ¡Pronto te enviamos novedades! 😊",
          },
        };

        const numFmt = formatNumPedido(pedidoAtivo);
        const mapa = statusMsgs[idioma];
        const statusMsg = mapa[pedidoAtivo.status] || mapa.padrao;
        const resposta = `📦 *Pedido #${numFmt}*\n\n${statusMsg}`;

        await enviarMensagem(clienteNumero, resposta, instanceName);
        await salvarMensagem(sessao.id, "bot", resposta);
        io?.to("admin").emit("conversa:mensagem", {
          sessaoId: sessao.id,
          mensagem: { role: "bot", conteudo: resposta, createdAt: new Date() },
        });
      }
      return;
    }

    // ── f) Localização → guardar e perguntar pagamento ───────────────────────
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

      const msgPagamento = T[idioma].formaPagamento;

      await salvarMensagem(sessao.id, "bot", msgPagamento);
      io?.to("admin").emit("conversa:mensagem", {
        sessaoId: sessao.id,
        mensagem: { role: "bot", conteudo: msgPagamento, createdAt: new Date() },
      });
      await enviarMensagem(clienteNumero, msgPagamento, instanceName);
      return;
    }

    // ── e) Pagamento → tratar cada método ───────────────────────────────────
    if (sessao.estado === "AGUARDANDO_PAGAMENTO" && textoCliente) {
      const texto = textoCliente.toLowerCase();
      let metodoPagamento = null;
      // Tolerância a erros de digitação via stems comuns
      if (/dinh|efetiv|efectiv|\bcash\b|\bbillete\b/i.test(texto)) metodoPagamento = "Dinheiro";
      else if (/cart[aã]|cartao|m[aá]quin|t[ae]rjet[ae]|d[eé]bit|cr[eé]dit/i.test(texto)) metodoPagamento = "Cartão";
      else if (/transf|trasf|tranf|\bpix\b|\bbanco\b/i.test(texto)) metodoPagamento = "Transferência";

      if (!metodoPagamento) {
        const msg = T[idioma].pagamentoInvalido;
        await salvarMensagem(sessao.id, "cliente", textoCliente);
        await salvarMensagem(sessao.id, "bot", msg);
        io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "cliente", conteudo: textoCliente, createdAt: new Date() } });
        io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "bot", conteudo: msg, createdAt: new Date() } });
        await enviarMensagem(clienteNumero, msg, instanceName);
        return;
      }

      await salvarMensagem(sessao.id, "cliente", textoCliente);
      io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "cliente", conteudo: textoCliente, createdAt: new Date() } });

      // Dinheiro → perguntar troco
      if (metodoPagamento === "Dinheiro") {
        await atualizarSessao(sessao.id, { estado: "AGUARDANDO_TROCO" });
        const msgTroco = T[idioma].troco;
        await salvarMensagem(sessao.id, "bot", msgTroco);
        io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "bot", conteudo: msgTroco, createdAt: new Date() } });
        await enviarMensagem(clienteNumero, msgTroco, instanceName);
        return;
      }

      // Cartão → finalizar com aviso de maquininha
      if (metodoPagamento === "Cartão") {
        const locPendente = sessao.localizacaoPendente || "retirada";
        const tipoEntrega = locPendente === "retirada" ? "retirada" : "delivery";
        const localizacao = tipoEntrega === "retirada" ? "Retirada no balcão" : locPendente;
        const pedido = await finalizarPedido(sessao.id, localizacao, tipoEntrega, metodoPagamento,
          tipoEntrega === "delivery" ? T[idioma].maquininha : "", idioma);
        io?.to("admin").emit("conversa:encerrada", { sessaoId: sessao.id });
        io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", { restauranteId: restaurante.id, pedido });
        return;
      }

      // Transferência → exibir dados bancários e finalizar
      if (metodoPagamento === "Transferência") {
        const locPendente = sessao.localizacaoPendente || "retirada";
        const tipoEntrega = locPendente === "retirada" ? "retirada" : "delivery";
        const localizacao = tipoEntrega === "retirada" ? "Retirada no balcão" : locPendente;
        const dadosTrans = restaurante.dadosTransferencia
          ? `\n\n🏦 *Dados para transferência:*\n${restaurante.dadosTransferencia}`
          : "";
        const pedido = await finalizarPedido(sessao.id, localizacao, tipoEntrega, metodoPagamento, dadosTrans, idioma);
        io?.to("admin").emit("conversa:encerrada", { sessaoId: sessao.id });
        io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", { restauranteId: restaurante.id, pedido });
        return;
      }
    }

    // ── e.2) Troco → finalizar pedido com dinheiro ────────────────────────────
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
        semTroco ? "" : T[idioma].trocoInfo(trocoInfo), idioma);

      io?.to("admin").emit("conversa:encerrada", { sessaoId: sessao.id });
      io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", { restauranteId: restaurante.id, pedido });
      return;
    }

    if (!textoCliente) return;

    // ── f) Pedido de cardápio em arquivo (PDF ou fotos) ──────────────────────
    if (
      restaurante.cardapioPdfUrl &&
      /cardápio|cardapio|menu|pdf|fotos?|foto do card/i.test(textoCliente) &&
      /manda|envia|envi|quero|pode|me pass|ver|mostrar|tem.*pdf|tem.*foto/i.test(textoCliente)
    ) {
      await salvarMensagem(sessao.id, "cliente", textoCliente);
      io?.to("admin").emit("conversa:mensagem", {
        sessaoId: sessao.id,
        mensagem: { role: "cliente", conteudo: textoCliente, createdAt: new Date() },
      });

      // Verifica se é array JSON de fotos
      let fotos = null;
      try {
        const parsed = JSON.parse(restaurante.cardapioPdfUrl);
        if (Array.isArray(parsed) && parsed.length > 0) fotos = parsed;
      } catch { /* single URL */ }

      if (fotos) {
        for (const url of fotos) {
          await enviarImagem(clienteNumero, url, "", instanceName);
        }
      } else if (/\.(jpg|jpeg|png|webp)$/i.test(restaurante.cardapioPdfUrl)) {
        await enviarImagem(clienteNumero, restaurante.cardapioPdfUrl, "", instanceName);
      } else {
        await enviarDocumento(clienteNumero, restaurante.cardapioPdfUrl, "cardapio.pdf", instanceName);
      }
      return;
    }

    const { resposta, novoEstado, carrinhoAtualizado, pedidoPronto, tipoEntrega, mostrarFotos } =
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

    // ── g) Enviar fotos do cardápio quando Claude sinalizar ───────────────────
    if (mostrarFotos && restaurante.cardapioPdfUrl) {
      let fotos = null;
      try {
        const parsed = JSON.parse(restaurante.cardapioPdfUrl);
        if (Array.isArray(parsed) && parsed.length > 0) fotos = parsed;
      } catch { /* single URL */ }

      if (fotos) {
        for (const url of fotos) {
          await enviarImagem(clienteNumero, url, "", instanceName);
        }
      } else if (/\.(jpg|jpeg|png|webp)$/i.test(restaurante.cardapioPdfUrl)) {
        await enviarImagem(clienteNumero, restaurante.cardapioPdfUrl, "", instanceName);
      }
    }

    // ── g) Pedido pronto → perguntar pagamento antes de finalizar ────────────
    if (pedidoPronto && novoEstado === "FINALIZADO") {
      sessao.carrinho = carrinhoAtualizado;
      const localizacao = tipoEntrega === "retirada" ? "Retirada no balcão" : textoCliente;

      // Guarda localização e muda estado para aguardar pagamento
      await atualizarSessao(sessao.id, {
        estado: "AGUARDANDO_PAGAMENTO",
        localizacaoPendente: localizacao,
      });

      const msgPagamento = T[idioma].formaPagamentoPedido;

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
