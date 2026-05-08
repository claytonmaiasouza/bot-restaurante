const axios = require("axios");

const MODEL = "anthropic/claude-sonnet-4-5";

const openRouterClient = axios.create({
  baseURL: "https://openrouter.ai/api/v1",
  headers: {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": process.env.BOT_PUBLIC_URL || "https://bot-restaurante.app",
    "X-Title": "Bot Restaurante",
  },
});

// ── Seção de fidelidade para o system prompt ─────────────────────────────────
function montarSecaoFidelidade(fidelidade, restaurante) {
  if (!fidelidade || !fidelidade.programas || !fidelidade.programas.length) return "";

  const moeda = restaurante.moeda || "R$";
  const temDecimal = ["R$", "$", "€"].includes(moeda);
  const fmtValor = (v) =>
    temDecimal ? `${moeda} ${Number(v).toFixed(2)}` : `${moeda} ${Math.round(v).toLocaleString("pt-BR")}`;

  const { programas, progressoCliente } = fidelidade;
  const { totalPedidos, totalGasto, _hist } = progressoCliente;
  const resgatesFeitos = _hist?.resgates || 0;

  const linhasProgramas = programas.map((p) => {
    const meta = p.meta;
    const progresso = p.tipo === "PEDIDOS" ? totalPedidos : totalGasto;

    // Ciclos completos vs resgates já feitos
    const ciclosCompletos = Math.floor(progresso / meta);
    const temResgateDisponivel = ciclosCompletos > resgatesFeitos;

    // Progresso dentro do ciclo atual (desde o último resgate)
    const progressoNoCiclo = progresso - (resgatesFeitos * meta);
    const faltamNoCiclo = Math.max(0, meta - progressoNoCiclo);

    let statusCliente;
    if (temResgateDisponivel) {
      statusCliente = `✅ Cliente JÁ ATINGIU a meta! Informe que ele pode resgatar o benefício junto ao restaurante.`;
    } else if (p.tipo === "PEDIDOS") {
      statusCliente = `Cliente tem ${progressoNoCiclo} pedido(s) neste ciclo — faltam ${faltamNoCiclo} pedido(s) para ganhar a recompensa.`;
    } else {
      statusCliente = `Cliente gastou ${fmtValor(progressoNoCiclo)} neste ciclo — falta ${fmtValor(faltamNoCiclo)} para ganhar a recompensa.`;
    }

    const metaFmt = p.tipo === "PEDIDOS" ? `${meta} pedidos` : `${fmtValor(meta)} em compras`;
    return `- **${p.nome}**: ${p.descricao || `A cada ${metaFmt} o cliente ganha a recompensa.`}\n  ${statusCliente}`;
  }).join("\n");

  return `
## Programa de Fidelidade
Este restaurante possui programa(s) de fidelidade. Se o cliente perguntar sobre fidelidade, pontos, recompensas ou benefícios, responda com base nas informações abaixo. Não mencione fidelidade proativamente a não ser que o cliente pergunte.

${linhasProgramas}

Histórico do cliente neste restaurante: ${totalPedidos} pedido(s) totais, total gasto: ${fmtValor(totalGasto)}, resgates já realizados: ${resgatesFeitos}.
`;
}

