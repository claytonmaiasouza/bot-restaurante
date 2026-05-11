const { PrismaClient } = require("@prisma/client");
const { enviarMensagem } = require("./evolutionService");

const prisma = new PrismaClient();

function detectarIdioma(mensagens) {
  const texto = (mensagens || [])
    .filter(m => m.role === "cliente")
    .slice(0, 5)
    .map(m => m.conteudo)
    .join(" ")
    .toLowerCase();
  return /\b(hola|quiero|buenos|gracias|también|necesito|cuanto|cuánto|tengo|puedo|soy|hoy|voy|dónde|cómo)\b/.test(texto) ? "es" : "pt";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function idCurto(uuid) {
  return uuid.split("-")[0].toUpperCase();
}

function fmtValor(valor, moeda) {
  const temDecimal = ["R$", "$", "€"].includes(moeda);
  return temDecimal
    ? `${moeda} ${valor.toFixed(2)}`
    : `${moeda} ${Math.round(valor).toLocaleString()}`;
}

function formatarHorario(date) {
  return new Date(date).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Numeração diária ──────────────────────────────────────────────────────────

async function proximoNumeroDia(restauranteId) {
  const agora = new Date();
  // Dia começa às 05:00 UTC (01:00 horário local -4h) para cobrir serviço noturno
  const inicioDia = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 5, 0, 0, 0));
  if (agora < inicioDia) inicioDia.setUTCDate(inicioDia.getUTCDate() - 1);
  const count = await prisma.pedido.count({ where: { restauranteId, createdAt: { gte: inicioDia } } });
  return count + 1;
}

function formatNumPedido(pedido) {
  if (!pedido.numeroDia) return idCurto(pedido.id);
  const isMesa = pedido.origem === "MESA";
  const isRetirada = !isMesa && (!pedido.localizacao || pedido.localizacao === "Retirada no balcão");
  const prefixo = isMesa ? "M" : isRetirada ? "B" : "D";
  return `${prefixo}${pedido.numeroDia}`;
}

// ── 1. finalizarPedido ────────────────────────────────────────────────────────

/**
 * Finaliza o pedido: persiste no banco, atualiza fidelidade,
 * notifica o dono e confirma ao cliente.
 *
 * @param {string} sessaoId    - ID da sessão
 * @param {string} localizacao - Endereço ou link Google Maps
 * @returns {object}           - Pedido criado (com itens e total)
 */
async function finalizarPedido(sessaoId, localizacao, tipoEntrega = "delivery", metodoPagamento = null, mensagemExtra = "", idioma = "pt") {
  // a) Buscar sessão e carrinho
  const sessao = await prisma.sessao.findUnique({
    where: { id: sessaoId },
    include: { restaurante: true },
  });

  if (!sessao) throw new Error(`Sessão não encontrada: ${sessaoId}`);

  const carrinho = sessao.carrinho || [];
  if (!carrinho.length) {
    throw new Error("Carrinho vazio — não é possível finalizar o pedido");
  }

  // b) Calcular total (inclui taxa de entrega para bater com o faturamento)
  const subtotal = carrinho.reduce(
    (acc, item) => acc + item.preco * (item.quantidade || 1),
    0
  );
  const taxaEntrega = tipoEntrega === "retirada" ? 0 : (sessao.restaurante.taxaEntrega || 0);
  const total = subtotal + taxaEntrega;

  // c) Criar pedido + marcar sessão como FINALIZADO (transação atômica)
  const numeroDia = await proximoNumeroDia(sessao.restauranteId);
  const [pedido] = await prisma.$transaction([
    prisma.pedido.create({
      data: {
        sessaoId: sessao.id,
        restauranteId: sessao.restauranteId,
        clienteNumero: sessao.clienteNumero,
        clienteNome: sessao.clienteNome || null,
        itens: carrinho,
        total,
        localizacao,
        metodoPagamento: metodoPagamento || null,
        status: metodoPagamento === "Transferência" ? "NOVO" : "CONFIRMADO",
        numeroDia,
      },
    }),
    prisma.sessao.update({
      where: { id: sessao.id },
      data: { estado: "FINALIZADO" },
    }),
  ]);

  const pedidoCompleto = { ...pedido, itens: carrinho, total, subtotal, taxaEntrega };

  // d) Atualizar fidelidade
  await atualizarFidelidade(
    sessao.clienteNumero,
    sessao.clienteNome,
    total,
    sessao.restauranteId
  );

  // e) Notificar dono do restaurante
  await enviarPedidoParaDono(pedidoCompleto, sessao.restaurante, tipoEntrega);

  // f) Confirmar ao cliente
  const instanceName = sessao.restaurante.slugWhatsapp;
  const numFormatado = formatNumPedido({ ...pedido, localizacao, origem: "WHATSAPP" });
  const pedirComprovante = metodoPagamento === "Transferência";
  const msgConfirmacao = idioma === "es"
    ? `✅ *¡Pedido #${numFormatado} confirmado!*\n\n¡Recibimos tu pedido y ya notificamos al restaurante. Pronto nos pondremos en contacto sobre el tiempo de entrega. 🍽️${mensagemExtra}\n\n💰 *Total: ${fmtValor(total, sessao.restaurante.moeda || "R$")}*${pedirComprovante ? "\n\n📸 *Por favor envía el comprobante de pago para que podamos confirmar el pedido!*" : ""}\n\n¡Gracias por tu preferencia! 😊`
    : `✅ *Pedido #${numFormatado} confirmado!*\n\nRecebemos seu pedido e já notificamos o restaurante. Em breve entraremos em contato sobre o tempo de entrega. 🍽️${mensagemExtra}\n\n💰 *Total: ${fmtValor(total, sessao.restaurante.moeda || "R$")}*${pedirComprovante ? "\n\n📸 *Por favor envie o comprovante de pagamento para que possamos confirmar o pedido!*" : ""}\n\nObrigado pela preferência! 😊`;
  await enviarMensagem(sessao.clienteNumero, msgConfirmacao, instanceName);

  return pedidoCompleto;
}

