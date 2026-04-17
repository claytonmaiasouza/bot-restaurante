const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// ── Busca cardápio completo de um restaurante ─────────────────────────────────
async function buscarCardapioDB(restauranteId) {
  const categorias = await prisma.categoria.findMany({
    where: { restauranteId },
    orderBy: { ordem: "asc" },
    include: {
      produtos: {
        where: { ativo: true },
        orderBy: { nome: "asc" },
        include: { tamanhos: { orderBy: { preco: "asc" } } },
      },
    },
  });

  return categorias
    .map((cat) => ({
      id: cat.id,
      nome: cat.nome,
      ordem: cat.ordem,
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
    }))
    .filter((c) => c.produtos.length > 0);
}

// ── Verifica se o restaurante tem cardápio no banco ───────────────────────────
async function temCardapioDB(restauranteId) {
  const count = await prisma.categoria.count({ where: { restauranteId } });
  return count > 0;
}

// ── CRUD Categorias ───────────────────────────────────────────────────────────
async function criarCategoria(restauranteId, nome, ordem = 0) {
  return prisma.categoria.create({
    data: { restauranteId, nome, ordem },
    include: { produtos: true },
  });
}

async function atualizarCategoria(id, dados) {
  return prisma.categoria.update({
    where: { id },
    data: dados,
    include: { produtos: { include: { tamanhos: true } } },
  });
}

async function deletarCategoria(id) {
  return prisma.categoria.delete({ where: { id } });
}

// ── CRUD Produtos ─────────────────────────────────────────────────────────────
async function criarProduto(categoriaId, dados) {
  const { nome, descricao, preco, tamanhos } = dados;
  return prisma.produto.create({
    data: {
      categoriaId,
      nome,
      descricao: descricao || null,
      preco: preco || 0,
      tamanhos: tamanhos?.length
        ? { create: tamanhos.map((t) => ({ nome: t.nome, preco: t.preco, precoComBorda: t.precoComBorda || null })) }
        : undefined,
    },
    include: { tamanhos: true },
  });
}

async function atualizarProduto(id, dados) {
  const { nome, descricao, preco, ativo, tamanhos } = dados;

  const data = {};
  if (nome !== undefined) data.nome = nome;
  if (descricao !== undefined) data.descricao = descricao;
  if (preco !== undefined) data.preco = preco;
  if (ativo !== undefined) data.ativo = ativo;

  // Se tamanhos fornecidos, substitui todos
  if (tamanhos !== undefined) {
    data.tamanhos = {
      deleteMany: {},
      create: tamanhos.map((t) => ({
        nome: t.nome,
        preco: t.preco,
        precoComBorda: t.precoComBorda || null,
      })),
    };
  }

  return prisma.produto.update({
    where: { id },
    data,
    include: { tamanhos: true },
  });
}

async function deletarProduto(id) {
  return prisma.produto.delete({ where: { id } });
}

// ── CRUD Tamanhos ─────────────────────────────────────────────────────────────
async function atualizarTamanho(id, dados) {
  return prisma.tamanho.update({ where: { id }, data: dados });
}

async function deletarTamanho(id) {
  return prisma.tamanho.delete({ where: { id } });
}

// ── Migração em lote (usado pelo script de migração do Strapi) ────────────────
async function importarCardapio(restauranteId, categorias) {
  // Limpa cardápio existente antes de reimportar
  await prisma.categoria.deleteMany({ where: { restauranteId } });

  for (let i = 0; i < categorias.length; i++) {
    const cat = categorias[i];
    const categoria = await prisma.categoria.create({
      data: { restauranteId, nome: cat.nome, ordem: i },
    });

    for (const p of cat.produtos) {
      await prisma.produto.create({
        data: {
          categoriaId: categoria.id,
          nome: p.nome,
          descricao: p.descricao || null,
          preco: p.tamanhos?.length ? 0 : (p.preco || 0),
          tamanhos: p.tamanhos?.length
            ? {
                create: p.tamanhos.map((t) => ({
                  nome: t.nome,
                  preco: t.preco,
                  precoComBorda: t.precoComBorda || null,
                })),
              }
            : undefined,
        },
      });
    }
  }

  console.log(`[cardapio] importados ${categorias.length} categoria(s) para restaurante ${restauranteId}`);
}

// ── Contexto de fidelidade para o bot ────────────────────────────────────────
// Retorna { programas, progressoCliente } para enriquecer o system prompt

async function buscarContextoFidelidade(restauranteId, clienteNumero) {
  const [programas, cliente] = await Promise.all([
    prisma.programaFidelidade.findMany({
      where: { restauranteId, ativo: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.clienteFidelidade.findUnique({ where: { numero: clienteNumero } }),
  ]);

  let progressoCliente = { totalPedidos: 0, totalGasto: 0, resgates: {} };
  if (cliente) {
    const hist = Array.isArray(cliente.restaurantes) ? cliente.restaurantes : [];
    const r = hist.find((h) => h.restauranteId === restauranteId);
    if (r) {
      progressoCliente = {
        totalPedidos: r.pedidos || 0,
        totalGasto: r.gasto || 0,
        // mapa programaId→resgatesFeitos é construído no claudeService com os dados do hist
        _hist: r, // passa o objeto completo para o claudeService calcular corretamente
      };
    }
  }

  return { programas, progressoCliente };
}

module.exports = {
  buscarCardapioDB,
  temCardapioDB,
  criarCategoria,
  atualizarCategoria,
  deletarCategoria,
  criarProduto,
  atualizarProduto,
  deletarProduto,
  atualizarTamanho,
  deletarTamanho,
  importarCardapio,
  buscarContextoFidelidade,
};
