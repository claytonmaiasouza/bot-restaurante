const fs = require("fs");
const path = require("path");
const { processarMensagem } = require("../services/claudeService");
const { criarOuBuscarSessao, atualizarSessao, salvarMensagem, buscarSessaoFinalizada, buscarTelefoneDoLID, buscarJidCompleto, buscarNomeContato } = require("../services/sessaoService");
const { enviarMensagem, enviarImagem, enviarDocumento, baixarMidiaBase64 } = require("../services/evolutionService");
const { finalizarPedido, salvarComprovante, buscarPedidoAtivoDaSessao, buscarPedidoEntregueNaoPago, formatNumPedido } = require("../services/pedidoService");
const { transcreverAudio } = require("../services/transcricaoService");
const { buscarContextoFidelidade } = require("../services/cardapioService");
const { PrismaClient } = require("@prisma/client");
const _prisma = new PrismaClient();

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
    comprovanteRecebido: "✅ Comprovante recebido! Aguardando confirmação do pagamento pelo restaurante. Em breve você será notificado. 🍽️",
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
    comprovanteRecebido: "✅ ¡Comprobante recibido! Esperando confirmación del pago por el restaurante. Pronto te notificaremos. 🍽️",
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

function detectarMetodoPagamento(mensagens) {
  const clienteMsgs = (mensagens || [])
    .filter(m => m.role === "cliente")
    .map(m => m.conteudo)
    .reverse();
  for (const texto of clienteMsgs) {
    if (/dinh|efetiv|efectiv|\bcash\b|\bbillete\b/i.test(texto)) return "Dinheiro";
    if (/cart[aã]|cartao|m[aá]quin|t[ae]rjet[ae]|d[eé]bit|cr[eé]dit/i.test(texto)) return "Cartão";
    if (/transf|trasf|tranf|\btrans\b|\bpix\b|\bbanco\b/i.test(texto)) return "Transferência";
  }
  return null;
}

// Extrai o valor numérico de uma resposta informal de troco
// Ex: "200 mil guarani" → 200000, "200.000" → 200000, "250000" → 250000
function parsearValorTroco(texto) {
  // "X mil" → multiplica por 1000 (ex: "200 mil", "100 mil guaranies")
  const milMatch = texto.match(/(\d[\d.]*)\s*mil/i);
  if (milMatch) {
    const base = parseInt(milMatch[1].replace(/\./g, ""), 10);
    if (!isNaN(base) && base > 0) return base * 1000;
  }
  // Remove tudo que não é dígito e parseia como inteiro
  const apenasDigitos = texto.replace(/[^\d]/g, "");
  if (!apenasDigitos) return null;
  const valor = parseInt(apenasDigitos, 10);
  return !isNaN(valor) && valor > 0 ? valor : null;
}

function formatarTroco(valorNumerico, moeda) {
  const temDecimal = ["R$", "$", "€"].includes(moeda);
  return temDecimal
    ? `${moeda} ${valorNumerico.toFixed(2)}`
    : `${moeda} ${Math.round(valorNumerico).toLocaleString("pt-BR")}`;
}

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
    .replace("@g.us", "")
    .replace("@lid", "");
}

// Retorna o JID completo para envio (nunca remover o sufixo aqui)
function extrairJidEnvio(mensagem) {
  return mensagem.key?.remoteJid || "";
}

// ── Deduplicação de mensagens (Evolution API pode enviar o mesmo evento 2x) ──
const mensagensProcessadas = new Map(); // messageId → timestamp

function deduplicar(messageId) {
  if (!messageId) return false;
  if (mensagensProcessadas.has(messageId)) return true;
  mensagensProcessadas.set(messageId, Date.now());
  setTimeout(() => mensagensProcessadas.delete(messageId), 5 * 60 * 1000);
  return false;
}

// ── Controller principal ──────────────────────────────────────────────────────