// ── 2. enviarPedidoParaDono ───────────────────────────────────────────────────

/**
 * Formata e envia o resumo do pedido para o WhatsApp do dono do restaurante.
 *
 * @param {object} pedido      - Pedido com itens, total, localizacao, etc.
 * @param {object} restaurante - Dados do restaurante (slugWhatsapp, donoWhatsapp)
 */
async function enviarPedidoParaDono(pedido, restaurante, tipoEntrega = "delivery") {
  const moeda = restaurante.moeda || "R$";
  const fmt = (v) => fmtValor(v, moeda);

  // total já inclui a taxa de entrega (calculada em finalizarPedido)
  const taxaEntrega = pedido.taxaEntrega ?? (tipoEntrega === "retirada" ? 0 : (restaurante.taxaEntrega || 0));

  const itensFormatados = pedido.itens
    .map((i) => {
      const qtd = i.quantidade || 1;
      return `• ${qtd}x ${i.nome} — ${fmt(i.preco * qtd)}`;
    })
    .join("\n");

  const taxaLinha = tipoEntrega === "retirada"
    ? "\n🏪 *Retirada no balcão*"
    : taxaEntrega > 0 ? `\n🚚 *Taxa de entrega: ${fmt(taxaEntrega)}*` : "";

  const pagamentoLinha = pedido.metodoPagamento ? `\n💳 *Pagamento: ${pedido.metodoPagamento}*` : "";

  const mensagem =
    `🛵 *NOVO PEDIDO #${formatNumPedido(pedido)}*\n\n` +
    `👤 Cliente: ${pedido.clienteNome || "Não identificado"} (${pedido.clienteNumero})\n\n` +
    `🛒 *Itens:*\n${itensFormatados}${taxaLinha}\n\n` +
    `💰 *Total: ${fmt(pedido.total)}*${pagamentoLinha}\n\n` +
    `📍 *Localização:*\n${pedido.localizacao || "Não informada"}\n\n` +
    `⏰ ${formatarHorario(pedido.createdAt)}`;

  await enviarMensagem(
    restaurante.donoWhatsapp,
    mensagem,
    restaurante.slugWhatsapp
  );
}

// ── 3. confirmarPedido ────────────────────────────────────────────────────────

/**
 * Atualiza o status do pedido para CONFIRMADO e avisa o cliente.
 *
 * @param {string} pedidoId - ID do pedido
 * @returns {object}        - Pedido atualizado
 */
async function confirmarPedido(pedidoId) {
  const pedido = await prisma.pedido.update({
    where: { id: pedidoId },
    data: { status: "CONFIRMADO" },
    include: { restaurante: true },
  });

  const sessao = await prisma.sessao.findUnique({
    where: { id: pedido.sessaoId },
    include: { mensagens: { orderBy: { createdAt: "asc" }, take: 10 } },
  });
  const idioma = detectarIdioma(sessao?.mensagens || []);

  const msg = idioma === "es"
    ? `🎉 ¡Buenas noticias! El restaurante *${pedido.restaurante.nome}* confirmó tu pedido #${formatNumPedido(pedido)} y ya lo está preparando. 🍽️`
    : `🎉 Boa notícia! O restaurante *${pedido.restaurante.nome}* confirmou seu pedido #${formatNumPedido(pedido)} e já está preparando tudo para você. 🍽️`;

  await enviarMensagem(pedido.clienteNumero, msg, pedido.restaurante.slugWhatsapp);

  return pedido;
}

