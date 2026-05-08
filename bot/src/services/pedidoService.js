const { PrismaClient } = require("@prisma/client");
const { enviarMensagem } = require("./evolutionService");

const prisma = new PrismaClient();

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
async function finalizarPedido(sessaoId, localizacao, tipoEntrega = "delivery", metodoPagamento = null, mensagemExtra = "") {
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
        status: "NOVO",
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
  await enviarMensagem(
    sessao.clienteNumero,
    `✅ *Pedido #${numFormatado} confirmado!*\n\nRecebemos seu pedido e já notificamos o restaurante. Em breve entraremos em contato sobre o tempo de entrega. 🍽️${mensagemExtra}\n\n💰 *Total: ${fmtValor(total, sessao.restaurante.moeda || "R$")}*\n\nObrigado pela preferência! 😊`,
    instanceName
  );

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

  await enviarMensagem(
    pedido.clienteNumero,
    `🎉 Boa notícia! O restaurante *${pedido.restaurante.nome}* confirmou seu pedido #${formatNumPedido(pedido)} e já está preparando tudo para você. 🍽️`,
    pedido.restaurante.slugWhatsapp
  );

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

module.exports = { finalizarPedido, enviarPedidoParaDono, confirmarPedido, proximoNumeroDia, formatNumPedido };
