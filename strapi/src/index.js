"use strict";

/**
 * Configura permissões públicas de leitura para as APIs usadas pelo bot.
 * Roda uma vez quando o Strapi inicia.
 */
async function configurarPermissoesPublicas(strapi) {
  const rolesPublicas = await strapi
    .query("plugin::users-permissions.role")
    .findOne({ where: { type: "public" } });

  if (!rolesPublicas) return;

  // APIs que o bot precisa ler sem autenticação
  const permissoesNecessarias = [
    { action: "api::restaurante.restaurante.find" },
    { action: "api::restaurante.restaurante.findOne" },
    { action: "api::cardapio.cardapio.find" },
    { action: "api::cardapio.cardapio.findOne" },
    { action: "api::categoria.categoria.find" },
    { action: "api::categoria.categoria.findOne" },
    { action: "api::produto.produto.find" },
    { action: "api::produto.produto.findOne" },
  ];

  for (const { action } of permissoesNecessarias) {
    const existente = await strapi
      .query("plugin::users-permissions.permission")
      .findOne({ where: { action, role: rolesPublicas.id } });

    if (!existente) {
      await strapi.query("plugin::users-permissions.permission").create({
        data: { action, role: rolesPublicas.id, enabled: true },
      });
      strapi.log.info(`[bootstrap] permissão pública criada: ${action}`);
    } else if (!existente.enabled) {
      await strapi.query("plugin::users-permissions.permission").update({
        where: { id: existente.id },
        data: { enabled: true },
      });
      strapi.log.info(`[bootstrap] permissão pública habilitada: ${action}`);
    }
  }
}

module.exports = {
  async register({ strapi }) {
    // Registros globais, se necessário
  },

  async bootstrap({ strapi }) {
    await configurarPermissoesPublicas(strapi);
  },
};