// ── 4. atualizarFidelidade (interno) ─────────────────────────────────────────

async function atualizarFidelidade(numero, nome, valorPedido, restauranteId) {
  const agora = new Date();
  await prisma.clienteFidelidade.upsert({
    where: { numero_restauranteId: { numero, restauranteId } },
    create: {
      numero,
      restauranteId,
      nome: nome || null,
      totalPedidos: 1,
      totalGasto: valorPedido,
      ultimoPedido: agora,
    },
    update: {
      ...(nome ? { nome } : {}),
      totalPedidos: { increment: 1 },
      totalGasto: { increment: valorPedido },
      ultimoPedido: agora,
    },
  });
}

// ── 5. salvarComprovante ──────────────────────────────────────────────────────

async function salvarComprovante(sessaoId, comprovanteUrl) {
  const pedido = await prisma.pedido.findFirst({ where: { sessaoId } });
  if (!pedido) return { pedidoId: null, statusChanged: false };
  const atualizado = await prisma.pedido.update({
    where: { id: pedido.id },
    data: { comprovanteUrl },
  });
  return { pedidoId: pedido.id, pedido: atualizado, statusChanged: false };
}

async function notificarStatusPedido(pedidoId, novoStatus) {
  try {
    const pedido = await prisma.pedido.findUnique({
      where: { id: pedidoId },
      include: { restaurante: true },
    });
    if (!pedido || !pedido.clienteNumero || pedido.origem === "MESA") return;

    let idioma = "pt";
    if (pedido.sessaoId) {
      const sessao = await prisma.sessao.findUnique({
        where: { id: pedido.sessaoId },
        include: { mensagens: { orderBy: { createdAt: "asc" }, take: 10 } },
      });
      idioma = detectarIdioma(sessao?.mensagens || []);
    }

    const num = formatNumPedido(pedido);
    const msgs = {
      pt: {
        PREPARANDO: `👨‍🍳 Seu pedido *#${num}* já está sendo preparado! Em breve ficará pronto. 🍽️`,
        PRONTO_PARA_RETIRADA: `✅ Seu pedido *#${num}* está pronto para retirada no balcão! Pode vir buscar. 🏪`,
        AGUARDANDO_DESPACHO: `✅ Seu pedido *#${num}* está pronto! Aguardando o motoboy para entrega. 📦`,
        EM_CAMINHO: `🛵 Seu pedido *#${num}* está a caminho! O motoboy já saiu para a entrega.`,
        ENTREGUE: `✅ Pedido *#${num}* entregue! Obrigado pela preferência! 😊`,
      },
      es: {
        PREPARANDO: `👨‍🍳 ¡Tu pedido *#${num}* ya se está preparando! En breve estará listo. 🍽️`,
        PRONTO_PARA_RETIRADA: `✅ ¡Tu pedido *#${num}* está listo para retirarlo en el mostrador! Puedes venir a buscarlo. 🏪`,
        AGUARDANDO_DESPACHO: `✅ ¡Tu pedido *#${num}* está listo! Esperando al repartidor para la entrega. 📦`,
        EM_CAMINHO: `🛵 ¡Tu pedido *#${num}* está en camino! El repartidor ya salió.`,
        ENTREGUE: `✅ ¡Pedido *#${num}* entregado! ¡Gracias por tu preferencia! 😊`,
      },
    };

    const msg = msgs[idioma]?.[novoStatus];
    if (msg) {
      await enviarMensagem(pedido.clienteNumero, msg, pedido.restaurante.slugWhatsapp);
    }
  } catch (e) {
    console.error("[pedidoService] notificarStatusPedido:", e.message);
  }
}

async function buscarPedidoAtivoDaSessao(sessaoId) {
  return prisma.pedido.findFirst({
    where: { sessaoId, status: { notIn: ["ENTREGUE", "CANCELADO"] } },
    orderBy: { createdAt: "desc" },
  });
}

module.exports = { finalizarPedido, enviarPedidoParaDono, confirmarPedido, proximoNumeroDia, formatNumPedido, salvarComprovante, buscarPedidoAtivoDaSessao, notificarStatusPedido };
