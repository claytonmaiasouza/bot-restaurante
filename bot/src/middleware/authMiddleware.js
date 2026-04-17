const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || process.env.ADMIN_TOKEN;

/**
 * Middleware que aceita autenticação via:
 * 1. x-admin-token header → super admin (role: "admin"), sem restrição de escopo
 * 2. Authorization: Bearer <jwt> → dono do restaurante (role: "restaurante"), escopo restrito
 *
 * Injeta req.user = { role, restauranteId?, slug? }
 */
function authMiddleware(req, res, next) {
  // Super admin via token fixo
  const adminToken = req.headers["x-admin-token"];
  if (adminToken) {
    if (adminToken !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ error: "Não autorizado" });
    }
    req.user = { role: "admin" };
    return next();
  }

  // Dono do restaurante via JWT
  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.role !== "restaurante") {
        return res.status(403).json({ error: "Acesso negado" });
      }
      req.user = { role: "restaurante", restauranteId: payload.restauranteId, slug: payload.slug, email: payload.email };
      return next();
    } catch {
      return res.status(401).json({ error: "Token inválido ou expirado" });
    }
  }

  return res.status(401).json({ error: "Autenticação necessária" });
}

module.exports = { authMiddleware };