/**
 * Processa eventos recebidos da Evolution API.
 *
 * O tenantMiddleware já rodou antes deste controller e injetou:
 *   req.restaurante — dados do restaurante (banco local)
 *   req.cardapio    — cardápio atualizado (banco local)
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

  // Deduplicação: ignora se o mesmo messageId já foi processado recentemente
  if (deduplicar(mensagem.key?.id)) {
    console.log(`[webhook] mensagem duplicada ignorada: ${mensagem.key?.id}`);
    return;
  }

  // remoteJid completo para envio (mantém @s.whatsapp.net / @lid / @g.us)
  let remoteJid = extrairJidEnvio(mensagem);
  if (!remoteJid) return;

  const instanceName = restaurante.instanceEvolution || evento.instance || restaurante.slugWhatsapp;

  // Alguns eventos do Evolution API omitem o sufixo @lid para contatos iOS —
  // nesse caso buscamos o JID completo na tabela Contact para poder enviar corretamente.
  if (!remoteJid.includes("@")) {
    const jidCompleto = await buscarJidCompleto(remoteJid, instanceName);
    if (jidCompleto) {
      console.log(`[webhook] JID sem sufixo "${remoteJid}" → resolvido para "${jidCompleto}"`);
      remoteJid = jidCompleto;
    } else {
      remoteJid = remoteJid + "@s.whatsapp.net";
    }
  }

  // Número para o CRM: tenta resolver LID → telefone real
  // Quando é @lid, também atualiza remoteJid para @s.whatsapp.net (envio funciona melhor)
  let clienteNumero = extrairNumeroCliente(mensagem);
  if (remoteJid.includes("@lid")) {
    // Passa o JID completo como fallback para quando pushName está ausente (áudio, imagem, etc.)
    const telefoneReal = await buscarTelefoneDoLID(mensagem.pushName || "", instanceName, remoteJid);
    if (telefoneReal) {
      clienteNumero = telefoneReal;
      remoteJid = telefoneReal + "@s.whatsapp.net";
    } else {
      // LID não resolvido: ignorar para não criar sessão fantasma com número inválido
      console.warn(`[webhook] LID não resolvido: ${remoteJid} — mensagem ignorada`);
      return;
    }
  }

  try {
    // ── Comprovante: imagem/PDF enviado após pedido finalizado ────────────────
    // Deve ser checado ANTES de criarOuBuscarSessao (que ignora sessões FINALIZADO)
    const tiposMidia = ["imageMessage", "documentMessage", "documentWithCaptionMessage"];
    if (tiposMidia.includes(mensagem.messageType)) {
      const sessaoFinalizada = await buscarSessaoFinalizada(clienteNumero, restaurante.id);
      if (sessaoFinalizada) {
        let { base64, mimeType } = await baixarMidiaBase64(instanceName, mensagem);
        // Evolution API pode ainda não ter a mídia disponível — tenta até 3 vezes
        if (!base64) {
          await new Promise(r => setTimeout(r, 3000));
          ({ base64, mimeType } = await baixarMidiaBase64(instanceName, mensagem));
        }
        if (!base64) {
          await new Promise(r => setTimeout(r, 7000));
          ({ base64, mimeType } = await baixarMidiaBase64(instanceName, mensagem));
        }
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
          await enviarMensagem(remoteJid, T[idiomaComp].comprovanteRecebido, instanceName);
          console.log(`[webhook] comprovante salvo: ${comprovanteUrl}`);
        } else {
          console.warn(`[webhook] falha ao baixar mídia do comprovante após retry — sessão ${sessaoFinalizada.id}`);
          const idiomaComp = detectarIdioma(sessaoFinalizada.mensagens || []);
          const msgErro = idiomaComp === "es"
            ? "No pudimos recibir tu imagen. Por favor, intenta enviarla nuevamente. 📷"
            : "Não conseguimos receber sua imagem. Por favor, tente enviar novamente. 📷";
          await enviarMensagem(remoteJid, msgErro, instanceName);
        }
        return;
      }
    }

    // ── Se há pedido entregue aguardando comprovante, informa o status ───────
    if (!remoteJid.includes("@g.us")) {
      const pedidoNaoPago = await buscarPedidoEntregueNaoPago(clienteNumero, restaurante.id);
      if (pedidoNaoPago) {
        const sessaoFinaliz = await buscarSessaoFinalizada(clienteNumero, restaurante.id);
        const numFmt = formatNumPedido(pedidoNaoPago);
        const textoEntrada = extrairTexto(mensagem) || "";
        const idiomaMsg = detectarIdioma(sessaoFinaliz?.mensagens || []) ||
          (/\b(hola|quiero|buenos|gracias|también|necesito|cuanto|cuánto|tengo|puedo|soy|hoy|voy|dónde|cómo)\b/i.test(textoEntrada) ? "es" : "pt");
        const msg = idiomaMsg === "es"
          ? `⏳ Tu pedido *#${numFmt}* está pendiente de confirmación de pago.\n\nEnvíanos el comprobante de transferencia para confirmar tu pedido. 📲`
          : `⏳ Seu pedido *#${numFmt}* aguarda confirmação de pagamento.\n\nEnvie o comprovante de transferência aqui para finalizarmos. 📲`;
        if (sessaoFinaliz) {
          if (textoEntrada) {
            await salvarMensagem(sessaoFinaliz.id, "cliente", textoEntrada);
            io?.to("admin").emit("conversa:mensagem", { sessaoId: sessaoFinaliz.id, mensagem: { role: "cliente", conteudo: textoEntrada, createdAt: new Date() } });
            io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("conversa:mensagem", { sessaoId: sessaoFinaliz.id, mensagem: { role: "cliente", conteudo: textoEntrada, createdAt: new Date() } });
          }
          await salvarMensagem(sessaoFinaliz.id, "bot", msg);
          io?.to("admin").emit("conversa:mensagem", { sessaoId: sessaoFinaliz.id, mensagem: { role: "bot", conteudo: msg, createdAt: new Date() } });
          io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("conversa:mensagem", { sessaoId: sessaoFinaliz.id, mensagem: { role: "bot", conteudo: msg, createdAt: new Date() } });
        }
        await enviarMensagem(remoteJid, msg, instanceName);
        return;
      }
    }

    // ── a) Buscar/criar sessão + contexto de fidelidade + promoções ─────────
    const [sessao, fidelidade, promocoes] = await Promise.all([
      criarOuBuscarSessao(clienteNumero, restaurante.id),
      buscarContextoFidelidade(restaurante.id, clienteNumero).catch(() => null),
      _prisma.promocao.findMany({ where: { restauranteId: restaurante.id, ativa: true }, orderBy: { createdAt: "asc" } }).catch(() => []),
    ]);

    let clienteNome = mensagem.pushName || sessao.clienteNome || null;
    // Fallback: busca pushName na tabela Contact quando a mensagem (ex: áudio de iOS) não traz o nome
    if (!clienteNome) {
      clienteNome = await buscarNomeContato(clienteNumero, instanceName);
    }
    if (clienteNome && clienteNome !== sessao.clienteNome) {
      await atualizarSessao(sessao.id, { clienteNome });
      sessao.clienteNome = clienteNome;
    }

    // Safety net incondicional: qualquer mensagem com pedido ENTREGUE aguardando
    // comprovante bloqueia o fluxo normal (cobre sessões abandonadas em qualquer estado)
    if (!remoteJid.includes("@g.us")) {
      const pedidoNaoPago = await buscarPedidoEntregueNaoPago(clienteNumero, restaurante.id);
      if (pedidoNaoPago) {
        const sessaoFinaliz2 = await buscarSessaoFinalizada(clienteNumero, restaurante.id);
        const numFmt = formatNumPedido(pedidoNaoPago);
        const textoEntrada = extrairTexto(mensagem) || "";
        const idiomaMsg2 = detectarIdioma(sessaoFinaliz2?.mensagens || []) ||
          (/\b(hola|quiero|buenos|gracias|también|necesito|cuanto|cuánto|tengo|puedo|soy|hoy|voy|dónde|cómo)\b/i.test(textoEntrada) ? "es" : "pt");
        const msgNaoPago = idiomaMsg2 === "es"
          ? `⏳ Tu pedido *#${numFmt}* está pendiente de confirmación de pago.\n\nEnvíanos el comprobante de transferencia para confirmar tu pedido. 📲`
          : `⏳ Seu pedido *#${numFmt}* aguarda confirmação de pagamento.\n\nEnvie o comprovante de transferência aqui para finalizarmos. 📲`;
        const sessaoAlvo = sessaoFinaliz2 || sessao;
        if (textoEntrada) {
          await salvarMensagem(sessaoAlvo.id, "cliente", textoEntrada);
          io?.to("admin").emit("conversa:mensagem", { sessaoId: sessaoAlvo.id, mensagem: { role: "cliente", conteudo: textoEntrada, createdAt: new Date() } });
          io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("conversa:mensagem", { sessaoId: sessaoAlvo.id, mensagem: { role: "cliente", conteudo: textoEntrada, createdAt: new Date() } });
        }
        await salvarMensagem(sessaoAlvo.id, "bot", msgNaoPago);
        io?.to("admin").emit("conversa:mensagem", { sessaoId: sessaoAlvo.id, mensagem: { role: "bot", conteudo: msgNaoPago, createdAt: new Date() } });
        io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("conversa:mensagem", { sessaoId: sessaoAlvo.id, mensagem: { role: "bot", conteudo: msgNaoPago, createdAt: new Date() } });
        await enviarMensagem(remoteJid, msgNaoPago, instanceName);
        return;
      }
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
      await enviarMensagem(remoteJid, T[idioma].fechado(sessao.clienteNome, descricao), instanceName);
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

        await enviarMensagem(remoteJid, resposta, instanceName);
        await salvarMensagem(sessao.id, "bot", resposta);
        io?.to("admin").emit("conversa:mensagem", {
          sessaoId: sessao.id,
          mensagem: { role: "bot", conteudo: resposta, createdAt: new Date() },
        });
      }
      return;
    }

    // ── f) Localização → guardar e perguntar pagamento (se não informado antes) ─
    // Aceita localização em qualquer estado ativo (não só AGUARDANDO_LOCALIZACAO),
    // pois o Claude pode ter avançado o estado incorretamente.
    const ESTADOS_ACEITA_LOCALIZACAO = [
      "AGUARDANDO_LOCALIZACAO", "CONFIRMANDO_PEDIDO", "ADICIONANDO_ITEM",
      "VENDO_CARDAPIO", "AGUARDANDO_PAGAMENTO",
    ];
    if (
      eMensagemDeLocalizacao(mensagem) &&
      ESTADOS_ACEITA_LOCALIZACAO.includes(sessao.estado)
    ) {
      console.log(`[webhook] localização recebida (estado: ${sessao.estado}) de ${clienteNumero}`);
      const localizacao = extrairLocalizacao(mensagem);
      await salvarMensagem(sessao.id, "cliente", `[localização] ${localizacao}`);

      const metodoPago = detectarMetodoPagamento(sessao.mensagens);
      if (metodoPago === "Dinheiro") {
        await atualizarSessao(sessao.id, { estado: "AGUARDANDO_TROCO", localizacaoPendente: localizacao });
        const msgTroco = T[idioma].troco;
        await salvarMensagem(sessao.id, "bot", msgTroco);
        io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "bot", conteudo: msgTroco, createdAt: new Date() } });
        await enviarMensagem(remoteJid, msgTroco, instanceName);
      } else if (metodoPago === "Cartão") {
        const pedido = await finalizarPedido(sessao.id, localizacao, "delivery", "Cartão", T[idioma].maquininha, idioma);
        io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", { restauranteId: restaurante.id, pedido });
      } else if (metodoPago === "Transferência") {
        const dadosTrans = restaurante.dadosTransferencia
          ? `\n\n🏦 *Dados para transferência:*\n${restaurante.dadosTransferencia}` : "";
        const pedido = await finalizarPedido(sessao.id, localizacao, "delivery", "Transferência", dadosTrans, idioma);
        io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", { restauranteId: restaurante.id, pedido });
      } else {
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
        await enviarMensagem(remoteJid, msgPagamento, instanceName);
      }
      return;
    }

    // ── e) Pagamento → tratar cada método ───────────────────────────────────
    if (sessao.estado === "AGUARDANDO_PAGAMENTO" && textoCliente) {
      const texto = textoCliente.toLowerCase();
      let metodoPagamento = null;
      // Tolerância a erros de digitação via stems comuns
      if (/dinh|efetiv|efectiv|\bcash\b|\bbillete\b/i.test(texto)) metodoPagamento = "Dinheiro";
      else if (/cart[aã]|cartao|m[aá]quin|t[ae]rjet[ae]|d[eé]bit|cr[eé]dit/i.test(texto)) metodoPagamento = "Cartão";
      else if (/transf|trasf|tranf|\btrans\b|\bpix\b|\bbanco\b/i.test(texto)) metodoPagamento = "Transferência";

      if (!metodoPagamento) {
        const msg = T[idioma].pagamentoInvalido;
        await salvarMensagem(sessao.id, "cliente", textoCliente);
        await salvarMensagem(sessao.id, "bot", msg);
        io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "cliente", conteudo: textoCliente, createdAt: new Date() } });
        io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "bot", conteudo: msg, createdAt: new Date() } });
        await enviarMensagem(remoteJid, msg, instanceName);
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
        await enviarMensagem(remoteJid, msgTroco, instanceName);
        return;
      }

      // Cartão → finalizar com aviso de maquininha
      if (metodoPagamento === "Cartão") {
        const locPendente = sessao.localizacaoPendente || "retirada";
        const tipoEntrega = locPendente === "retirada" ? "retirada" : "delivery";
        const localizacao = tipoEntrega === "retirada" ? "Retirada no balcão" : locPendente;
        const pedido = await finalizarPedido(sessao.id, localizacao, tipoEntrega, metodoPagamento,
          tipoEntrega === "delivery" ? T[idioma].maquininha : "", idioma);
        if (tipoEntrega !== "delivery") io?.to("admin").emit("conversa:encerrada", { sessaoId: sessao.id });
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
        if (tipoEntrega !== "delivery") io?.to("admin").emit("conversa:encerrada", { sessaoId: sessao.id });
        io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", { restauranteId: restaurante.id, pedido });
        return;
      }
    }

    // ── e.2) Troco → finalizar pedido com dinheiro ────────────────────────────
    if (sessao.estado === "AGUARDANDO_TROCO" && textoCliente) {
      const semTroco = /sem troco|sin cambio|não precisa|no necesito|exato|exacto/i.test(textoCliente);

      let trocoFormatado = null;
      let trocoDevolver = null;
      if (!semTroco) {
        const valorTroco = parsearValorTroco(textoCliente);
        const moeda = restaurante.moeda || "R$";
        trocoFormatado = valorTroco !== null
          ? formatarTroco(valorTroco, moeda)
          : textoCliente.trim(); // fallback: texto original se não conseguir parsear

        if (valorTroco !== null) {
          const tipoEntregaTemp = (sessao.localizacaoPendente || "retirada") === "retirada" ? "retirada" : "delivery";
          const subtotal = (sessao.carrinho || []).reduce((acc, item) => acc + item.preco * (item.quantidade || 1), 0);
          const taxaEntregaVal = tipoEntregaTemp === "retirada" ? 0 : (restaurante.taxaEntrega || 0);
          const totalPedido = subtotal + taxaEntregaVal;
          const troco = valorTroco - totalPedido;
          if (troco > 0) trocoDevolver = formatarTroco(troco, moeda);
        }
      }

      const metodoPagamento = semTroco
        ? "Dinheiro (sem troco)"
        : trocoDevolver
          ? `Dinheiro - Troco para ${trocoFormatado} (levar troco: ${trocoDevolver})`
          : `Dinheiro - Troco para ${trocoFormatado}`;

      await salvarMensagem(sessao.id, "cliente", textoCliente);
      io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "cliente", conteudo: textoCliente, createdAt: new Date() } });

      const locPendente = sessao.localizacaoPendente || "retirada";
      const tipoEntrega = locPendente === "retirada" ? "retirada" : "delivery";
      const localizacao = tipoEntrega === "retirada" ? "Retirada no balcão" : locPendente;
      const pedido = await finalizarPedido(sessao.id, localizacao, tipoEntrega, metodoPagamento,
        semTroco ? "" : T[idioma].trocoInfo(trocoFormatado), idioma);

      if (tipoEntrega !== "delivery") io?.to("admin").emit("conversa:encerrada", { sessaoId: sessao.id });
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
          await enviarImagem(remoteJid, url, "", instanceName);
        }
      } else if (/\.(jpg|jpeg|png|webp)$/i.test(restaurante.cardapioPdfUrl)) {
        await enviarImagem(remoteJid, restaurante.cardapioPdfUrl, "", instanceName);
      } else {
        await enviarDocumento(remoteJid, restaurante.cardapioPdfUrl, "cardapio.pdf", instanceName);
      }
      return;
    }

    const { resposta, novoEstado, carrinhoAtualizado, pedidoPronto, tipoEntrega, mostrarFotos } =
      await processarMensagem(sessao, textoCliente, restaurante, cardapio, fidelidade, promocoes);

    if (!resposta) {
      console.warn(`[webhook] resposta vazia do Claude para ${clienteNumero} — ignorando envio`);
      return;
    }

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
    await enviarMensagem(remoteJid, resposta, instanceName);

    // ── g) Enviar fotos do cardápio quando Claude sinalizar ───────────────────
    if (mostrarFotos && restaurante.cardapioPdfUrl) {
      let fotos = null;
      try {
        const parsed = JSON.parse(restaurante.cardapioPdfUrl);
        if (Array.isArray(parsed) && parsed.length > 0) fotos = parsed;
      } catch { /* single URL */ }

      if (fotos) {
        for (const url of fotos) {
          await enviarImagem(remoteJid, url, "", instanceName);
        }
      } else if (/\.(jpg|jpeg|png|webp)$/i.test(restaurante.cardapioPdfUrl)) {
        await enviarImagem(remoteJid, restaurante.cardapioPdfUrl, "", instanceName);
      }
    }

    // ── g) Pedido pronto → finalizar direto se pagamento já foi informado ───────
    if (pedidoPronto && novoEstado === "FINALIZADO") {
      sessao.carrinho = carrinhoAtualizado;
      const localizacao = tipoEntrega === "retirada" ? "Retirada no balcão" : textoCliente;

      const metodoPago = detectarMetodoPagamento([...sessao.mensagens, { role: "cliente", conteudo: textoCliente }]);
      if (metodoPago === "Dinheiro") {
        await atualizarSessao(sessao.id, { estado: "AGUARDANDO_TROCO", localizacaoPendente: localizacao });
        const msgTroco = T[idioma].troco;
        await salvarMensagem(sessao.id, "bot", msgTroco);
        io?.to("admin").emit("conversa:mensagem", { sessaoId: sessao.id, mensagem: { role: "bot", conteudo: msgTroco, createdAt: new Date() } });
        await enviarMensagem(remoteJid, msgTroco, instanceName);
      } else if (metodoPago === "Cartão") {
        const pedido = await finalizarPedido(sessao.id, localizacao, tipoEntrega, "Cartão",
          tipoEntrega === "delivery" ? T[idioma].maquininha : "", idioma);
        if (tipoEntrega !== "delivery") io?.to("admin").emit("conversa:encerrada", { sessaoId: sessao.id });
        io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", { restauranteId: restaurante.id, pedido });
      } else if (metodoPago === "Transferência") {
        const dadosTrans = restaurante.dadosTransferencia
          ? `\n\n🏦 *Dados para transferência:*\n${restaurante.dadosTransferencia}` : "";
        const pedido = await finalizarPedido(sessao.id, localizacao, tipoEntrega, "Transferência", dadosTrans, idioma);
        if (tipoEntrega !== "delivery") io?.to("admin").emit("conversa:encerrada", { sessaoId: sessao.id });
        io?.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", { restauranteId: restaurante.id, pedido });
      } else {
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
        await enviarMensagem(remoteJid, msgPagamento, instanceName);
      }
    }
  } catch (err) {
    console.error(`[webhook] erro (${restaurante.slugWhatsapp}):`, err.message);
    try {
      await enviarMensagem(
        remoteJid,
        "Desculpe, tive um probleminha aqui. Pode repetir sua mensagem? 😅",
        instanceName
      );
    } catch {
      // silencioso
    }
  }
}

module.exports = { receberMensagem };
