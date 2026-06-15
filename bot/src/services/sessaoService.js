const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Sessão expira após 2 horas de inatividade
const TEMPO_INATIVIDADE_MS = 2 * 60 * 60 * 1000;

/**
 * Busca uma sessão ativa para o cliente neste restaurante.
 * Se não existir, cria uma nova.
 */
async function criarOuBuscarSessao(clienteNumero, restauranteId) {
  // Números com 15+ dígitos são JIDs @lid sem sufixo (iOS com privacidade).
  // Incluímos esse número alternativo na busca para não criar sessão duplicada
  // quando a resolução @lid→telefone falha em algumas mensagens (ex: áudios).
  const isLid = /^\d{15,}$/.test(clienteNumero);
  const whereNumero = isLid
    ? { OR: [{ clienteNumero }, { clienteNumero: clienteNumero.replace(/^595/, "") }] }
    : { clienteNumero };

  // Busca sessão não-FINALIZADO mais recente (ordenada por ultimaAtividade)
  const sessaoExistente = await prisma.sessao.findFirst({
    where: { ...whereNumero, restauranteId, estado: { not: "FINALIZADO" } },
    include: { mensagens: { orderBy: { createdAt: "asc" } } },
    orderBy: { ultimaAtividade: "desc" },
  });

  // Busca sessão FINALIZADO com pedido ainda em andamento (não ENTREGUE/CANCELADO)
  const sessaoComPedidoAtivo = await prisma.sessao.findFirst({
    where: {
      ...whereNumero,
      restauranteId,
      estado: "FINALIZADO",
      pedido: { status: { notIn: ["ENTREGUE", "CANCELADO"] } },
    },
    include: { mensagens: { orderBy: { createdAt: "asc" } } },
    orderBy: { ultimaAtividade: "desc" },
  });

  // Se ambas existem, retorna a mais recente (pedido ativo tem prioridade se for mais novo)
  if (sessaoExistente && sessaoComPedidoAtivo) {
    const pedidoAtivoEhMaisRecente =
      sessaoComPedidoAtivo.ultimaAtividade > sessaoExistente.ultimaAtividade;
    const chosen = pedidoAtivoEhMaisRecente ? sessaoComPedidoAtivo : sessaoExistente;
    await prisma.sessao.update({
      where: { id: chosen.id },
      data: pedidoAtivoEhMaisRecente
        ? { ultimaAtividade: new Date() }
        : { ultimaAtividade: new Date(), lembreteEnviado: false },
    });
    return chosen;
  }

  if (sessaoExistente) {
    await prisma.sessao.update({
      where: { id: sessaoExistente.id },
      data: { ultimaAtividade: new Date(), lembreteEnviado: false },
    });
    return sessaoExistente;
  }

  if (sessaoComPedidoAtivo) {
    await prisma.sessao.update({
      where: { id: sessaoComPedidoAtivo.id },
      data: { ultimaAtividade: new Date() },
    });
    return sessaoComPedidoAtivo;
  }

  // Sessão FINALIZADO com pedido ENTREGUE aguardando comprovante: retorna ela
  // em vez de criar nova INICIO (evita sessão órfã enquanto pagamento pendente)
  const sessaoComPagamentoPendente = await prisma.sessao.findFirst({
    where: {
      clienteNumero,
      restauranteId,
      estado: "FINALIZADO",
      pedido: {
        status: "ENTREGUE",
        pago: false,
        metodoPagamento: { contains: "Transf", mode: "insensitive" },
      },
    },
    include: { mensagens: { orderBy: { createdAt: "asc" } } },
    orderBy: { ultimaAtividade: "desc" },
  });

  if (sessaoComPagamentoPendente) {
    await prisma.sessao.update({
      where: { id: sessaoComPagamentoPendente.id },
      data: { ultimaAtividade: new Date() },
    });
    return sessaoComPagamentoPendente;
  }

  // Cria nova sessão INICIO
  return prisma.sessao.create({
    data: { clienteNumero, restauranteId, estado: "INICIO", carrinho: [] },
    include: { mensagens: true },
  });
}

/**
 * Atualiza estado e/ou carrinho de uma sessão.
 */
async function atualizarSessao(sessaoId, { estado, carrinho, clienteNome, localizacaoPendente } = {}) {
  const data = { ultimaAtividade: new Date() };

  if (estado !== undefined) data.estado = estado;
  if (carrinho !== undefined) data.carrinho = carrinho;
  if (clienteNome !== undefined) data.clienteNome = clienteNome;
  if (localizacaoPendente !== undefined) data.localizacaoPendente = localizacaoPendente;

  return prisma.sessao.update({
    where: { id: sessaoId },
    data,
  });
}

/**
 * Salva uma mensagem na sessão (role: "cliente" | "bot").
 */
async function salvarMensagem(sessaoId, role, conteudo) {
  return prisma.mensagem.create({
    data: {
      sessaoId,
      role,
      conteudo,
    },
  });
}

/**
 * Encerra sessões sem atividade há mais de 2 horas.
 * Chamado via cron a cada 30 minutos.
 */
