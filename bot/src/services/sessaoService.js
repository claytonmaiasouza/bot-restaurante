const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Sessão expira após 2 horas de inatividade
const TEMPO_INATIVIDADE_MS = 2 * 60 * 60 * 1000;

/**
 * Busca uma sessão ativa para o cliente neste restaurante.
 * Se não existir, cria uma nova.
 */
async function criarOuBuscarSessao(clienteNumero, restauranteId) {
  // Busca sessão não-FINALIZADO mais recente (ordenada por ultimaAtividade)
  const sessaoExistente = await prisma.sessao.findFirst({
    where: { clienteNumero, restauranteId, estado: { not: "FINALIZADO" } },
    include: { mensagens: { orderBy: { createdAt: "asc" } } },
    orderBy: { ultimaAtividade: "desc" },
  });

  // Busca sessão FINALIZADO com pedido ainda em andamento (não ENTREGUE/CANCELADO)
  const sessaoComPedidoAtivo = await prisma.sessao.findFirst({
    where: {
      clienteNumero,
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
 * Correlaciona pelo pushName + instanceName.
 * Retorna null se não encontrar.
 */
async function buscarTelefoneDoLID(pushName, instanceName) {
  if (!pushName || !instanceName) return null;
  try {
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
