const { resolverRestaurante } = require("../services/tenantService");

/**
 * Middleware que resolve o restaurante pelo slug da URL,
 * valida se está ativo e com plano vigente, e injeta
 * `req.restaurante` e `req.cardapio` para uso nos controllers.
 *
 * Respostas de erro:
 *   404 — restaurante não encontrado ou inativo
 *   403 — plano vencido
 *   500 — falha de comunicação com Strapi/banco
 */
async function tenantMiddleware(req, res, next) {
  const slug = req.params.restauranteSlug;

  if (!slug) {
    return res.status(400).json({ error: "Slug do restaurante não informado" });
  }

  // Valida formato básico do slug (apenas dígitos, mín. 10)
  if (!/^\d{10,15}$/.test(slug)) {
    return res.status(400).json({
      error: "Slug inválido — use apenas dígitos com DDI (ex: 5511999999999)",
    });
  }

  try {
    const { restaurante, cardapio } = await resolverRestaurante(slug);

    // Injeta no request para uso downstream
    req.restaurante = restaurante;
    req.cardapio = cardapio;

    next();
  } catch (err) {
    if (err.code === "NAO_ENCONTRADO" || err.code === "INATIVO") {
      return res.status(404).json({ error: "Restaurante não encontrado ou inativo" });
    }

    if (err.code === "PLANO_VENCIDO") {
      return res.status(403).json({
        error: "Plano do restaurante vencido — entre em contato com o suporte",
      });
    }

    console.error(`[tenantMiddleware] erro ao resolver slug "${slug}":`, err.message);
    return res.status(500).json({ error: "Erro interno ao identificar restaurante" });
  }
}

module.exports = { tenantMiddleware };
