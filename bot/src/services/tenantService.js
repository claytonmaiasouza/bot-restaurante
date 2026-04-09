const { PrismaClient } = require("@prisma/client");
const { buscarRestaurante: buscarRestauranteStrapi } = require("./strapiService");
const { buscarCardapio } = require("./strapiService");

const prisma = new PrismaClient();

// Cache em memória: slug → { restaurante, cardapio, expiresAt }
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// ── Helpers ───────────────────────────────────────────────────────────────────

function planoVencido(restaurante) {
  if (!restaurante.dataVencimento) return false;
  return new Date(restaurante.dataVencimento) < new Date();
}

function invalidarCache(slug) {
  cache.delete(slug);
}

// ── Sincroniza um registro do Strapi para o banco local ──────────────────────

async function sincronizarRegistro(strapiRestaurante) {
  return prisma.restaurante.upsert({
    where: { strapiId: strapiRestaurante.id },
    update: {
      nome: strapiRestaurante.nome,
      slugWhatsapp: strapiRestaurante.slugWhatsapp,
      donoWhatsapp: strapiRestaurante.donoWhatsapp,
      ativo: strapiRestaurante.ativo,
    },
    create: {
      nome: strapiRestaurante.nome,
      slugWhatsapp: strapiRestaurante.slugWhatsapp,
      donoWhatsapp: strapiRestaurante.donoWhatsapp,
      strapiId: strapiRestaurante.id,
      ativo: strapiRestaurante.ativo,
    },
  });
}

// ── 1. resolverRestaurante ────────────────────────────────────────────────────

/**
 * Resolve um restaurante pelo slug (número WhatsApp).
 * Ordem de busca: cache → banco local → Strapi.
 * Valida se está ativo e com plano vigente.
 *
 * @param {string} slug - slugWhatsapp do restaurante
 * @returns {{ restaurante: object, cardapio: Array }}
 * @throws {Error} com .code "NAO_ENCONTRADO" | "INATIVO" | "PLANO_VENCIDO"
 */
async function resolverRestaurante(slug) {
  // Cache hit
  const cached = cache.get(slug);
  if (cached && cached.expiresAt > Date.now()) {
    return { restaurante: cached.restaurante, cardapio: cached.cardapio };
  }

  // Banco local
  let restaurante = await prisma.restaurante.findUnique({
    where: { slugWhatsapp: slug },
  });

  // Se não existe localmente, tenta o Strapi
  if (!restaurante) {
    const strapiDados = await buscarRestauranteStrapi(slug);
    if (!strapiDados) {
      const err = new Error(`Restaurante não encontrado: ${slug}`);
      err.code = "NAO_ENCONTRADO";
      throw err;
    }
    restaurante = await sincronizarRegistro(strapiDados);
  }

  // Valida ativo
  if (!restaurante.ativo) {
    const err = new Error(`Restaurante inativo: ${slug}`);
    err.code = "INATIVO";
    throw err;
  }

  // Valida plano
  if (planoVencido(restaurante)) {
    const err = new Error(`Plano vencido para: ${slug}`);
    err.code = "PLANO_VENCIDO";
    throw err;
  }

  // Carrega cardápio do Strapi
  const cardapio = await buscarCardapio(restaurante.strapiId);

  // Armazena no cache
  cache.set(slug, { restaurante, cardapio, expiresAt: Date.now() + CACHE_TTL_MS });

  return { restaurante, cardapio };
}

// ── 2. sincronizarRestaurantes ────────────────────────────────────────────────

/**
 * Busca todos os restaurantes ativos no Strapi e sincroniza com o banco local.
 * Chamado via cron a cada 10 minutos.
 *
 * @returns {number} quantidade de registros sincronizados
 */
async function sincronizarRestaurantes() {
  const axios = require("axios");

  const strapiClient = axios.create({
    baseURL: process.env.STRAPI_URL,
    headers: { Authorization: `Bearer ${process.env.STRAPI_TOKEN}` },
  });

  const { data } = await strapiClient.get("/api/restaurantes", {
    params: {
      "filters[ativo][$eq]": true,
      "fields": "nome,slugWhatsapp,donoWhatsapp,ativo",
      "pagination[pageSize]": 100,
    },
  });

  const lista = data?.data || [];

  for (const item of lista) {
    const attrs = item.attributes || item;
    await sincronizarRegistro({
      id: item.id,
      nome: attrs.nome,
      slugWhatsapp: attrs.slugWhatsapp,
      donoWhatsapp: attrs.donoWhatsapp,
      ativo: attrs.ativo,
    });

    // Invalida cache para forçar recarregamento do cardápio na próxima requisição
    invalidarCache(attrs.slugWhatsapp);
  }

  console.log(`[tenant] ${lista.length} restaurante(s) sincronizado(s) do Strapi`);
  return lista.length;
}

module.exports = { resolverRestaurante, sincronizarRestaurantes, invalidarCache };