async function encerrarSessoesInativas() {
  const limite = new Date(Date.now() - TEMPO_INATIVIDADE_MS);

  const { count } = await prisma.sessao.updateMany({
    where: {
      ultimaAtividade: { lt: limite },
      estado: { not: "FINALIZADO" },
    },
    data: {
      estado: "FINALIZADO",
    },
  });

  if (count > 0) {
    console.log(`[sessao] ${count} sessão(ões) inativa(s) encerrada(s)`);
  }

  return count;
}

async function buscarSessaoFinalizada(clienteNumero, restauranteId) {
  return prisma.sessao.findFirst({
    where: { clienteNumero, restauranteId, estado: "FINALIZADO" },
    orderBy: { ultimaAtividade: "desc" },
    include: { mensagens: { orderBy: { createdAt: "asc" }, take: 10 } },
  });
}

/**
 * Tenta resolver um JID @lid para o número de telefone real consultando
 * a tabela Contact da Evolution API (mesmo banco PostgreSQL).
 * Método 1 (primário): correlaciona pelo pushName + instanceName.
 * Método 2 (fallback): busca diretamente pelo JID @lid quando pushName está ausente
 *   (ocorre em mensagens de áudio, imagem, reações de contatos iOS).
 * Retorna null se não encontrar.
 */
async function buscarTelefoneDoLID(pushName, instanceName, lidJid = null) {
  if (!instanceName) return null;
  try {
    // Método 1: por pushName (mais confiável)
    if (pushName) {
      const result = await prisma.$queryRaw`
        SELECT c."remoteJid"
        FROM "Contact" c
        JOIN "Instance" i ON c."instanceId" = i.id
        WHERE i.name = ${instanceName}
          AND c."pushName" = ${pushName}
          AND c."remoteJid" LIKE '%@s.whatsapp.net'
        LIMIT 1
      `;
      if (result.length > 0) {
        return result[0].remoteJid.replace("@s.whatsapp.net", "");
      }
    }
    // Método 2: por JID @lid (fallback quando pushName não está disponível)
    if (lidJid) {
      const result2 = await prisma.$queryRaw`
        SELECT c2."remoteJid"
        FROM "Contact" c2
        JOIN "Instance" i ON c2."instanceId" = i.id
        WHERE i.name = ${instanceName}
          AND c2."remoteJid" LIKE '%@s.whatsapp.net'
          AND c2."pushName" = (
            SELECT c1."pushName" FROM "Contact" c1
            JOIN "Instance" i1 ON c1."instanceId" = i1.id
            WHERE i1.name = ${instanceName} AND c1."remoteJid" = ${lidJid}
            LIMIT 1
          )
        LIMIT 1
      `;
      if (result2.length > 0) {
        const telefone = result2[0].remoteJid.replace("@s.whatsapp.net", "");
        console.log(`[sessao] @lid fallback (sem pushName): ${lidJid} → ${telefone}`);
        return telefone;
      }
    }
  } catch (e) {
    console.error("[sessao] erro ao resolver LID para telefone:", e.message);
  }
  return null;
}

/**
 * Dado um número sem sufixo @, busca o JID completo na tabela Contact
 * (pode ser @lid ou @s.whatsapp.net). Usado quando o webhook do Evolution API
 * omite o sufixo do remoteJid (comportamento observado em contatos @lid do iOS).
 * Retorna o JID completo ou null.
 */
async function buscarJidCompleto(numero, instanceName) {
  if (!numero || !instanceName) return null;
  const n = numero.replace(/@.+$/, "");
  try {
    const rows = await prisma.$queryRaw`
      SELECT c."remoteJid"
      FROM "Contact" c
      JOIN "Instance" i ON c."instanceId" = i.id
      WHERE i.name = ${instanceName}
        AND (c."remoteJid" = ${n + "@lid"} OR c."remoteJid" = ${n + "@s.whatsapp.net"})
      ORDER BY
        CASE WHEN c."remoteJid" LIKE '%@s.whatsapp.net' THEN 0 ELSE 1 END
      LIMIT 1
    `;
    if (rows.length > 0) return rows[0].remoteJid;
  } catch (e) {
    console.error("[sessao] erro ao buscar JID completo:", e.message);
  }
  return null;
}

/**
 * Dado um número (pode ser LID ou telefone real), busca o pushName na tabela
 * Contact da Evolution API. Usado como fallback quando mensagem.pushName é null
 * (ex: mensagens de áudio de contatos iOS com privacidade ativada).
 */
async function buscarNomeContato(numero, instanceName) {
  if (!numero || !instanceName) return null;
  const n = numero.replace(/@.+$/, "");
  try {
    const rows = await prisma.$queryRaw`
      SELECT c."pushName"
      FROM "Contact" c
      JOIN "Instance" i ON c."instanceId" = i.id
      WHERE i.name = ${instanceName}
        AND (c."remoteJid" = ${n + "@lid"} OR c."remoteJid" = ${n + "@s.whatsapp.net"})
        AND c."pushName" IS NOT NULL
      LIMIT 1
    `;
    if (rows.length > 0) return rows[0].pushName;
  } catch (e) {
    console.error("[sessao] erro ao buscar nome do contato:", e.message);
  }
  return null;
}

module.exports = {
  criarOuBuscarSessao,
  atualizarSessao,
  salvarMensagem,
  encerrarSessoesInativas,
  buscarSessaoFinalizada,
  buscarTelefoneDoLID,
  buscarJidCompleto,
  buscarNomeContato,
};
