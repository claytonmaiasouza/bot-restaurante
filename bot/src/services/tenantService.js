const { PrismaClient } = require("@prisma/client");
const { buscarCardapioDB, temCardapioDB } = require("./cardapioService");

const prisma = new PrismaClient();

// Cache em memória: slug → { restaurante, cardapio, expiresAt }
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

function planoVencido(restaurante) {
  if (!restaurante.dataVencimento) return false;
  return new Date(restaurante.dataVencimento) < new Date();
}

function invalidarCache(slug) {
  cache.delete(slug);
}

/**
 * Resolve um restaurante pelo slug (número WhatsApp).
 * Ordem de busca: cache → banco local.
 */
async function resolverRestaurante(slug) {
  // Cache hit
  const cached = cache.get(slug);
  if (cached && cached.expiresAt > Date.now()) {
    return { restaurante: cached.restaurante, cardapio: cached.cardapio };
  }

  // Banco local
  const restaurante = await prisma.restaurante.findUnique({
    where: { slugWhatsapp: slug },
  });

  if (!restaurante) {
    const err = new Error(`Restaurante não encontrado: ${slug}`);
    err.code = "NAO_ENCONTRADO";
    throw err;
  }

  if (!restaurante.ativo) {
    const err = new Error(`Restaurante inativo: ${slug}`);
    err.code = "INATIVO";
    throw err;
  }

  if (planoVencido(restaurante)) {
    const err = new Error(`Plano vencido para: ${slug}`);
    err.code = "PLANO_VENCIDO";
    throw err;
  }

  // Cardápio do banco
  const cardapio = await buscarCardapioDB(restaurante.id);

  cache.set(slug, { restaurante, cardapio, expiresAt: Date.now() + CACHE_TTL_MS });

  return { restaurante, cardapio };
}

module.exports = { resolverRestaurante, invalidarCache };
