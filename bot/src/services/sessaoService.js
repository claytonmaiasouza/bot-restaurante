const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// Sessão expira após 2 horas de inatividade
const TEMPO_INATIVIDADE_MS = 2 * 60 * 60 * 1000;

/**
 * Busca uma sessão ativa para o cliente neste restaurante.
 * Se não existir, cria uma nova.
 */
async function criarOuBuscarSessao(clienteNumero, restauranteId) {
  const sessaoExistente = await prisma.sessao.findFirst({
    where: {
      clienteNumero,
      restauranteId,
      estado: { not: "FINALIZADO" },
    },
    include: {
      mensagens: {
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (sessaoExistente) {
    // Atualiza timestamp de atividade
    await prisma.sessao.update({
      where: { id: sessaoExistente.id },
      data: { ultimaAtividade: new Date(), lembreteEnviado: false },
    });
    return sessaoExistente;
  }

  // Cria nova sessão
  return prisma.sessao.create({
    data: {
      clienteNumero,
      restauranteId,
      estado: "INICIO",
      carrinho: [],
    },
    include: {
      mensagens: true,
    },
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

module.exports = {
  criarOuBuscarSessao,
  atualizarSessao,
  salvarMensagem,
  encerrarSessoesInativas,
};
