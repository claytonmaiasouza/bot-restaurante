const express = require("express");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const { enviarPedidoParaDono, proximoNumeroDia, formatNumPedido } = require("../services/pedidoService");

const prisma = new PrismaClient();

// GET /loja/:slug — cardápio público (sem autenticação)
router.get("/:slug", async (req, res) => {
  try {
    const restaurante = await prisma.restaurante.findUnique({
      where: { slugWhatsapp: req.params.slug },
      include: {
        categorias: {
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

    res.json({
      restaurante: {
        nome: restaurante.nome,
        taxaEntrega: restaurante.taxaEntrega,
        moeda: restaurante.moeda,
        dadosTransferencia: restaurante.dadosTransferencia || null,
      },
      cardapio: restaurante.categorias
        .filter((cat) => cat.produtos.length > 0)
        .map((cat) => ({
          id: cat.id,
          nome: cat.nome,
          produtos: cat.produtos.map((p) => ({
            id: p.id,
            nome: p.nome,
            descricao: p.descricao || null,
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
    const { clienteNome, clienteNumero, itens, tipoEntrega, endereco, metodoPagamento } = req.body;

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
        metodoPagamento: metodoPagamento || null,
        origem: "SITE",
        numeroDia,
        status: "NOVO",
      },
    });

    const pedidoCompleto = { ...pedido, itens, total, subtotal, taxaEntrega: taxa };

    // Notificar dono via WhatsApp
    await enviarPedidoParaDono(pedidoCompleto, restaurante, tipoEntrega);

    // Emitir Socket.IO para o painel
    const io = req.app.get("io");
    if (io) {
      const payload = { pedido: pedidoCompleto, restaurante };
      io.to("admin").emit("pedido:novo", payload);
      io.to(`restaurante:${restaurante.slugWhatsapp}`).emit("pedido:novo", payload);
    }

    const numeroPedido = formatNumPedido({ ...pedido, localizacao, origem: "SITE" });
    console.log(`[loja] pedido ${numeroPedido} criado — ${restaurante.nome} — ${clienteNome}`);

    res.json({ pedidoId: pedido.id, numeroPedido });
  } catch (e) {
    console.error("[loja] POST /:slug/pedido", e.message);
    res.status(500).json({ erro: "Erro ao criar pedido" });
  }
});

module.exports = router;