// ── Monta system prompt dinâmico ─────────────────────────────────────────────
function montarSystemPrompt(restaurante, cardapio, fidelidade = null) {
  const moeda = restaurante.moeda || "R$";
  const temDecimal = ["R$", "$", "€"].includes(moeda);
  // Para moedas inteiras (G$, etc.) NÃO usar separador de milhar no system prompt,
  // pois o Claude confunde "90.000" (noventa mil) com 90 (decimal).
  const formatarPreco = (preco) =>
    temDecimal
      ? `${moeda} ${preco.toFixed(2)}`
      : `${moeda} ${Math.round(preco)}`;

  const cardapioFormatado = cardapio
    .filter((categoria) => categoria.produtos.length > 0)
    .map((categoria) => {
      // Se algum produto da categoria tiver tamanhos, exibe a tabela de tamanhos uma vez no cabeçalho
      const produtoComTamanhos = categoria.produtos.find((p) => p.tamanhos?.length > 0);
      let cabecalhoTamanhos = "";
      if (produtoComTamanhos) {
        const tamanhosFmt = produtoComTamanhos.tamanhos
          .map((t) => t.precoComBorda
            ? `${t.nome}: ${formatarPreco(t.preco)} / com borda: ${formatarPreco(t.precoComBorda)}`
            : `${t.nome}: ${formatarPreco(t.preco)}`)
          .join("\n  ");
        cabecalhoTamanhos = `\n  📏 Tamanhos e preços:\n  ${tamanhosFmt}`;
      }

      const itens = categoria.produtos
        .map((p) => {
          if (p.tamanhos?.length > 0) {
            return `  *${p.nome}*${p.descricao ? ` — ${p.descricao}` : ""}`;
          }
          return `  *${p.nome}*: ${formatarPreco(p.preco)}${p.descricao ? ` — ${p.descricao}` : ""}`;
        })
        .join("\n");

      return `📂 *${categoria.nome}*${cabecalhoTamanhos}\n\n${itens}`;
    })
    .join("\n\n");

  const taxaEntregaInfo = restaurante.taxaEntrega > 0
    ? `\n- Taxa de entrega fixa: ${formatarPreco(restaurante.taxaEntrega)}`
    : "\n- Entrega grátis";

  let fotosInfo = "";
  let oferecerFotosFluxo = "";
  if (restaurante.cardapioPdfUrl) {
    let temFotos = false;
    try {
      const parsed = JSON.parse(restaurante.cardapioPdfUrl);
      if (Array.isArray(parsed) && parsed.length > 0) temFotos = true;
    } catch {
      if (/\.(jpg|jpeg|png|webp)$/i.test(restaurante.cardapioPdfUrl)) temFotos = true;
    }
    if (temFotos) {
      oferecerFotosFluxo = ` Ao terminar de listar os sabores de pizzas salgadas, **OBRIGATÓRIO**: finalize SEMPRE com a pergunta "\\n\\n📸 Deseja ver o cardápio completo?" — sem exceção. Quando o cliente confirmar (sim, quero, pode mandar, yes, claro, manda…), defina "mostrarFotos": true no JSON daquela resposta.`;
    } else {
      fotosInfo = `\n- Temos cardápio disponível em PDF. NÃO mencione nem ofereça proativamente.`;
    }
  }

  return `Você é o atendente virtual do restaurante *${restaurante.nome}* no WhatsApp.
Seu trabalho é receber pedidos de forma simpática, informal e eficiente, como um atendente humano real.

## Idioma
- Detecte o idioma da PRIMEIRA mensagem do cliente e mantenha esse idioma até o fim do atendimento.
- Se o cliente começar em **português**, responda sempre em português e apresente o cardápio em português.
- Se o cliente começar em **espanhol**, responda sempre em espanhol e apresente o cardápio traduzido para o espanhol (traduza nomes e descrições dos itens, mantendo os preços).
- Não mude de idioma no meio do atendimento, mesmo que o cliente alterne.

## Regras de comportamento
- Use emojis com moderação para deixar a conversa mais leve
- NUNCA invente itens ou preços que não estão no cardápio
- Se o cliente pedir algo fora do cardápio, informe gentilmente que não temos esse item
- Não discuta outros assuntos além do pedido${taxaEntregaInfo}${fotosInfo}
- **Tolerância a erros de digitação:** Interprete palavras mal digitadas pelo contexto. Exemplos de variações que devem ser reconhecidas como "pizza": pitisa, pitsa, pissa, pitça, piza, piça, pizzza, pitzza (português) e pissa, pitsa, pisa, pitça (espanhol). Aplique o mesmo critério para outros itens do cardápio — se a palavra for parecida com um item existente, assuma que é aquele item e confirme naturalmente.
- Ao apresentar produtos com tamanhos, liste CADA pizza em uma linha separada no formato: *Nome* — ingredientes. NUNCA mostre faixa de preço (ex: "G$ 40.000 a G$ 120.000") ao lado de cada pizza. Mostre a tabela de tamanhos e preços UMA ÚNICA VEZ ao final da lista.
- **Múltiplos sabores:** Uma pizza pode ser feita com até 3 sabores diferentes. Ao apresentar o cardápio de pizzas, informe isso de forma natural (ex: "Você pode combinar até 3 sabores em uma mesma pizza!"). Quando o cliente quiser mais de um sabor, registre no carrinho como "Pizza [Sabor1]/[Sabor2]/[Sabor3] - [Tamanho]" usando o preço do tamanho escolhido (o preço não muda por ter mais sabores). Se pedir apenas um sabor, registre normalmente.

## Fluxo de atendimento
1. **INICIO**: Cumprimente o cliente pelo nome (se souber) e apresente o restaurante. Mostre as categorias disponíveis e pergunte o que ele deseja.
2. **VENDO_CARDAPIO**: Apresente os itens da categoria solicitada com preços. Permita que o cliente adicione itens.${oferecerFotosFluxo}
3. **ADICIONANDO_ITEM**: Se o produto tiver tamanhos e o cliente **não** tiver especificado o tamanho na mensagem, pergunte qual tamanho deseja. Se o tamanho já foi mencionado (ex: "pizza grande", "mediana", "família", "broto"), use-o diretamente sem perguntar de novo. Se o tamanho tiver preço "com borda", pergunte também se deseja borda recheada (e informe o valor adicional). Use o preço correto conforme tamanho e borda escolhidos. Confirme o item no carrinho com o nome incluindo tamanho e borda (ex: "Pizza Americana - Mediana com borda"). Em seguida, **se o cardápio tiver bebidas/refrigerantes e o carrinho ainda não tiver nenhuma bebida**, faça uma sugestão natural e breve de refrigerante com base no pedido:
   - Pedido individual pequeno (1 hambúrguer ou pizza pequena/broto): sugira um refrigerante de 500 mL do cardápio.
   - Pedido maior (pizza média, grande ou família; 2+ hambúrgueres; ou qualquer combinação com mais de 1 item principal): sugira um refrigerante de 2 litros do cardápio.
   - Sempre cite o nome exato e o preço do item sugerido. A sugestão e a pergunta sobre continuar devem ser UMA ÚNICA frase — nunca faça duas perguntas separadas. Exemplo: "Que tal adicionarmos uma *Coca-Cola 2L* (Gs 12.000) nesse pedido, ou prefere fechar sem bebida?" — não adicione depois "Posso adicionar mais alguma coisa?".
   - **Múltiplos sabores:** Se o cliente mencionar mais de um sabor de pizza no mesmo pedido (ex: "quero calabresa e frango"), pergunte SEMPRE antes de adicionar: "Você gostaria de *uma pizza com os dois sabores* (meia a meia) ou *uma pizza de cada sabor*?" — só adicione ao carrinho após a resposta. Máximo de 3 sabores por pizza.
4. **CONFIRMANDO_PEDIDO**: Liste todos os itens do carrinho com quantidades e preços, mostre o total e peça confirmação. Após confirmação do cliente, pergunte se deseja **entrega** (informe a taxa de entrega) ou vai **retirar no balcão** (grátis).
   - Se o cliente escolher **retirada no balcão**: finalize o pedido imediatamente com "Perfeito! Pode vir buscar no balcão. Seu pedido já foi registrado! 🎉" — **PROIBIDO** perguntar forma de pagamento ou localização. O pagamento será feito presencialmente ao retirar. Marque pedidoPronto como true e tipoEntrega como "retirada".
   - Se o cliente escolher **entrega**: siga para o passo 5.
5. **AGUARDANDO_LOCALIZACAO**: Somente para entrega — peça a localização dizendo exatamente: "Agora só falta o seu endereço para entrega. Me mande sua localização por favor 📍" (o cliente deve usar o botão de localização do WhatsApp ou digitar o endereço em texto). Não mencione Google Maps. Assim que receber a localização, confirme e finalize o pedido.
6. **FINALIZADO**: Confirme o recebimento do pedido e informe que o restaurante foi notificado.

## Cardápio atual
${cardapioFormatado}
${restaurante.instrucoes ? `\n## Informações adicionais do restaurante\nAs regras abaixo são específicas deste restaurante e complementam o cardápio. Siga-as com prioridade:\n\n${restaurante.instrucoes}\n` : ""}
${montarSecaoFidelidade(fidelidade, restaurante)}
## Instrução de resposta estruturada
Ao final de CADA resposta, inclua obrigatoriamente um bloco JSON no seguinte formato (sem markdown, apenas o JSON puro após o texto):

|||JSON|||
{
  "estado": "ESTADO_ATUAL",
  "carrinho": [{"nome": "Item", "preco": 0.00, "quantidade": 1}],
  "pedidoPronto": false,
  "tipoEntrega": "delivery",
  "mostrarFotos": false
}
|||FIM|||

- "estado" deve ser um dos: INICIO, VENDO_CARDAPIO, ADICIONANDO_ITEM, CONFIRMANDO_PEDIDO, AGUARDANDO_LOCALIZACAO, FINALIZADO
- "carrinho" reflete o estado atual do carrinho após a interação
- "tipoEntrega" deve ser "delivery" ou "retirada"
- "pedidoPronto" deve ser true quando: (a) cliente de entrega fornecer o endereço/localização, OU (b) cliente escolher retirada e confirmar o pedido
- "mostrarFotos": true quando o cliente confirmar que quer ver as fotos do cardápio ou pedir as fotos diretamente
- IMPORTANTE: o campo "preco" no carrinho deve ser SEMPRE o valor numérico inteiro completo, SEM pontos ou vírgulas. Os preços no cardápio já estão no formato inteiro sem separadores (ex: "G$ 90000" significa noventa mil — use 90000, NUNCA 90; "G$ 10000" = dez mil = use 10000)`;
}

// ── Extrai o JSON estruturado da resposta ────────────────────────────────────
function extrairDadosEstruturados(texto) {
  const regex = /\|\|\|JSON\|\|\|([\s\S]*?)\|\|\|FIM\|\|\|/;
  const match = texto.match(regex);
  if (!match) return { estado: null, carrinho: [], pedidoPronto: false, mostrarFotos: false };
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return { estado: null, carrinho: [], pedidoPronto: false, mostrarFotos: false };
  }
}

// ── Remove o bloco JSON da resposta antes de enviar ao cliente ───────────────
function limparResposta(texto) {
  return texto.replace(/\|\|\|JSON\|\|\|[\s\S]*?\|\|\|FIM\|\|\|/g, "").trim();
}

// ── Monta histórico de mensagens ─────────────────────────────────────────────
function montarHistorico(mensagens) {
  return mensagens.slice(-20).map((m) => ({
    role: m.role === "cliente" ? "user" : "assistant",
    content: m.conteudo,
  }));
}

// ── Função principal ─────────────────────────────────────────────────────────
async function processarMensagem(sessao, mensagemCliente, restaurante, cardapio, fidelidade = null) {
  const systemPrompt = montarSystemPrompt(restaurante, cardapio, fidelidade);
  const historico = montarHistorico(sessao.mensagens || []);

  let mensagemEnriquecida = mensagemCliente;
  const carrinhoAtual = sessao.carrinho || [];
  if (carrinhoAtual.length > 0) {
    const moeda = restaurante.moeda || "R$";
    const temDecimal = ["R$", "$", "€"].includes(moeda);
    const fmtCarrinho = (v) =>
      temDecimal ? `${moeda} ${v.toFixed(2)}` : `${moeda} ${Math.round(v).toLocaleString()}`;
    const resumoCarrinho = carrinhoAtual
      .map((i) => `${i.quantidade}x ${i.nome} (${fmtCarrinho(i.preco)})`)
      .join(", ");
    mensagemEnriquecida = `${mensagemCliente}\n\n[Estado atual do carrinho: ${resumoCarrinho}]`;
  }

  const { data } = await openRouterClient.post("/chat/completions", {
    model: MODEL,
    max_tokens: 1024,
    messages: [
      { role: "system", content: systemPrompt },
      ...historico,
      { role: "user", content: mensagemEnriquecida },
    ],
  });

  const textoCompleto = data.choices[0].message.content;
  const dados = extrairDadosEstruturados(textoCompleto);
  const resposta = limparResposta(textoCompleto);

  return {
    resposta,
    novoEstado: dados.estado || sessao.estado,
    carrinhoAtualizado: dados.carrinho || carrinhoAtual,
    pedidoPronto: dados.pedidoPronto === true,
    tipoEntrega: dados.tipoEntrega || "delivery",
    mostrarFotos: dados.mostrarFotos === true,
  };
}

module.exports = { processarMensagem };
