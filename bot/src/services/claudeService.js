const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = "claude-sonnet-4-5";

// ── Monta system prompt dinâmico ─────────────────────────────────────────────
function montarSystemPrompt(restaurante, cardapio) {
  const cardapioFormatado = cardapio
    .map((categoria) => {
      const itens = categoria.produtos
        .map(
          (p) =>
            `  - ${p.nome}: R$ ${p.preco.toFixed(2)}${p.descricao ? ` (${p.descricao})` : ""}`
        )
        .join("\n");
      return `📂 *${categoria.nome}*\n${itens}`;
    })
    .join("\n\n");

  return `Você é o atendente virtual do restaurante *${restaurante.nome}* no WhatsApp.
Seu trabalho é receber pedidos de forma simpática, informal e eficiente, como um atendente humano real.

## Regras de comportamento
- Responda SEMPRE em português brasileiro, de forma descontraída e amigável
- Use emojis com moderação para deixar a conversa mais leve
- NUNCA invente itens ou preços que não estão no cardápio
- Se o cliente pedir algo fora do cardápio, informe gentilmente que não temos esse item
- Não discuta outros assuntos além do pedido

## Fluxo de atendimento
1. **INICIO**: Cumprimente o cliente pelo nome (se souber) e apresente o restaurante. Mostre as categorias disponíveis e pergunte o que ele deseja.
2. **VENDO_CARDAPIO**: Apresente os itens da categoria solicitada com preços. Permita que o cliente adicione itens.
3. **ADICIONANDO_ITEM**: Confirme o item adicionado ao carrinho. Pergunte se deseja mais alguma coisa ou se pode fechar o pedido.
4. **CONFIRMANDO_PEDIDO**: Liste todos os itens do carrinho com quantidades e preços, mostre o total e peça confirmação.
5. **AGUARDANDO_LOCALIZACAO**: Após confirmação, peça o endereço de entrega. Aceite tanto link do Google Maps quanto endereço em texto.
6. **FINALIZADO**: Confirme o recebimento do pedido e informe que o restaurante foi notificado.

## Cardápio atual
${cardapioFormatado}

## Instrução de resposta estruturada
Ao final de CADA resposta, inclua obrigatoriamente um bloco JSON no seguinte formato (sem markdown, apenas o JSON puro após o texto):

|||JSON|||
{
  "estado": "ESTADO_ATUAL",
  "carrinho": [{"nome": "Item", "preco": 0.00, "quantidade": 1}],
  "pedidoPronto": false
}
|||FIM|||

- "estado" deve ser um dos: INICIO, VENDO_CARDAPIO, ADICIONANDO_ITEM, CONFIRMANDO_PEDIDO, AGUARDANDO_LOCALIZACAO, FINALIZADO
- "carrinho" reflete o estado atual do carrinho após a interação
- "pedidoPronto" deve ser true APENAS quando o cliente fornecer o endereço/localização`;
}

// ── Extrai o JSON estruturado da resposta do Claude ──────────────────────────
function extrairDadosEstruturados(texto) {
  const regex = /\|\|\|JSON\|\|\|([\s\S]*?)\|\|\|FIM\|\|\|/;
  const match = texto.match(regex);

  if (!match) {
    return { estado: null, carrinho: [], pedidoPronto: false };
  }

  try {
    return JSON.parse(match[1].trim());
  } catch {
    return { estado: null, carrinho: [], pedidoPronto: false };
  }
}

// ── Remove o bloco JSON da resposta antes de enviar ao cliente ───────────────
function limparResposta(texto) {
  return texto.replace(/\|\|\|JSON\|\|\|[\s\S]*?\|\|\|FIM\|\|\|/g, "").trim();
}

// ── Monta histórico de mensagens para a API ──────────────────────────────────
function montarHistorico(mensagens) {
  // Últimas 20 mensagens, convertidas para o formato Anthropic
  return mensagens.slice(-20).map((m) => ({
    role: m.role === "cliente" ? "user" : "assistant",
    content: m.conteudo,
  }));
}

// ── Função principal ─────────────────────────────────────────────────────────
/**
 * Processa uma mensagem do cliente e retorna a resposta do bot.
 *
 * @param {object} sessao - Sessão atual (com .mensagens e .carrinho)
 * @param {string} mensagemCliente - Texto enviado pelo cliente
 * @param {object} restaurante - Dados do restaurante
 * @param {Array}  cardapio - Cardápio formatado do Strapi
 * @returns {{ resposta: string, novoEstado: string, carrinhoAtualizado: Array, pedidoPronto: boolean }}
 */
async function processarMensagem(
  sessao,
  mensagemCliente,
  restaurante,
  cardapio
) {
  const systemPrompt = montarSystemPrompt(restaurante, cardapio);
  const historico = montarHistorico(sessao.mensagens || []);

  // Adiciona contexto do carrinho atual se não estiver vazio
  let mensagemEnriquecida = mensagemCliente;
  const carrinhoAtual = sessao.carrinho || [];
  if (carrinhoAtual.length > 0) {
    const resumoCarrinho = carrinhoAtual
      .map((i) => `${i.quantidade}x ${i.nome} (R$ ${i.preco.toFixed(2)})`)
      .join(", ");
    mensagemEnriquecida = `${mensagemCliente}\n\n[Estado atual do carrinho: ${resumoCarrinho}]`;
  }

  const messages = [
    ...historico,
    { role: "user", content: mensagemEnriquecida },
  ];

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  const textoCompleto = response.content[0].text;
  const dados = extrairDadosEstruturados(textoCompleto);
  const resposta = limparResposta(textoCompleto);

  return {
    resposta,
    novoEstado: dados.estado || sessao.estado,
    carrinhoAtualizado: dados.carrinho || carrinhoAtual,
    pedidoPronto: dados.pedidoPronto === true,
  };
}

module.exports = { processarMensagem };
