const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// ── Busca cardápio ativo (para o bot e app público) ──────────────────────────
async function buscarCardapioDB(restauranteId, canal = null) {
  const categorias = await prisma.categoria.findMany({
    where: { restauranteId, ativo: true },
    orderBy: { ordem: "asc" },
    include: {
      produtos: {
        where: { ativo: true },
        orderBy: { nome: "asc" },
        include: { tamanhos: { orderBy: { preco: "asc" } } },
      },
    },
  });

  const filtradas = canal
    ? categorias.filter((cat) => {
        const canais = Array.isArray(cat.canais) ? cat.canais : ["SALAO", "DELIVERY", "WEB"];
        return canais.includes(canal);
      })
    : categorias;

  return filtradas.map((cat) => ({
    id: cat.id,
    nome: cat.nome,
    ordem: cat.ordem,
    canais: Array.isArray(cat.canais) ? cat.canais : ["SALAO", "DELIVERY", "WEB"],
    tamanhos: cat.tamanhos || [],
    tipoTamanhos: cat.tipoTamanhos || "simples",
    bordas: cat.bordas || [],
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
  }));
}

// ── Busca cardápio completo para o painel admin (inclui inativos) ─────────────
async function buscarCardapioAdmin(restauranteId) {
  const categorias = await prisma.categoria.findMany({
    where: { restauranteId },
    orderBy: { ordem: "asc" },
    include: {
      produtos: {
        orderBy: { nome: "asc" },
        include: { tamanhos: { orderBy: { preco: "asc" } } },
      },
    },
  });

  return categorias.map((cat) => ({
    id: cat.id,
    nome: cat.nome,
    ordem: cat.ordem,
    ativo: cat.ativo,
    tamanhos: cat.tamanhos || [],
    tipoTamanhos: cat.tipoTamanhos || "simples",
    bordas: cat.bordas || [],
    imagemUrl: cat.imagemUrl || null,
    ocultarMobile: cat.ocultarMobile || false,
    visivelGarcom: cat.visivelGarcom !== false,
    canais: Array.isArray(cat.canais) ? cat.canais : ["SALAO", "DELIVERY", "WEB"],
    skuPrefixo: cat.skuPrefixo || '',
    produtos: cat.produtos.map((p) => ({
      id: p.id,
      nome: p.nome,
      descricao: p.descricao || null,
      sku: p.sku || null,
      imagemUrl: p.imagemUrl || null,
      preco: p.tamanhos.length > 0 ? null : p.preco,
      ativo: p.ativo,
      tamanhos: p.tamanhos.length > 0 ? p.tamanhos.map((t) => ({
        id: t.id,
        nome: t.nome,
        preco: t.preco,
        precoComBorda: t.precoComBorda || null,
      })) : null,
    })),
  }));
}

// ── Verifica se o restaurante tem cardápio no banco ───────────────────────────
async function temCardapioDB(restauranteId) {
  const count = await prisma.categoria.count({ where: { restauranteId } });
  return count > 0;
}

// ── CRUD Categorias ───────────────────────────────────────────────────────────
async function criarCategoria(restauranteId, nome, ordem = 0, tamanhos = [], tipoTamanhos = "simples", bordas = [], estacaoTipo = "GERAL", canais = ["SALAO", "DELIVERY", "WEB"], skuPrefixo = "") {
  return prisma.categoria.create({
    data: { restauranteId, nome, ordem, tamanhos, tipoTamanhos, bordas, estacaoTipo, canais, skuPrefixo: skuPrefixo || "" },
    include: { produtos: true },
  });
}

async function gerarProximoSku(prefixo) {
  if (!prefixo) return null;
  const rows = await prisma.$queryRaw`
    SELECT sku FROM "Produto"
    WHERE sku LIKE ${prefixo + '-%'}
    ORDER BY sku DESC
    LIMIT 1
  `;
  if (!rows.length) return `${prefixo}-0001`;
  const ultimo = rows[0].sku;
  const partes = ultimo.split('-');
  const numero = parseInt(partes[partes.length - 1], 10);
  if (isNaN(numero)) return `${prefixo}-0001`;
  return `${prefixo}-${String(numero + 1).padStart(4, '0')}`;
}

async function gerarSkusBulk(restauranteId) {
  const categorias = await prisma.categoria.findMany({
    where: { restauranteId, skuPrefixo: { not: "" } },
    include: { produtos: { where: { sku: null }, select: { id: true } } },
  });

  let total = 0;
  for (const cat of categorias) {
    for (const prod of cat.produtos) {
      const sku = await gerarProximoSku(cat.skuPrefixo);
      await prisma.produto.update({ where: { id: prod.id }, data: { sku } });
      total++;
    }
  }
  return total;
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

  let sku = dados.sku || null;
  if (!sku) {
    const cat = await prisma.categoria.findUnique({ where: { id: categoriaId }, select: { skuPrefixo: true } });
    if (cat?.skuPrefixo) sku = await gerarProximoSku(cat.skuPrefixo);
  }

  return prisma.produto.create({
    data: {
      categoriaId,
      nome,
      descricao: descricao || null,
      sku,
      preco: preco || 0,
      tamanhos: tamanhos?.length
        ? { create: tamanhos.map((t) => ({ nome: t.nome, preco: t.preco, precoComBorda: t.precoComBorda || null })) }
        : undefined,
    },
    include: { tamanhos: true },
  });
}

async function atualizarProduto(id, dados) {
  const { nome, descricao, sku, preco, ativo, visivelGarcom, tamanhos, imagemUrl } = dados;

  const data = {};
  if (nome !== undefined) data.nome = nome;
  if (descricao !== undefined) data.descricao = descricao;
  if (sku !== undefined) data.sku = sku || null;
  if (preco !== undefined) data.preco = preco;
  if (ativo !== undefined) data.ativo = ativo;
  if (visivelGarcom !== undefined) data.visivelGarcom = visivelGarcom;
  if (imagemUrl !== undefined) data.imagemUrl = imagemUrl;

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
    prisma.clienteFidelidade.findUnique({
      where: { numero_restauranteId: { numero: clienteNumero, restauranteId } },
    }),
  ]);

  const progressoCliente = {
    totalPedidos: cliente?.totalPedidos || 0,
    totalGasto: cliente?.totalGasto || 0,
    _hist: cliente || null,
  };

  return { programas, progressoCliente };
}

module.exports = {
  buscarCardapioDB,
  buscarCardapioAdmin,
  temCardapioDB,
  criarCategoria,
  atualizarCategoria,
  gerarSkusBulk,
  deletarCategoria,
  criarProduto,
  atualizarProduto,
  deletarProduto,
  atualizarTamanho,
  deletarTamanho,
  importarCardapio,
  buscarContextoFidelidade,
};
