const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const { enviarPedidoParaDono, proximoNumeroDia, formatNumPedido } = require("../services/pedidoService");
const { enviarBotoes } = require("../services/evolutionService");

const prisma = new PrismaClient();

// GET /loja/:slug — cardápio público (sem autenticação)
router.get("/:slug", async (req, res) => {
  try {
    const restaurante = await prisma.restaurante.findUnique({
      where: { slugWhatsapp: req.params.slug },
      include: {
        categorias: {
          where: { ativo: true },
          orderBy: { ordem: "asc" },
          include: {
            produtos: {
              where: { ativo: true },
              orderBy: { nome: "asc" },
              include: { tamanhos: { orderBy: { preco: "asc" } } },
            },
          },
        },
      },
    });

    if (!restaurante || !restaurante.ativo) {
      return res.status(404).json({ erro: "Restaurante não encontrado" });
    }

    const diasMapa = { 0: "DOM", 1: "SEG", 2: "TER", 3: "QUA", 4: "QUI", 5: "SEX", 6: "SAB" };
    const hoje = diasMapa[new Date().getDay()];

    const todasPromocoes = await prisma.promocao.findMany({
      where: { restauranteId: restaurante.id, ativa: true, mostrarDelivery: true },
      orderBy: { createdAt: "asc" },
    });

    const promocoesHoje = todasPromocoes.filter(p => {
      const dias = Array.isArray(p.recorrencia) ? p.recorrencia : [];
      return !dias.length || dias.includes(hoje);
    }).map(p => ({
      id: p.id,
      nome: p.nome,
      descricao: p.descricao || null,
      tipo: p.tipo,
      itens: Array.isArray(p.itens) ? p.itens : [],
      regra: p.regra || {},
      precoPromocional: p.precoPromocional,
    }));

    res.json({
      restaurante: {
        nome: restaurante.nome,
        taxaEntrega: restaurante.taxaEntrega,
        moeda: restaurante.moeda,
        dadosTransferencia: restaurante.dadosTransferencia || null,
      },
      promocoes: promocoesHoje,
      cardapio: restaurante.categorias
        .filter((cat) => {
          const canais = Array.isArray(cat.canais) ? cat.canais : ["SALAO", "DELIVERY", "WEB"];
          return canais.includes("WEB") && cat.produtos.length > 0;
        })
        .map((cat) => ({
          id: cat.id,
          nome: cat.nome,
          tipoTamanhos: cat.tipoTamanhos,
          tamanhos: cat.tamanhos || [],
          bordas: cat.bordas || [],
          imagemUrl: cat.imagemUrl || null,
          produtos: cat.produtos.map((p) => ({
            id: p.id,
            nome: p.nome,
            descricao: p.descricao || null,
            imagemUrl: p.imagemUrl || null,
            preco: p.tamanhos.length > 0 ? null : p.preco,
            tamanhos: p.tamanhos.length > 0 ? p.tamanhos.map((t) => ({
              id: t.id,
              nome: t.nome,
              preco: t.preco,
              precoComBorda: t.precoComBorda || null,
            })) : null,
          })),
        })),
    });
  } catch (e) {
    console.error("[loja] GET /:slug", e.message);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// POST /loja/:slug/pedido — criar pedido via site
router.post("/:slug/pedido", async (req, res) => {
  try {
    const { clienteNome, itens, tipoEntrega, endereco, metodoPagamento, trocoPara } = req.body;
    const rawNumero = req.body.clienteNumero || "";
    const digits = rawNumero.replace(/\D/g, "");
    const clienteNumero = digits.startsWith("0") && digits.length === 10
      ? "595" + digits.slice(1)
      : digits || rawNumero;

    if (!clienteNome || !clienteNumero || !Array.isArray(itens) || !itens.length) {
      return res.status(400).json({ erro: "Dados incompletos" });
    }

    const restaurante = await prisma.restaurante.findUnique({
      where: { slugWhatsapp: req.params.slug },
    });

    if (!restaurante || !restaurante.ativo) {
      return res.status(404).json({ erro: "Restaurante não encontrado" });
    }

    const subtotal = itens.reduce((acc, i) => acc + i.preco * (i.quantidade || 1), 0);
    const taxa = tipoEntrega === "retirada" ? 0 : (restaurante.taxaEntrega || 0);
    const total = subtotal + taxa;
    const localizacao = tipoEntrega === "retirada" ? "Retirada no balcão" : (endereco || "Não informado");
    const numeroDia = await proximoNumeroDia(restaurante.id);
    const moedaLocal = restaurante.moeda || "G$";
    const fmtV = (v) => `${moedaLocal} ${Number(v).toLocaleString("es-PY")}`;
    const metodoPagamentoFmt = metodoPagamento === "dinheiro" && trocoPara
      ? `Dinheiro - troco p/ ${fmtV(trocoPara)}`
      : metodoPagamento || null;

    // Cria sessão virtual + pedido
    const sessao = await prisma.sessao.create({
      data: {
        clienteNumero,
        clienteNome: clienteNome || null,
        restauranteId: restaurante.id,
        estado: "FINALIZADO",
        carrinho: itens,
      },
    });

    const pedido = await prisma.pedido.create({
      data: {
        sessaoId: sessao.id,
        restauranteId: restaurante.id,
        clienteNumero,
        clienteNome: clienteNome || null,
        itens,
        total,
        localizacao,
        metodoPagamento: metodoPagamentoFmt,
        origem: "SITE",
        numeroDia,
        status: "NOVO",
      },
    });

    const pedidoCompleto = { ...pedido, itens, total, subtotal, taxaEntrega: taxa };

    const instanceName = restaurante.instanceEvolution || restaurante.slugWhatsapp;

    // Notificar dono via WhatsApp (falha silenciosa — pedido já está salvo)
    enviarPedidoParaDono(pedidoCompleto, restaurante, tipoEntrega).catch(err =>
      console.error('[loja] erro ao notificar dono:', err.message)
    );

    // Emitir Socket.IO para o painel
    const io = req.app.get("io");
    if (io) {
      const payload = { pedido: pedidoCompleto, restaurante };
      io.to("admin").emit("pedido:novo", payload);
      io.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", payload);
    }

    const numeroPedido = formatNumPedido({ ...pedido, localizacao, origem: "SITE" });
    console.log(`[loja] pedido ${numeroPedido} criado — ${restaurante.nome} — ${clienteNome}`);

    // Confirmar ao cliente via WhatsApp com botão de rastreamento (falha silenciosa)
    const fmtTotal = (v) => `${moedaLocal} ${Number(v).toLocaleString("es-PY")}`;
    const msgEntrega = tipoEntrega === "retirada"
      ? "🏃 *Retiro en el local*"
      : `🛵 *Delivery* — ${localizacao}`;
    const trocoMsg = metodoPagamento === "dinheiro" && trocoPara
      ? `\n💵 *Pago en efectivo* — vuelto para ${fmtTotal(trocoPara)}`
      : "";
    const comprobanteMsg = metodoPagamento === "transferencia"
      ? `\n\n📸 *Por favor envía el comprobante de pago para confirmar tu pedido.*`
      : "";
    const trackingUrl = `${process.env.BOT_PUBLIC_URL || "https://bot.guiafinanceiro.pro"}/rastrear.html?pedido=${pedido.id}`;
    const msgBody =
      `Hola *${clienteNome}*! 👋 Recibimos tu pedido en *${restaurante.nome}* y ya notificamos al restaurante.\n\n` +
      `🛒 *${itens.length} item(s)*\n` +
      `💰 *Total: ${fmtTotal(total)}*\n` +
      `${msgEntrega}` +
      trocoMsg +
      comprobanteMsg;
    enviarBotoes(clienteNumero, {
      title: `✅ ¡Pedido #${numeroPedido} confirmado!`,
      body: msgBody,
      footer: `¡Muchas gracias por tu preferencia! 🙏 ${restaurante.nome}`,
      botoes: [{ type: "url", displayText: "📍 Acompanhar Pedido", url: trackingUrl }],
    }, instanceName).catch(err =>
      console.error("[loja] erro ao confirmar cliente:", err.message)
    );

    // Salvar contato / fidelidade do cliente
    prisma.clienteFidelidade.upsert({
      where: { numero_restauranteId: { numero: clienteNumero, restauranteId: restaurante.id } },
      create: { numero: clienteNumero, restauranteId: restaurante.id, nome: clienteNome || null, totalPedidos: 1, totalGasto: total, ultimoPedido: new Date() },
      update: { nome: clienteNome || undefined, totalPedidos: { increment: 1 }, totalGasto: { increment: total }, ultimoPedido: new Date() },
    }).catch(err => console.error("[loja] erro ao salvar fidelidade:", err.message));

    res.json({ pedidoId: pedido.id, numeroPedido });
  } catch (e) {
    console.error("[loja] POST /:slug/pedido", e.message);
    res.status(500).json({ erro: "Erro ao criar pedido" });
  }
});

module.exports = router;
