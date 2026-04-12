const axios = require("axios");

const strapiClient = axios.create({
  baseURL: process.env.STRAPI_URL,
  headers: {
    Authorization: `Bearer ${process.env.STRAPI_TOKEN}`,
    "Content-Type": "application/json",
  },
});

/**
 * Busca um restaurante no Strapi pelo slugWhatsapp (número do WhatsApp).
 * Retorna null se não encontrado.
 *
 * Estrutura esperada no Strapi:
 *   Collection: restaurantes
 *   Campos: nome, slugWhatsapp, donoWhatsapp, ativo
 */
async function buscarRestaurante(slug) {
  try {
    const { data } = await strapiClient.get("/api/restaurantes", {
      params: {
        "filters[slugWhatsapp][$eq]": slug,
        "filters[ativo][$eq]": true,
        populate: "*",
      },
    });

    const item = data?.data?.[0];
    if (!item) return null;

    return {
      id: item.id,
      nome: item.attributes?.nome || item.nome,
      slugWhatsapp: item.attributes?.slugWhatsapp || item.slugWhatsapp,
      donoWhatsapp: item.attributes?.donoWhatsapp || item.donoWhatsapp,
      ativo: item.attributes?.ativo ?? item.ativo,
    };
  } catch (err) {
    console.error("[strapi] erro ao buscar restaurante:", err.message);
    throw err;
  }
}

/**
 * Busca o cardápio de um restaurante no Strapi.
 * Retorna array de categorias com produtos.
 *
 * Estrutura esperada no Strapi:
 *   Collection: categorias
 *   Campos: nome, restaurante (relation), produtos (relation)
 *
 *   Collection: produtos
 *   Campos: nome, preco, descricao, disponivel, categoria (relation)
 *
 * Retorna:
 * [
 *   {
 *     nome: "Pizzas",
 *     produtos: [
 *       { nome: "Margherita", preco: 42.90, descricao: "Molho, mussarela, manjericão" }
 *     ]
 *   }
 * ]
 */
async function buscarCardapio(strapiRestauranteId) {
  try {
    const { data } = await strapiClient.get("/api/categorias", {
      params: {
        "filters[cardapio][restaurante][id][$eq]": strapiRestauranteId,
        "populate": "produtos",
        "fields": "nome",
      },
    });

    if (!data?.data?.length) return [];

    return data.data.map((categoria) => {
      const attrs = categoria.attributes || categoria;
      const produtosRaw = attrs.produtos?.data || attrs.produtos || [];

      const produtos = produtosRaw
        .map((p) => {
          const pa = p.attributes || p;
          return {
            nome: pa.nome,
            preco: parseFloat(pa.preco) || 0,
            descricao: pa.descricao || null,
            disponivel: pa.disponivel,
          };
        })
        .filter((p) => p.nome && p.preco > 0 && p.disponivel !== false);

      return {
        nome: attrs.nome,
        produtos,
      };
    }).filter((c) => c.produtos.length > 0);
  } catch (err) {
    console.error("[strapi] erro ao buscar cardápio:", err.message);
    throw err;
  }
}

module.exports = { buscarRestaurante, buscarCardapio };
