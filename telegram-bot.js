// ===== CARREGA VARIÁVEIS DE AMBIENTE =====
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');

// ============================
// CONFIGURAÇÕES (TODAS DO .ENV)
// ============================
const BOT_TOKEN = process.env.BOT_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

let DOMINIO_PUBLICO = '';

// Preços (em centavos)
const PRECO_POR_HORA = 250;  // R$ 2,50/hora
const PRECO_MINIMO = 25;     // R$ 0,25

// Lista de IDs de administradores
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id)) : [];

// ===== VALIDAÇÃO DE VARIÁVEIS OBRIGATÓRIAS =====
if (!BOT_TOKEN) {
  console.error('❌ ERRO CRÍTICO: BOT_TOKEN não definido no .env');
  process.exit(1);
}

if (!JWT_SECRET) {
  console.error('❌ ERRO CRÍTICO: JWT_SECRET não definido no .env');
  process.exit(1);
}

if (!MP_ACCESS_TOKEN) {
  console.warn('⚠️ AVISO: MP_ACCESS_TOKEN não definido - pagamentos PIX não funcionarão');
}

console.log('✅ [Bot] Variáveis de ambiente carregadas');

// ============================
// INICIALIZAÇÃO DO BOT
// ============================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ============================
// ESTADO E CACHE
// ============================
let userStates = {};
let pendingPayments = {};
let paymentCheckIntervals = {};

// ============================
// MODELS
// ============================
let User, AssetSize, PurchasedContent;

// ============================
// SERVIÇOS EXTERNOS
// ============================
let vouverService = {
  buscarDetalhes: null,
  estimarDuracao: null,
  atualizarCache: null,
  CACHE_CONTEUDO: null
};

// ============================
// FUNÇÕES AUXILIARES
// ============================

/**
 * Escapa caracteres especiais do Markdown do Telegram e remove
 * fontes Unicode estilizadas (letras matemáticas, negrito Unicode, etc.)
 * que quebram o parse_mode: 'Markdown'.
 */
function escaparMarkdown(texto) {
  if (!texto) return '';
  return texto
    // Remove fontes matemáticas Unicode (letras estilizadas tipo 𝓗𝓸𝓼𝓮𝓲𝓷)
    .replace(/[\u{1D400}-\u{1D7FF}]/gu, '')
    // Remove outros blocos Unicode decorativos comuns em nomes do Telegram
    .replace(/[\u{1F100}-\u{1F1FF}]/gu, '')
    // Escapa caracteres especiais do Markdown v1
    .replace(/([_*`\[])/g, '\\$1')
    .trim();
}

/**
 * Remove qualquer formatação Markdown de um texto para uso seguro em mensagens.
 * Útil quando não temos controle sobre o conteúdo (nomes de usuários, títulos, etc.)
 */
function sanitizarTexto(texto) {
  if (!texto) return '';
  return texto
    .replace(/[\u{1D400}-\u{1D7FF}]/gu, '')
    .replace(/[\u{1F100}-\u{1F1FF}]/gu, '')
    .replace(/[*_`\[\]()~>#+=|{}.!]/g, '')
    .trim();
}

function formatMoney(centavos) {
  return `R$ ${(centavos / 100).toFixed(2).replace('.', ',')}`;
}

function calcularPreco(minutos) {
  if (minutos <= 0) return PRECO_MINIMO;
  const precoExato = (PRECO_POR_HORA * minutos) / 60;
  const preco = Math.round(precoExato);
  console.log(`💰 [CALC] ${minutos}min × R$ ${(PRECO_POR_HORA/6000).toFixed(4)}/min = R$ ${(preco/100).toFixed(2)}`);
  return Math.max(preco, PRECO_MINIMO);
}

function formatTimeRemaining(expiresAt) {
  const now = new Date();
  const diff = expiresAt - now;
  if (diff <= 0) return '❌ EXPIRADO';
  const days    = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours   = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (days > 0)  return `⏰ ${days}d ${hours}h restantes`;
  if (hours > 0) return `⏰ ${hours}h ${minutes}m restantes`;
  return `⏰ ${minutes}m restantes`;
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

// ============================
// SISTEMA DE REGISTRO
// ============================

async function verificarOuCriarUsuario(msg) {
  const userId       = msg.from.id;
  const firstName    = msg.from.first_name || 'Usuário';
  const lastName     = msg.from.last_name || '';
  const username     = msg.from.username || null;
  const languageCode = msg.from.language_code || 'pt-BR';
  const isPremium    = msg.from.is_premium || false;

  try {
    let user = await User.findOne({ userId });

    if (!user) {
      console.log(`🆕 Novo usuário detectado: ${userId} (${firstName})`);
      user = new User({
        userId, firstName, lastName, username,
        credits: 0, isActive: true, isBlocked: false,
        registeredAt: new Date(), lastAccess: new Date(),
        metadata: { telegramLanguageCode: languageCode, isPremium }
      });
      await user.save();
      console.log(`✅ Usuário ${userId} cadastrado com sucesso!`);
      return { isNew: true, user };
    } else {
      user.lastAccess = new Date();
      user.firstName  = firstName;
      user.lastName   = lastName;
      user.username   = username;
      await user.save();
      return { isNew: false, user };
    }
  } catch (error) {
    console.error('Erro ao verificar/criar usuário:', error);
    return null;
  }
}

async function verificarBloqueio(userId) {
  try {
    const user = await User.findOne({ userId });
    if (user && user.isBlocked) {
      return { blocked: true, reason: user.blockedReason || 'Sua conta foi bloqueada pelo administrador.' };
    }
    return { blocked: false };
  } catch (error) {
    console.error('Erro ao verificar bloqueio:', error);
    return { blocked: false };
  }
}

async function getUserCredits(userId) {
  try {
    const user = await User.findOne({ userId });
    return user ? user.credits : 0;
  } catch (error) {
    console.error('Erro ao obter créditos:', error);
    return 0;
  }
}

async function addCredits(userId, centavos) {
  try {
    await User.findOneAndUpdate(
      { userId },
      { $inc: { credits: centavos } },
      { upsert: true, new: true }
    );
    console.log(`✅ Adicionados ${formatMoney(centavos)} ao usuário ${userId}`);
    return true;
  } catch (error) {
    console.error('Erro ao adicionar créditos:', error);
    return false;
  }
}

async function deductCredits(userId, centavos) {
  try {
    const user = await User.findOne({ userId });
    if (!user || user.credits < centavos) {
      console.log(`❌ Saldo insuficiente para usuário ${userId}`);
      return false;
    }
    user.credits       -= centavos;
    user.totalSpent    += centavos;
    user.totalPurchases += 1;
    await user.save();
    console.log(`✅ Deduzidos ${formatMoney(centavos)} do usuário ${userId}`);
    return true;
  } catch (error) {
    console.error('Erro ao deduzir créditos:', error);
    return false;
  }
}

function gerarTokenAcesso(userId, videoId, mediaType) {
  try {
    return jwt.sign(
      { userId, videoId, mediaType, exp: Math.floor(Date.now() / 1000) + 86400 },
      JWT_SECRET
    );
  } catch (error) {
    console.error('Erro ao gerar token:', error);
    return null;
  }
}

async function salvarConteudoComprado(userId, videoId, mediaType, title, price, episodeName = null, season = null) {
  try {
    const token = gerarTokenAcesso(userId, videoId, mediaType);
    if (!token) return null;

    const purchaseDate    = new Date();
    const horasExpiracao  = mediaType === 'movie' ? 24 : (7 * 24);
    const expiresAt       = new Date(purchaseDate.getTime() + (horasExpiracao * 60 * 60 * 1000));
    const sessionToken    = crypto.randomBytes(32).toString('hex');

    const purchase = new PurchasedContent({
      userId, videoId, mediaType, title, episodeName, season,
      purchaseDate, expiresAt, token, price, sessionToken
    });

    await purchase.save();

    const tempoTexto = mediaType === 'movie' ? '24 horas' : '7 dias';
    console.log(`💾 Conteúdo salvo: ${title} | User: ${userId} | Expira em ${tempoTexto}: ${expiresAt.toLocaleString('pt-BR')}`);
    return token;
  } catch (error) {
    console.error('Erro ao salvar conteúdo comprado:', error);
    return null;
  }
}

function clearUserState(chatId) {
  if (userStates[chatId]) delete userStates[chatId];
}

function showMainMenu(chatId, text = '🏠 *Menu Principal*') {
  bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [
        ['🔍 Buscar Filmes', '📺 Buscar Séries'],
        ['🎬 Filmes A-Z', '📺 Séries A-Z'],
        ['📦 Meu Conteúdo', '🔞 Conteúdo +18'],
        ['💰 Adicionar Créditos', '💳 Meu Saldo']
      ],
      resize_keyboard: true
    }
  }).catch(err => {
    // Fallback sem Markdown se falhar
    console.error('Erro ao enviar menu com Markdown, tentando sem:', err.message);
    bot.sendMessage(chatId, '🏠 Menu Principal', {
      reply_markup: {
        keyboard: [
          ['🔍 Buscar Filmes', '📺 Buscar Séries'],
          ['🎬 Filmes A-Z', '📺 Séries A-Z'],
          ['📦 Meu Conteúdo', '🔞 Conteúdo +18'],
          ['💰 Adicionar Créditos', '💳 Meu Saldo']
        ],
        resize_keyboard: true
      }
    }).catch(() => {});
  });
}

function mostrarAlfabeto(chatId, tipo) {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('');
  const keyboard = [];
  for (let i = 0; i < alfabeto.length; i += 5) {
    const linha = alfabeto.slice(i, i + 5).map(letra => ({
      text: letra,
      callback_data: `letter_${tipo}_${letra}_1`
    }));
    keyboard.push(linha);
  }
  keyboard.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);
  const tipoTexto = tipo === 'movies' ? 'Filmes' : 'Séries';
  bot.sendMessage(chatId,
    `🔤 *${tipoTexto} por Letra*\n\nSelecione a primeira letra:`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

async function listarPorLetra(chatId, tipo, letra, pagina = 1) {
  try {
    const ITENS_POR_PAGINA = 20;
    if (vouverService.CACHE_CONTEUDO.series.length === 0) await vouverService.atualizarCache();

    const isAdulto = (nome) => /[\[\(]xxx|\+18|adulto|hentai|playboy|brasileirinhas/i.test(nome);
    const lista = vouverService.CACHE_CONTEUDO[tipo] || [];

    let resultados;
    if (letra === '#') {
      resultados = lista.filter(i => !isAdulto(i.name) && /^[^a-zA-Z]/.test(i.name));
    } else {
      resultados = lista.filter(i => !isAdulto(i.name) && i.name.toUpperCase().startsWith(letra));
    }

    const totalItens   = resultados.length;
    const totalPaginas = Math.ceil(totalItens / ITENS_POR_PAGINA);
    const inicio       = (pagina - 1) * ITENS_POR_PAGINA;
    const fim          = inicio + ITENS_POR_PAGINA;
    const itensPagina  = resultados.slice(inicio, fim);

    if (totalItens === 0) {
      bot.sendMessage(chatId,
        `❌ *Nenhum resultado encontrado com "${letra}"*`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔤 Escolher Outra Letra', callback_data: `alphabet_${tipo}` }],
              [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
            ]
          }
        }
      );
      return;
    }

    const buttons = itensPagina.map(item => [{
      text: `${item.name.substring(0, 60)}${item.name.length > 60 ? '...' : ''}`,
      callback_data: `details_${item.id}_${tipo}`
    }]);

    const navRow = [];
    if (pagina > 1) navRow.push({ text: '◀️ Anterior', callback_data: `letter_${tipo}_${letra}_${pagina - 1}` });
    if (totalPaginas > 1) navRow.push({ text: `📄 ${pagina}/${totalPaginas}`, callback_data: 'noop' });
    if (pagina < totalPaginas) navRow.push({ text: 'Próximo ▶️', callback_data: `letter_${tipo}_${letra}_${pagina + 1}` });
    if (navRow.length > 0) buttons.push(navRow);

    buttons.push([
      { text: '🔤 Outra Letra', callback_data: `alphabet_${tipo}` },
      { text: '🏠 Menu', callback_data: 'back_main' }
    ]);

    const tipoTexto = tipo === 'movies' ? 'Filmes' : 'Séries';
    bot.sendMessage(chatId,
      `🔤 *${tipoTexto} - Letra "${letra}"*\n\n` +
      `📋 Mostrando ${inicio + 1}-${Math.min(fim, totalItens)} de ${totalItens} resultado${totalItens > 1 ? 's' : ''}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (error) {
    console.error('Erro ao listar por letra:', error);
    bot.sendMessage(chatId, '❌ Erro ao buscar conteúdo. Tente novamente.');
  }
}

async function mostrarMeuConteudo(chatId) {
  try {
    bot.sendMessage(chatId, '📦 Carregando seu conteúdo...');
    const conteudos = await PurchasedContent.find({
      userId: chatId,
      expiresAt: { $gt: new Date() }
    }).sort({ purchaseDate: -1 });

    if (conteudos.length === 0) {
      bot.sendMessage(chatId,
        `📦 *Meu Conteúdo*\n\nVocê ainda não comprou nenhum conteúdo.\n\n🎬 Explore filmes e séries no menu principal!`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔍 Buscar Filmes', callback_data: 'search_movies' }],
              [{ text: '📺 Buscar Séries', callback_data: 'search_series' }],
              [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
            ]
          }
        }
      );
      return;
    }

    const buttons = conteudos.map(item => {
      const nome  = item.episodeName ? `${item.title} - ${item.episodeName}` : item.title;
      const timer = formatTimeRemaining(item.expiresAt);
      const emoji = item.mediaType === 'movie' ? '🎬' : '📺';
      return [{
        text: `${emoji} ${nome.substring(0, 45)} | ${timer}`,
        callback_data: `mycontent_${item._id}`
      }];
    });

    buttons.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

    bot.sendMessage(chatId,
      `📦 *Meu Conteúdo*\n\n` +
      `Você tem ${conteudos.length} conteúdo${conteudos.length > 1 ? 's' : ''} disponível${conteudos.length > 1 ? 'is' : ''}:\n\n` +
      `💡 *Dica:* Filmes expiram em 24h, Séries em 7 dias`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (error) {
    console.error('Erro ao mostrar conteúdo:', error);
    bot.sendMessage(chatId, '❌ Erro ao carregar seu conteúdo. Tente novamente.');
  }
}

async function mostrarDetalhesConteudo(chatId, contentId) {
  try {
    const content = await PurchasedContent.findById(contentId);
    if (!content) { bot.sendMessage(chatId, '❌ Conteúdo não encontrado.'); return; }

    if (new Date() > content.expiresAt) {
      bot.sendMessage(chatId,
        `⏰ *Link Expirado*\n\nEste conteúdo expirou.\n\nVocê pode comprá-lo novamente se desejar assistir.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📦 Voltar ao Meu Conteúdo', callback_data: 'my_content' }],
              [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
            ]
          }
        }
      );
      return;
    }

    const playerUrl     = `${DOMINIO_PUBLICO}/player/${content.token}`;
    const timeRemaining = formatTimeRemaining(content.expiresAt);
    const emoji         = content.mediaType === 'movie' ? '🎬' : '📺';
    const tipo          = content.mediaType === 'movie' ? 'Filme' : 'Episódio';

    const mensagem =
      `${emoji} *${escaparMarkdown(content.title)}*\n\n` +
      (content.episodeName ? `📺 ${escaparMarkdown(content.episodeName)}\n\n` : '') +
      `💰 Preço pago: ${formatMoney(content.price)}\n` +
      `📅 Comprado em: ${new Date(content.purchaseDate).toLocaleDateString('pt-BR', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
      })}\n` +
      `👁️ Visualizações: ${content.viewCount}\n` +
      `${timeRemaining}\n\n` +
      `🎯 *Clique em "▶️ Assistir" para abrir o player!*`;

    bot.sendMessage(chatId, mensagem, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '▶️ Assistir Agora', url: playerUrl }],
          [{ text: '📦 Voltar ao Meu Conteúdo', callback_data: 'my_content' }],
          [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
        ]
      }
    });
  } catch (error) {
    console.error('Erro ao mostrar detalhes do conteúdo:', error);
    bot.sendMessage(chatId, '❌ Erro ao carregar detalhes. Tente novamente.');
  }
}

async function enviarVideoComLink(chatId, token, caption, precoNum, videoInfo, mediaType = 'movie') {
  console.log(`\n🎬 Enviando link: ${videoInfo}`);
  try {
    const playerUrl   = `${DOMINIO_PUBLICO}/player/${token}`;
    const tempoValido = mediaType === 'movie' ? '24 horas' : '7 dias';
    const emoji       = mediaType === 'movie' ? '🎬' : '📺';

    await bot.sendMessage(chatId,
      `✅ *Conteúdo Liberado!*\n\n` +
      `${escaparMarkdown(caption)}\n\n` +
      `${emoji} *Como assistir:*\n` +
      `1. Clique no botão "▶️ Assistir Agora"\n` +
      `2. O vídeo abrirá no seu navegador\n` +
      `3. Assista em tela cheia!\n\n` +
      `⏰ *Link válido por ${tempoValido}*\n` +
      `📦 Salvo em "Meu Conteúdo"\n` +
      `🔒 Link protegido por DRM`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '▶️ Assistir Agora', url: playerUrl }],
            [{ text: '📦 Meu Conteúdo', callback_data: 'my_content' }],
            [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
          ]
        }
      }
    );
    console.log(`✅ Link enviado com sucesso: ${videoInfo} (válido por ${tempoValido})`);
    return true;
  } catch (error) {
    console.error(`❌ Erro ao enviar link ${videoInfo}:`, error.message);
    await addCredits(chatId, precoNum);
    const saldoRestaurado = await getUserCredits(chatId);
    bot.sendMessage(chatId,
      `❌ *Erro ao Enviar Conteúdo*\n\n💰 Créditos devolvidos: ${formatMoney(precoNum)}\n💳 Saldo atual: ${formatMoney(saldoRestaurado)}`,
      { parse_mode: 'Markdown' }
    );
    return false;
  }
}

// ============================
// SISTEMA DE PAGAMENTO PIX
// ============================

async function criarPagamentoPix(userId, valorCentavos) {
  const valorReais    = valorCentavos / 100;
  const idempotencyKey = crypto.randomUUID();

  const paymentData = {
    transaction_amount: valorReais,
    description: `FastTV - Créditos ${formatMoney(valorCentavos)}`,
    payment_method_id: "pix",
    payer: {
      email: `user${userId}@fasttv.com`,
      first_name: "Cliente", last_name: "FastTV",
      identification: { type: "CPF", number: "12345678909" }
    },
    notification_url: `${DOMINIO_PUBLICO}/webhook/mercadopago`,
    external_reference: userId.toString(),
    metadata: { user_id: userId.toString(), amount_cents: valorCentavos }
  };

  try {
    console.log(`💳 Criando PIX - User: ${userId} | Valor: ${formatMoney(valorCentavos)}`);
    const response = await axios.post('https://api.mercadopago.com/v1/payments', paymentData, {
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey
      },
      timeout: 15000
    });

    const payment = response.data;
    console.log(`📱 PIX criado - ID: ${payment.id} | Status: ${payment.status}`);

    if (payment.status !== "pending" || payment.status_detail !== "pending_waiting_transfer") {
      console.error("❌ PIX não ficou pendente:", payment.status, payment.status_detail);
      return null;
    }

    const pixData = payment.point_of_interaction?.transaction_data;
    if (!pixData || !pixData.qr_code || !pixData.qr_code_base64) {
      console.error("❌ Dados do PIX não encontrados na resposta");
      return null;
    }

    pendingPayments[payment.id] = {
      userId, amount: valorCentavos, timestamp: Date.now(), status: 'pending', idempotencyKey
    };

    startPaymentVerification(payment.id, userId);

    return {
      paymentId: payment.id,
      pix_code: pixData.qr_code,
      pix_qr_base64: pixData.qr_code_base64,
      ticket_url: pixData.ticket_url || null
    };
  } catch (error) {
    console.error('❌ Erro ao criar PIX:', error.response?.data || error.message);
    return null;
  }
}

function startPaymentVerification(paymentId, userId) {
  if (paymentCheckIntervals[paymentId]) clearInterval(paymentCheckIntervals[paymentId]);

  let attempts = 0;
  const maxAttempts = 120;

  paymentCheckIntervals[paymentId] = setInterval(async () => {
    attempts++;
    try {
      const status = await checkPaymentStatus(paymentId);
      if (status === 'approved') {
        clearInterval(paymentCheckIntervals[paymentId]);
        delete paymentCheckIntervals[paymentId];
      } else if (status === 'cancelled' || status === 'rejected' || attempts >= maxAttempts) {
        clearInterval(paymentCheckIntervals[paymentId]);
        delete paymentCheckIntervals[paymentId];
        if (pendingPayments[paymentId]) {
          bot.sendMessage(userId, '⏰ O pagamento expirou ou foi cancelado. Tente novamente se desejar adicionar créditos.')
            .catch(() => {});
          delete pendingPayments[paymentId];
        }
      }
    } catch (error) {
      console.error(`Erro ao verificar pagamento ${paymentId}:`, error.message);
    }
  }, 5000);
}

async function checkPaymentStatus(paymentId) {
  try {
    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }, timeout: 10000 }
    );
    return response.data.status;
  } catch (error) {
    console.error(`Erro ao consultar pagamento ${paymentId}:`, error.message);
    return null;
  }
}

async function processarPagamentoAprovado(paymentId, userId, amount) {
  try {
    if (!pendingPayments[paymentId]) {
      console.log(`⚠️ Pagamento ${paymentId} já foi processado ou não existe`);
      return false;
    }

    const success = await addCredits(userId, amount);
    if (success) {
      delete pendingPayments[paymentId];
      if (paymentCheckIntervals[paymentId]) {
        clearInterval(paymentCheckIntervals[paymentId]);
        delete paymentCheckIntervals[paymentId];
      }

      const saldo = await getUserCredits(userId);
      bot.sendMessage(
        userId,
        `✅ *PAGAMENTO CONFIRMADO!*\n\n💰 +${formatMoney(amount)}\n💳 Saldo atual: ${formatMoney(saldo)}\n\nObrigado por recarregar! Aproveite seus créditos! 🎬`,
        { parse_mode: 'Markdown' }
      ).catch(err => console.error('Erro ao enviar notificação:', err.message));

      console.log(`✅ Pagamento processado: ${paymentId} | Usuário: ${userId} | Valor: ${formatMoney(amount)}`);
      return true;
    } else {
      console.error(`❌ Falha ao adicionar créditos para pagamento ${paymentId}`);
      return false;
    }
  } catch (error) {
    console.error('Erro ao processar pagamento aprovado:', error);
    return false;
  }
}

// ============================
// SISTEMA DE NOTIFICAÇÕES
// ============================

async function verificarConteudosExpirando() {
  try {
    const agora = new Date();
    const daquiA2Horas  = new Date(agora.getTime() + (2 * 60 * 60 * 1000));
    const daquiA24Horas = new Date(agora.getTime() + (24 * 60 * 60 * 1000));

    const filmesExpirando = await PurchasedContent.find({
      mediaType: 'movie', expiresAt: { $gt: agora, $lte: daquiA2Horas }, notificationSent: false
    });

    const seriesExpirando = await PurchasedContent.find({
      mediaType: 'series', expiresAt: { $gt: agora, $lte: daquiA24Horas }, notificationSent: false
    });

    const todosExpirando = [...filmesExpirando, ...seriesExpirando];
    console.log(`🔔 Verificando notificações: ${filmesExpirando.length} filme(s) e ${seriesExpirando.length} série(s) expirando`);

    for (const content of todosExpirando) {
      try {
        const user = await User.findOne({ userId: content.userId });
        if (!user || !user.notificationsEnabled) {
          content.notificationSent = true;
          await content.save();
          continue;
        }

        const timeRemaining = formatTimeRemaining(content.expiresAt);
        const playerUrl     = `${DOMINIO_PUBLICO}/player/${content.token}`;
        const nomeCompleto  = content.episodeName
          ? `${content.title} - ${content.episodeName}`
          : content.title;
        const emoji = content.mediaType === 'movie' ? '🎬' : '📺';
        const tipo  = content.mediaType === 'movie' ? 'Filme' : 'Episódio';

        await bot.sendMessage(
          content.userId,
          `⏰ *${tipo} Expirando em Breve!*\n\n` +
          `${emoji} *${escaparMarkdown(nomeCompleto)}*\n\n` +
          `${timeRemaining}\n\n` +
          `⚠️ Assista agora antes que expire!`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '▶️ Assistir Agora', url: playerUrl }],
                [{ text: '📦 Meu Conteúdo', callback_data: 'my_content' }]
              ]
            }
          }
        );

        content.notificationSent = true;
        await content.save();
        console.log(`✅ Notificação enviada: User ${content.userId} | ${nomeCompleto}`);
      } catch (error) {
        // Ignora erros de bot bloqueado pelo usuário — não derruba o servidor
        if (error.response?.body?.error_code === 403) {
          console.log(`⚠️ Bot bloqueado pelo usuário ${content.userId} — pulando notificação`);
          content.notificationSent = true;
          await content.save();
        } else {
          console.error(`Erro ao enviar notificação para ${content.userId}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('Erro ao verificar conteúdos expirando:', error);
  }
}

// ============================
// COMANDOS DO BOT
// ============================

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  // Sanitiza o nome para evitar quebra de Markdown com fontes Unicode
  const nome = sanitizarTexto(msg.from.first_name || 'usuário');

  try {
    const resultado = await verificarOuCriarUsuario(msg);
    if (!resultado) {
      bot.sendMessage(chatId, '❌ Erro ao acessar o sistema. Tente novamente em alguns instantes.');
      return;
    }

    const { isNew, user } = resultado;
    const bloqueio = await verificarBloqueio(chatId);

    if (bloqueio.blocked) {
      bot.sendMessage(chatId,
        `🚫 *Acesso Bloqueado*\n\n${escaparMarkdown(bloqueio.reason)}\n\nEntre em contato com o suporte se achar que isso é um erro.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    clearUserState(chatId);
    userStates[chatId] = { step: 'menu' };

    const saldo        = user.credits;
    const totalFilmes  = vouverService.CACHE_CONTEUDO.movies.length;
    const totalSeries  = vouverService.CACHE_CONTEUDO.series.length;
    const totalConteudo = totalFilmes + totalSeries;

    // Sanitiza nome e username para evitar quebra de Markdown
    const nomeSeguro     = sanitizarTexto(user.firstName);
    const sobrenomeSeguro = user.lastName ? ' ' + sanitizarTexto(user.lastName) : '';
    const usernameSeguro = user.username ? `@${sanitizarTexto(user.username)}` : null;

    let welcome = '';

    if (isNew) {
      welcome =
        `🎉 *Bem-vindo ao FastTV, ${nomeSeguro}!*\n\n` +
        `✅ *Conta criada com sucesso!*\n\n` +
        `👤 *Seu Perfil:*\n` +
        `• ID: \`${chatId}\`\n` +
        `• Nome: ${nomeSeguro}${sobrenomeSeguro}\n` +
        (usernameSeguro ? `• Username: ${usernameSeguro}\n` : '') +
        `• Cadastro: ${new Date(user.registeredAt).toLocaleDateString('pt-BR')}\n\n` +
        `📊 *Nosso Catálogo*\n` +
        `🎥 ${totalFilmes.toLocaleString('pt-BR')} filmes\n` +
        `📺 ${totalSeries.toLocaleString('pt-BR')} séries\n` +
        `📦 ${totalConteudo.toLocaleString('pt-BR')} conteúdos disponíveis\n\n` +
        `💰 *Seu saldo inicial:* ${formatMoney(saldo)}\n\n` +
        `💡 *Como você pode assistir*\n\n` +
        `🎬 *Filmes*\n` +
        `A partir de R$ 5,00 (acesso por 24h)\n\n` +
        `📺 *Séries* — você escolhe como assistir:\n` +
        `• Comprar apenas 1 episódio\n` +
        `• Comprar uma temporada completa\n` +
        `• Ou adquirir a série completa\n\n` +
        `Valores a partir de R$ 1,75 por episódio (acesso por 7 dias)\n\n` +
        `Ou, se preferir, pague apenas R$ 2,50 por hora assistida\n\n` +
        `✨ *Aqui você escolhe como assistir e como pagar.*\n` +
        `Você paga somente pelo que realmente consumir.\n\n` +
        `🎯 *Comece agora adicionando créditos!*\n\n` +
        `👉 Selecione uma opção no menu abaixo.`;
    } else {
      welcome =
        `🎬 *Bem-vindo de volta, ${nomeSeguro}!*\n\n` +
        `📊 *Nosso Catálogo*\n` +
        `🎥 ${totalFilmes.toLocaleString('pt-BR')} filmes\n` +
        `📺 ${totalSeries.toLocaleString('pt-BR')} séries\n` +
        `📦 ${totalConteudo.toLocaleString('pt-BR')} conteúdos disponíveis\n\n` +
        `💰 *Seu saldo:* ${formatMoney(saldo)}\n` +
        `🛒 *Compras realizadas:* ${user.totalPurchases}\n` +
        `💸 *Total investido:* ${formatMoney(user.totalSpent)}\n\n` +
        `💡 *Como você pode assistir*\n\n` +
        `🎬 *Filmes*\n` +
        `A partir de R$ 5,00 (acesso por 24h)\n\n` +
        `📺 *Séries* — você escolhe como assistir:\n` +
        `• Comprar apenas 1 episódio\n` +
        `• Comprar uma temporada completa\n` +
        `• Ou adquirir a série completa\n\n` +
        `Valores a partir de R$ 1,75 por episódio (acesso por 7 dias)\n\n` +
        `Ou, se preferir, pague apenas R$ 2,50 por hora assistida\n\n` +
        `✨ *Aqui você escolhe como assistir e como pagar.*\n` +
        `Você paga somente pelo que realmente consumir.\n\n` +
        `👉 Selecione uma opção no menu abaixo.`;
    }

    showMainMenu(chatId, welcome);
  } catch (error) {
    console.error('Erro no comando /start:', error);
    bot.sendMessage(chatId, '❌ Erro ao iniciar. Tente novamente com /start');
  }
});

bot.onText(/\/saldo/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const saldo = await getUserCredits(chatId);
    bot.sendMessage(chatId,
      `💰 *Seu Saldo*\n\nSaldo disponível: ${formatMoney(saldo)}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }],
            [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Erro ao consultar saldo:', error);
    bot.sendMessage(chatId, '❌ Erro ao consultar saldo. Tente novamente.');
  }
});

bot.onText(/\/ajuda|\/help/, (msg) => {
  const chatId     = msg.chat.id;
  const totalFilmes = vouverService.CACHE_CONTEUDO.movies.length;
  const totalSeries = vouverService.CACHE_CONTEUDO.series.length;

  const helpText =
    `📖 *Ajuda - FastTV*\n\n` +
    `*Nosso Catálogo:*\n` +
    `🎥 ${totalFilmes.toLocaleString('pt-BR')} filmes\n` +
    `📺 ${totalSeries.toLocaleString('pt-BR')} séries\n\n` +
    `*Como funciona:*\n` +
    `1️⃣ Adicione créditos usando PIX\n` +
    `2️⃣ Busque filmes ou séries\n` +
    `3️⃣ Assista pagando pela duração\n` +
    `4️⃣ Links salvos em "Meu Conteúdo"\n\n` +
    `*Preços:*\n` +
    `🎬 Filmes: A partir de R$ 5,00\n` +
    `📺 Episódios: A partir de R$ 1,75\n` +
    `⏱️ Cobrança: R$ 2,50 por hora\n` +
    `✅ Sem mensalidade!\n\n` +
    `*Validade dos Links:*\n` +
    `🎬 Filmes: *24 horas*\n` +
    `📺 Séries: *7 dias*\n\n` +
    `*Exemplos práticos:*\n` +
    `• Filme 2h = R$ 5,00 (24h)\n` +
    `• Episódio 42min = R$ 1,75 (7 dias)\n` +
    `• Temporada 10 eps = R$ 17,50 (7 dias)\n\n` +
    `*Comandos:*\n` +
    `/start - Menu principal\n` +
    `/saldo - Ver saldo\n` +
    `/ajuda - Esta mensagem\n` +
    `/notificacoes - Gerenciar notificações\n\n` +
    `*Dúvidas?* Entre em contato com nosso suporte!`;

  bot.sendMessage(chatId, helpText, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '🏠 Menu Principal', callback_data: 'back_main' }]] }
  });
});

bot.onText(/\/notificacoes|\/notifications/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const user = await User.findOne({ userId: chatId });
    if (!user) { bot.sendMessage(chatId, '❌ Usuário não encontrado. Use /start primeiro.'); return; }

    bot.sendMessage(chatId,
      `🔔 *Notificações de Expiração*\n\n` +
      `Status atual: ${user.notificationsEnabled ? '✅ Ativadas' : '❌ Desativadas'}\n\n` +
      `Você receberá notificações:\n` +
      `🎬 Filmes: 2 horas antes de expirar\n` +
      `📺 Séries: 24 horas antes de expirar\n\n` +
      `Deseja ${user.notificationsEnabled ? 'desativar' : 'ativar'}?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: user.notificationsEnabled ? '❌ Desativar Notificações' : '✅ Ativar Notificações', callback_data: 'toggle_notifications' }],
            [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]
          ]
        }
      }
    );
  } catch (error) {
    console.error('Erro ao gerenciar notificações:', error);
    bot.sendMessage(chatId, '❌ Erro ao gerenciar notificações.');
  }
});

// ============================
// COMANDOS ADMINISTRATIVOS
// ============================

bot.onText(/\/admin_users/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '⛔ Você não tem permissão para usar este comando.'); return; }
  try {
    const totalUsers   = await User.countDocuments();
    const activeUsers  = await User.countDocuments({ isActive: true, isBlocked: false });
    const blockedUsers = await User.countDocuments({ isBlocked: true });
    const recentUsers  = await User.find().sort({ registeredAt: -1 }).limit(10).select('userId firstName username registeredAt credits totalSpent');

    let message =
      `👥 *Estatísticas de Usuários*\n\n` +
      `📊 Total: ${totalUsers}\n` +
      `✅ Ativos: ${activeUsers}\n` +
      `🚫 Bloqueados: ${blockedUsers}\n\n` +
      `📋 *Últimos 10 Usuários:*\n\n`;

    recentUsers.forEach((user, index) => {
      const nomeSeguro = sanitizarTexto(user.firstName);
      const userSeguro = user.username ? ` (@${sanitizarTexto(user.username)})` : '';
      message +=
        `${index + 1}. ${nomeSeguro}${userSeguro}\n` +
        `   ID: \`${user.userId}\`\n` +
        `   Saldo: ${formatMoney(user.credits)}\n` +
        `   Gasto: ${formatMoney(user.totalSpent)}\n` +
        `   Cadastro: ${new Date(user.registeredAt).toLocaleDateString('pt-BR')}\n\n`;
    });

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    bot.sendMessage(chatId, '❌ Erro ao buscar usuários.');
  }
});

bot.onText(/\/admin_user (.+)/, async (msg, match) => {
  const chatId   = msg.chat.id;
  const searchId = parseInt(match[1]);
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '⛔ Você não tem permissão para usar este comando.'); return; }
  try {
    const user = await User.findOne({ userId: searchId });
    if (!user) { bot.sendMessage(chatId, `❌ Usuário ID \`${searchId}\` não encontrado.`, { parse_mode: 'Markdown' }); return; }

    const conteudosAtivos = await PurchasedContent.countDocuments({ userId: searchId, expiresAt: { $gt: new Date() } });
    const nomeSeguro = sanitizarTexto(user.firstName);
    const sobrenomeSeguro = user.lastName ? ' ' + sanitizarTexto(user.lastName) : '';

    const message =
      `👤 *Detalhes do Usuário*\n\n` +
      `🆔 ID: \`${user.userId}\`\n` +
      `👤 Nome: ${nomeSeguro}${sobrenomeSeguro}\n` +
      (user.username ? `📱 Username: @${sanitizarTexto(user.username)}\n` : '') +
      `💰 Saldo: ${formatMoney(user.credits)}\n` +
      `💸 Total Gasto: ${formatMoney(user.totalSpent)}\n` +
      `🛒 Compras: ${user.totalPurchases}\n` +
      `📦 Conteúdos Ativos: ${conteudosAtivos}\n` +
      `📅 Cadastro: ${new Date(user.registeredAt).toLocaleDateString('pt-BR')}\n` +
      `🔔 Notificações: ${user.notificationsEnabled ? '✅ Ativadas' : '❌ Desativadas'}\n` +
      `⚡ Status: ${user.isBlocked ? '🚫 Bloqueado' : '✅ Ativo'}\n` +
      (user.isBlocked && user.blockedReason ? `\n⚠️ Motivo: ${escaparMarkdown(user.blockedReason)}` : '');

    bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '💰 Adicionar Créditos', callback_data: `admin_add_credits_${user.userId}` },
            { text: '💸 Remover Créditos',  callback_data: `admin_remove_credits_${user.userId}` }
          ],
          [{ text: user.isBlocked ? '✅ Desbloquear' : '🚫 Bloquear', callback_data: `admin_toggle_block_${user.userId}` }]
        ]
      }
    });
  } catch (error) {
    console.error('Erro ao buscar usuário:', error);
    bot.sendMessage(chatId, '❌ Erro ao buscar usuário.');
  }
});

bot.onText(/\/admin_block (\d+) (.+)/, async (msg, match) => {
  const chatId       = msg.chat.id;
  const targetUserId = parseInt(match[1]);
  const reason       = match[2];
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '⛔ Você não tem permissão para usar este comando.'); return; }
  try {
    const user = await User.findOne({ userId: targetUserId });
    if (!user) { bot.sendMessage(chatId, `❌ Usuário ID \`${targetUserId}\` não encontrado.`, { parse_mode: 'Markdown' }); return; }
    user.isBlocked     = true;
    user.blockedReason = reason;
    await user.save();
    bot.sendMessage(chatId, `✅ Usuário \`${targetUserId}\` bloqueado com sucesso.`, { parse_mode: 'Markdown' });
    bot.sendMessage(targetUserId,
      `🚫 *Sua conta foi bloqueada*\n\nMotivo: ${escaparMarkdown(reason)}\n\nEntre em contato com o suporte se achar que isso é um erro.`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  } catch (error) {
    console.error('Erro ao bloquear usuário:', error);
    bot.sendMessage(chatId, '❌ Erro ao bloquear usuário.');
  }
});

bot.onText(/\/admin_unblock (\d+)/, async (msg, match) => {
  const chatId       = msg.chat.id;
  const targetUserId = parseInt(match[1]);
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '⛔ Você não tem permissão para usar este comando.'); return; }
  try {
    const user = await User.findOne({ userId: targetUserId });
    if (!user) { bot.sendMessage(chatId, `❌ Usuário ID \`${targetUserId}\` não encontrado.`, { parse_mode: 'Markdown' }); return; }
    user.isBlocked     = false;
    user.blockedReason = null;
    await user.save();
    bot.sendMessage(chatId, `✅ Usuário \`${targetUserId}\` desbloqueado com sucesso.`, { parse_mode: 'Markdown' });
    bot.sendMessage(targetUserId,
      `✅ *Sua conta foi desbloqueada*\n\nVocê já pode usar o FastTV normalmente!\n\nUse /start para começar.`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  } catch (error) {
    console.error('Erro ao desbloquear usuário:', error);
    bot.sendMessage(chatId, '❌ Erro ao desbloquear usuário.');
  }
});

bot.onText(/\/admin_add_credits (\d+) (\d+)/, async (msg, match) => {
  const chatId       = msg.chat.id;
  const targetUserId = parseInt(match[1]);
  const centavos     = parseInt(match[2]);
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '⛔ Você não tem permissão para usar este comando.'); return; }
  try {
    const success = await addCredits(targetUserId, centavos);
    if (success) {
      const saldo = await getUserCredits(targetUserId);
      bot.sendMessage(chatId,
        `✅ Adicionados ${formatMoney(centavos)} ao usuário \`${targetUserId}\`\nNovo saldo: ${formatMoney(saldo)}`,
        { parse_mode: 'Markdown' }
      );
      bot.sendMessage(targetUserId,
        `🎁 *Créditos Adicionados!*\n\nVocê recebeu ${formatMoney(centavos)} de créditos!\n💳 Novo saldo: ${formatMoney(saldo)}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } else {
      bot.sendMessage(chatId, '❌ Erro ao adicionar créditos.');
    }
  } catch (error) {
    console.error('Erro ao adicionar créditos:', error);
    bot.sendMessage(chatId, '❌ Erro ao adicionar créditos.');
  }
});

bot.onText(/\/admin_stats/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '⛔ Você não tem permissão para usar este comando.'); return; }
  try {
    const totalUsers   = await User.countDocuments();
    const activeUsers  = await User.countDocuments({ isActive: true, isBlocked: false });
    const blockedUsers = await User.countDocuments({ isBlocked: true });
    const totalCompras = await User.aggregate([{ $group: { _id: null, total: { $sum: '$totalPurchases' } } }]);
    const totalReceita = await User.aggregate([{ $group: { _id: null, total: { $sum: '$totalSpent' } } }]);
    const conteudosAtivos   = await PurchasedContent.countDocuments({ expiresAt: { $gt: new Date() } });
    const conteudosExpirados = await PurchasedContent.countDocuments({ expiresAt: { $lte: new Date() } });

    const message =
      `📊 *Estatísticas do Sistema*\n\n` +
      `👥 *Usuários*\n• Total: ${totalUsers}\n• Ativos: ${activeUsers}\n• Bloqueados: ${blockedUsers}\n\n` +
      `💰 *Financeiro*\n• Total de compras: ${totalCompras[0]?.total || 0}\n• Receita total: ${formatMoney(totalReceita[0]?.total || 0)}\n\n` +
      `📦 *Conteúdos*\n• Ativos: ${conteudosAtivos}\n• Expirados: ${conteudosExpirados}\n\n` +
      `🎬 *Catálogo*\n• Filmes: ${vouverService.CACHE_CONTEUDO.movies.length}\n• Séries: ${vouverService.CACHE_CONTEUDO.series.length}`;

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    bot.sendMessage(chatId, '❌ Erro ao buscar estatísticas.');
  }
});

bot.onText(/\/admin_broadcast (.+)/, async (msg, match) => {
  const chatId  = msg.chat.id;
  const message = match[1];
  if (!isAdmin(chatId)) { bot.sendMessage(chatId, '⛔ Você não tem permissão para usar este comando.'); return; }
  try {
    const users = await User.find({ isActive: true, isBlocked: false }).select('userId');
    bot.sendMessage(chatId, `📢 Enviando mensagem para ${users.length} usuários...`);
    let enviados = 0, falhas = 0;
    for (const user of users) {
      try {
        await bot.sendMessage(user.userId, `📢 *Mensagem da Administração*\n\n${escaparMarkdown(message)}`, { parse_mode: 'Markdown' });
        enviados++;
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) { falhas++; }
    }
    bot.sendMessage(chatId, `✅ Broadcast concluído!\n\n✅ Enviados: ${enviados}\n❌ Falhas: ${falhas}`);
  } catch (error) {
    console.error('Erro ao enviar broadcast:', error);
    bot.sendMessage(chatId, '❌ Erro ao enviar broadcast.');
  }
});

// ============================
// MENU HANDLERS
// ============================

bot.onText(/🔍 Buscar Filmes/, (msg) => {
  const chatId = msg.chat.id;
  userStates[chatId] = { step: 'search_movies' };
  bot.sendMessage(chatId, '🎬 *Buscar Filmes*\n\nDigite o nome do filme que deseja assistir:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '⬅️ Voltar ao Menu', callback_data: 'back_main' }]] }
  });
});

bot.onText(/📺 Buscar Séries/, (msg) => {
  const chatId = msg.chat.id;
  userStates[chatId] = { step: 'search_series' };
  bot.sendMessage(chatId, '📺 *Buscar Séries*\n\nDigite o nome da série que deseja assistir:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '⬅️ Voltar ao Menu', callback_data: 'back_main' }]] }
  });
});

bot.onText(/🎬 Filmes A-Z/, (msg) => { mostrarAlfabeto(msg.chat.id, 'movies'); });
bot.onText(/📺 Séries A-Z/,  (msg) => { mostrarAlfabeto(msg.chat.id, 'series'); });

bot.onText(/📦 Meu Conteúdo/, async (msg) => { await mostrarMeuConteudo(msg.chat.id); });

bot.onText(/🔞 Conteúdo \+18/, (msg) => {
  const chatId = msg.chat.id;
  userStates[chatId] = { step: 'search_adult' };
  bot.sendMessage(chatId,
    '🔞 *Conteúdo Adulto*\n\n⚠️ *Atenção:* Apenas para maiores de 18 anos.\n\nDigite o termo de busca:',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Voltar ao Menu', callback_data: 'back_main' }]] } }
  );
});

bot.onText(/💳 Meu Saldo/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const saldo = await getUserCredits(chatId);
    bot.sendMessage(chatId, `💰 *Seu Saldo*\n\nSaldo disponível: ${formatMoney(saldo)}`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }],
          [{ text: '🏠 Voltar ao Menu',     callback_data: 'back_main' }]
        ]
      }
    });
  } catch (error) {
    console.error('Erro ao consultar saldo:', error);
    bot.sendMessage(chatId, '❌ Erro ao consultar saldo. Tente novamente.');
  }
});

bot.onText(/💰 Adicionar Créditos/, (msg) => { mostrarOpcoesCredito(msg.chat.id); });

function mostrarOpcoesCredito(chatId) {
  const valores = [
    { label: 'R$ 5,00',   value: 500   },
    { label: 'R$ 10,00',  value: 1000  },
    { label: 'R$ 25,00',  value: 2500  },
    { label: 'R$ 50,00',  value: 5000  },
    { label: 'R$ 100,00', value: 10000 }
  ];
  const keyboard = valores.map(v => [
    { text: `${v.label} - ${Math.floor((v.value / PRECO_POR_HORA) * 10) / 10}h de conteúdo`, callback_data: `add_${v.value}` }
  ]);
  keyboard.push([{ text: '⬅️ Voltar ao Menu', callback_data: 'back_main' }]);
  bot.sendMessage(chatId,
    `💰 *Adicionar Créditos*\n\nEscolha o valor que deseja adicionar:\n\n💡 *Dica:* R$ 2,50 = 1 hora de conteúdo\n🎬 Filmes a partir de R$ 5,00 (24h)\n📺 Episódios a partir de R$ 1,75 (7 dias)`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  );
}

// ============================
// PROCESSAMENTO DE MENSAGENS
// ============================

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text   = msg.text;
  if (!text || text.startsWith('/') || /🔍|📺|🔞|💰|💳|🎬|📦/.test(text)) return;

  const state = userStates[chatId];
  if (!state || !['search_movies', 'search_series', 'search_adult'].includes(state.step)) return;

  try {
    const loadingMsg = await bot.sendMessage(chatId, '🔍 Buscando...');
    if (vouverService.CACHE_CONTEUDO.series.length === 0) await vouverService.atualizarCache();

    const termo   = text.toLowerCase().trim();
    const isAdulto = (nome) => /[\[\(]xxx|\+18|adulto|hentai|playboy|brasileirinhas/i.test(nome);
    let resultados = [];

    if (state.step === 'search_adult') {
      const todosItens = [...vouverService.CACHE_CONTEUDO.movies, ...vouverService.CACHE_CONTEUDO.series];
      resultados = todosItens.filter(i => isAdulto(i.name) && i.name.toLowerCase().includes(termo)).slice(0, 15);
    } else {
      const lista = vouverService.CACHE_CONTEUDO[state.step === 'search_movies' ? 'movies' : 'series'];
      resultados  = lista.filter(i => !isAdulto(i.name) && i.name.toLowerCase().includes(termo)).slice(0, 15);
    }

    bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

    if (resultados.length === 0) {
      bot.sendMessage(chatId,
        `❌ *Nenhum resultado encontrado*\n\nTente buscar com outro termo.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Buscar novamente', callback_data: `retry_${state.step}` }],
              [{ text: '🏠 Menu Principal',   callback_data: 'back_main' }]
            ]
          }
        }
      );
      return;
    }

    const buttons = resultados.map(item => {
      const tipo = vouverService.CACHE_CONTEUDO.movies.find(m => m.id === item.id) ? 'movies' : 'series';
      return [{ text: `${item.name.substring(0, 60)}${item.name.length > 60 ? '...' : ''}`, callback_data: `details_${item.id}_${tipo}` }];
    });
    buttons.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

    bot.sendMessage(chatId,
      `📋 *${resultados.length} resultado${resultados.length > 1 ? 's' : ''} encontrado${resultados.length > 1 ? 's' : ''}:*\n\nSelecione para ver detalhes:`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
    );
  } catch (error) {
    console.error('Erro ao processar busca:', error);
    bot.sendMessage(chatId, '❌ Erro ao realizar busca. Tente novamente.',
      { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu Principal', callback_data: 'back_main' }]] } }
    );
  }
});

// ============================
// CALLBACK QUERIES (BOTÕES)
// ============================

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data   = query.data;
  const msgId  = query.message.message_id;

  try {
    if (data === 'noop') { bot.answerCallbackQuery(query.id); return; }

    if (data === 'back_main') {
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      clearUserState(chatId);
      showMainMenu(chatId);
      return;
    }

    if (data.startsWith('retry_')) {
      const step = data.replace('retry_', '');
      userStates[chatId] = { step };
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      let mensagem = 'Digite novamente:';
      if (step === 'search_movies') mensagem = '🎬 Digite o nome do filme:';
      if (step === 'search_series') mensagem = '📺 Digite o nome da série:';
      if (step === 'search_adult')  mensagem = '🔞 Digite o termo de busca:';
      bot.sendMessage(chatId, mensagem);
      return;
    }

    if (data.startsWith('alphabet_')) {
      const tipo = data.split('_')[1];
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      mostrarAlfabeto(chatId, tipo);
      return;
    }

    if (data.startsWith('letter_')) {
      const parts  = data.split('_');
      const tipo   = parts[1];
      const letra  = parts[2];
      const pagina = parseInt(parts[3]) || 1;
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      await listarPorLetra(chatId, tipo, letra, pagina);
      return;
    }

    if (data === 'my_content') {
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      await mostrarMeuConteudo(chatId);
      return;
    }

    if (data.startsWith('mycontent_')) {
      const contentId = data.split('_')[1];
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      await mostrarDetalhesConteudo(chatId, contentId);
      return;
    }

    if (data === 'toggle_notifications') {
      bot.answerCallbackQuery(query.id);
      try {
        const user = await User.findOne({ userId: chatId });
        if (!user) { bot.sendMessage(chatId, '❌ Usuário não encontrado.'); return; }
        user.notificationsEnabled = !user.notificationsEnabled;
        await user.save();
        bot.deleteMessage(chatId, msgId).catch(() => {});
        bot.sendMessage(chatId,
          `${user.notificationsEnabled ? '✅' : '❌'} *Notificações ${user.notificationsEnabled ? 'Ativadas' : 'Desativadas'}*\n\n` +
          (user.notificationsEnabled
            ? 'Você receberá avisos antes dos conteúdos expirarem:\n🎬 Filmes: 2h antes\n📺 Séries: 24h antes'
            : 'Você não receberá mais avisos de expiração.'),
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 Menu Principal', callback_data: 'back_main' }]] } }
        );
      } catch (error) {
        console.error('Erro ao alternar notificações:', error);
        bot.sendMessage(chatId, '❌ Erro ao alterar configuração.');
      }
      return;
    }

    if (data === 'menu_add_credits') {
      bot.answerCallbackQuery(query.id);
      bot.deleteMessage(chatId, msgId).catch(() => {});
      mostrarOpcoesCredito(chatId);
      return;
    }

    if (data.startsWith('add_')) {
      const valor = parseInt(data.split('_')[1]);
      if (isNaN(valor) || valor <= 0) { bot.answerCallbackQuery(query.id, { text: 'Valor inválido' }); return; }
      bot.answerCallbackQuery(query.id, { text: 'Gerando PIX...' });
      const pix = await criarPagamentoPix(chatId, valor);
      if (!pix) {
        bot.sendMessage(chatId,
          '❌ *Erro ao gerar PIX*\n\nNão foi possível gerar o pagamento. Tente novamente.',
          {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔄 Tentar novamente', callback_data: data }], [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]] }
          }
        );
        return;
      }
      bot.deleteMessage(chatId, msgId).catch(() => {});
      await bot.sendMessage(chatId,
        `💳 *PIX Gerado - ${formatMoney(valor)}*\n\n` +
        `📱 *Instruções:*\n1. Copie o código abaixo\n2. Abra seu app do banco\n3. Escolha "Pix Copia e Cola"\n4. Cole o código e confirme\n\n` +
        `*Código Pix:*\n<code>${pix.pix_code}</code>\n\n⏰ Pagamento válido por 10 minutos`,
        { parse_mode: 'HTML' }
      );
      if (pix.pix_qr_base64) {
        await bot.sendPhoto(chatId, Buffer.from(pix.pix_qr_base64, 'base64'), { caption: '📱 Ou escaneie este QR Code com seu app de banco' });
      }
      await bot.sendMessage(chatId,
        '⏳ *Aguardando confirmação do pagamento...*\n\nAssim que o pagamento for confirmado, seus créditos serão adicionados automaticamente! 🎉',
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '💳 Ver Saldo', callback_data: 'check_balance' }], [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]] }
        }
      );
      return;
    }

    if (data === 'check_balance') {
      const saldo = await getUserCredits(chatId);
      bot.answerCallbackQuery(query.id, { text: `Saldo atual: ${formatMoney(saldo)}`, show_alert: true });
      return;
    }

    if (data.startsWith('details_')) {
      const [, id, type] = data.split('_');
      bot.answerCallbackQuery(query.id, { text: 'Carregando detalhes...' });
      bot.deleteMessage(chatId, msgId).catch(() => {});

      const detalhes = await vouverService.buscarDetalhes(id, type);
      if (!detalhes) {
        bot.sendMessage(chatId, '❌ Erro ao carregar detalhes do conteúdo.',
          { reply_markup: { inline_keyboard: [[{ text: '🏠 Menu Principal', callback_data: 'back_main' }]] } }
        );
        return;
      }

      userStates[chatId] = { step: 'details', data: detalhes, id, type };
      const saldoAtual = await getUserCredits(chatId);
      const tituloSeguro = escaparMarkdown(detalhes.title);

      let mensagem = `🎬 *${tituloSeguro}*\n\n`;
      if (detalhes.info.genero) mensagem += `🎭 ${escaparMarkdown(detalhes.info.genero)}\n`;
      if (detalhes.info.ano)    mensagem += `📅 ${detalhes.info.ano}\n`;
      if (detalhes.info.imdb)   mensagem += `⭐ IMDB: ${detalhes.info.imdb}\n`;
      if (detalhes.info.genero || detalhes.info.ano || detalhes.info.imdb) mensagem += '\n';

      if (detalhes.info.sinopse) {
        const sinopse = escaparMarkdown(detalhes.info.sinopse.substring(0, 400));
        mensagem += `${sinopse}${detalhes.info.sinopse.length > 400 ? '...' : ''}\n\n`;
      }

      const keyboard = [];

      if (detalhes.mediaType === 'movie') {
        let minutos = 109;
        if (detalhes.info.duracaoMinutos && detalhes.info.duracaoMinutos > 0) {
          minutos = detalhes.info.duracaoMinutos;
          console.log(`✅ [BOT] Usando duração do HTML: ${minutos}min`);
        } else {
          minutos = await vouverService.estimarDuracao('movie', id, null);
          console.log(`⚠️ [BOT] Usando duração estimada: ${minutos}min`);
        }

        const preco = calcularPreco(minutos);
        const horas = Math.floor(minutos / 60);
        const mins  = minutos % 60;
        const duracaoTexto = horas > 0 ? `${horas}h ${mins}min` : `${mins}min`;

        if (detalhes.info.duracaoTexto) mensagem += `⏱️ Duração: ${detalhes.info.duracaoTexto} (${minutos}min)\n`;
        else mensagem += `⏱️ Duração: ~${duracaoTexto}\n`;

        mensagem += `💰 Preço: ${formatMoney(preco)}\n⏰ Válido por: 24 horas\n💳 Seu saldo: ${formatMoney(saldoAtual)}`;

        if (saldoAtual < preco) {
          mensagem += `\n\n⚠️ *Saldo insuficiente!* Faltam ${formatMoney(preco - saldoAtual)}`;
          keyboard.push([{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }]);
        } else {
          keyboard.push([{ text: `▶️ Assistir - ${formatMoney(preco)}`, callback_data: `watch_movie_${id}_${preco}_${minutos}` }]);
        }
      } else {
        mensagem += `📺 *Temporadas disponíveis:*\n\n⏰ Válido por: 7 dias\n💳 Seu saldo: ${formatMoney(saldoAtual)}\n\n`;
        Object.keys(detalhes.seasons).forEach(season => {
          const numEps = detalhes.seasons[season].length;
          keyboard.push([{ text: `Temporada ${season} (${numEps} episódio${numEps > 1 ? 's' : ''})`, callback_data: `season_${id}_${season}` }]);
        });
      }

      keyboard.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);
      bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
      return;
    }

    if (data.startsWith('season_')) {
      const [, id, season] = data.split('_');
      const state = userStates[chatId];
      if (!state || !state.data || !state.data.seasons || !state.data.seasons[season]) {
        bot.answerCallbackQuery(query.id, { text: 'Erro ao carregar temporada' }); return;
      }
      bot.answerCallbackQuery(query.id);

      const episodios = state.data.seasons[season];
      let precoTotal  = 0;
      for (const ep of episodios) {
        const min = await vouverService.estimarDuracao('series', ep.id);
        precoTotal += calcularPreco(min);
      }

      const saldoAtual = await getUserCredits(chatId);
      const keyboard   = [];

      for (let i = 0; i < episodios.length; i++) {
        const ep = episodios[i];
        keyboard.push([{ text: `${i + 1}. ${ep.name.substring(0, 50)}${ep.name.length > 50 ? '...' : ''}`, callback_data: `episode_${ep.id}_${season}` }]);
      }

      if (saldoAtual >= precoTotal) {
        keyboard.push([{ text: `📥 Comprar Temporada Completa - ${formatMoney(precoTotal)}`, callback_data: `buy_season_${id}_${season}_${precoTotal}` }]);
      } else {
        keyboard.push([{ text: `⚠️ Saldo Insuficiente - Faltam ${formatMoney(precoTotal - saldoAtual)}`, callback_data: 'menu_add_credits' }]);
      }

      keyboard.push([{ text: '⬅️ Voltar aos Detalhes', callback_data: `details_${id}_${state.type}` }]);
      keyboard.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

      bot.deleteMessage(chatId, msgId).catch(() => {});
      bot.sendMessage(chatId,
        `📺 *${escaparMarkdown(state.data.title)}*\n*Temporada ${season}*\n\n` +
        `Total: ${episodios.length} episódio${episodios.length > 1 ? 's' : ''}\n` +
        `Preço da temporada: ${formatMoney(precoTotal)}\n` +
        `⏰ Válido por: 7 dias\n💳 Seu saldo: ${formatMoney(saldoAtual)}\n\nSelecione um episódio:`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
      );
      return;
    }

    if (data.startsWith('episode_')) {
      const [, epId, season] = data.split('_');
      const state = userStates[chatId];
      if (!state || !state.data || !state.data.seasons || !state.data.seasons[season]) {
        bot.answerCallbackQuery(query.id, { text: 'Erro ao carregar episódio' }); return;
      }

      const episodio = state.data.seasons[season].find(e => e.id === epId);
      if (!episodio) { bot.answerCallbackQuery(query.id, { text: 'Episódio não encontrado' }); return; }

      bot.answerCallbackQuery(query.id);
      const minutos    = await vouverService.estimarDuracao('series', epId);
      const preco      = calcularPreco(minutos);
      const saldoAtual = await getUserCredits(chatId);
      const horas      = Math.floor(minutos / 60);
      const mins       = minutos % 60;
      const duracaoTexto = horas > 0 ? `${horas}h ${mins}min` : `${mins}min`;

      bot.deleteMessage(chatId, msgId).catch(() => {});

      let mensagem =
        `📺 *${escaparMarkdown(state.data.title)}*\n` +
        `*Temporada ${season} - ${escaparMarkdown(episodio.name)}*\n\n` +
        `⏱️ Duração: ~${duracaoTexto}\n💰 Preço: ${formatMoney(preco)}\n⏰ Válido por: 7 dias\n💳 Seu saldo: ${formatMoney(saldoAtual)}`;

      const keyboard = [];
      if (saldoAtual < preco) {
        mensagem += `\n\n⚠️ *Saldo insuficiente!* Faltam ${formatMoney(preco - saldoAtual)}`;
        keyboard.push([{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }]);
      } else {
        keyboard.push([{ text: `▶️ Assistir - ${formatMoney(preco)}`, callback_data: `watch_ep_${epId}_${preco}_${season}` }]);
      }
      keyboard.push([{ text: '⬅️ Voltar à Temporada', callback_data: `season_${state.id}_${season}` }]);
      keyboard.push([{ text: '🏠 Menu Principal', callback_data: 'back_main' }]);

      bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
      return;
    }

    if (data.startsWith('watch_movie_')) {
      const parts     = data.split('_');
      const id        = parts[2];
      const preco     = parts[3];
      const precoNum  = parseInt(preco);
      const minutosReais = parts[4] ? parseInt(parts[4]) : 109;
      const state     = userStates[chatId];

      bot.answerCallbackQuery(query.id);
      console.log(`🎬 [BOT] Comprando filme: ID=${id} | Minutos=${minutosReais} | Preço=${formatMoney(precoNum)}`);

      const saldoAtual = await getUserCredits(chatId);
      if (saldoAtual < precoNum) {
        bot.sendMessage(chatId,
          `❌ *Saldo Insuficiente*\n\nVocê possui: ${formatMoney(saldoAtual)}\nNecessário: ${formatMoney(precoNum)}\nFaltam: ${formatMoney(precoNum - saldoAtual)}`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }], [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]] } }
        );
        return;
      }

      const deducaoSucesso = await deductCredits(chatId, precoNum);
      if (!deducaoSucesso) { bot.sendMessage(chatId, '❌ Erro ao processar pagamento. Tente novamente.'); return; }

      const token = await salvarConteudoComprado(chatId, id, 'movie', state.data.title, precoNum);
      if (!token) { await addCredits(chatId, precoNum); bot.sendMessage(chatId, '❌ Erro ao gerar link. Créditos devolvidos.'); return; }

      const novoSaldo = await getUserCredits(chatId);
      await bot.sendMessage(chatId,
        `✅ *Pagamento Confirmado!*\n\n🎬 Duração: ${minutosReais}min\n💰 -${formatMoney(precoNum)}\n💳 Novo saldo: ${formatMoney(novoSaldo)}\n\n⏰ Link válido por *24 horas*`,
        { parse_mode: 'Markdown' }
      );
      await enviarVideoComLink(chatId, token, `🎬 ${state.data.title} (${minutosReais}min)`, precoNum, state.data.title, 'movie');
      return;
    }

    if (data.startsWith('watch_ep_')) {
      const [, , epId, preco, season] = data.split('_');
      const precoNum = parseInt(preco);
      const state    = userStates[chatId];

      bot.answerCallbackQuery(query.id);
      const saldoAtual = await getUserCredits(chatId);

      if (saldoAtual < precoNum) {
        bot.sendMessage(chatId,
          `❌ *Saldo Insuficiente*\n\nVocê possui: ${formatMoney(saldoAtual)}\nNecessário: ${formatMoney(precoNum)}\nFaltam: ${formatMoney(precoNum - saldoAtual)}`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }], [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]] } }
        );
        return;
      }

      const deducaoSucesso = await deductCredits(chatId, precoNum);
      if (!deducaoSucesso) { bot.sendMessage(chatId, '❌ Erro ao processar pagamento. Tente novamente.'); return; }

      let nomeEpisodio = 'Episódio';
      if (state.data && state.data.seasons) {
        for (const s of Object.values(state.data.seasons)) {
          const ep = s.find(e => e.id === epId);
          if (ep) { nomeEpisodio = ep.name; break; }
        }
      }

      const token = await salvarConteudoComprado(chatId, epId, 'series', state.data.title, precoNum, nomeEpisodio, season);
      if (!token) { await addCredits(chatId, precoNum); bot.sendMessage(chatId, '❌ Erro ao gerar link. Créditos devolvidos.'); return; }

      const novoSaldo = await getUserCredits(chatId);
      await bot.sendMessage(chatId,
        `✅ *Pagamento Confirmado!*\n\n📺 Episódio: ${escaparMarkdown(nomeEpisodio)}\n💰 -${formatMoney(precoNum)}\n💳 Novo saldo: ${formatMoney(novoSaldo)}\n\n⏰ Link válido por *7 dias*`,
        { parse_mode: 'Markdown' }
      );
      await enviarVideoComLink(chatId, token, `📺 ${nomeEpisodio}`, precoNum, nomeEpisodio, 'series');
      return;
    }

    if (data.startsWith('buy_season_')) {
      const [, , id, season, preco] = data.split('_');
      const precoNum = parseInt(preco);
      const state    = userStates[chatId];

      bot.answerCallbackQuery(query.id);
      const saldoAtual = await getUserCredits(chatId);

      if (saldoAtual < precoNum) {
        bot.sendMessage(chatId,
          `❌ *Saldo Insuficiente*\n\nVocê possui: ${formatMoney(saldoAtual)}\nNecessário: ${formatMoney(precoNum)}\nFaltam: ${formatMoney(precoNum - saldoAtual)}`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💰 Adicionar Créditos', callback_data: 'menu_add_credits' }], [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]] } }
        );
        return;
      }

      const episodios = state.data.seasons[season];
      if (!episodios || episodios.length === 0) { bot.sendMessage(chatId, '❌ Erro ao carregar episódios da temporada.'); return; }

      const deducaoSucesso = await deductCredits(chatId, precoNum);
      if (!deducaoSucesso) { bot.sendMessage(chatId, '❌ Erro ao processar pagamento. Tente novamente.'); return; }

      const novoSaldo = await getUserCredits(chatId);
      await bot.sendMessage(chatId,
        `✅ *Temporada ${season} Liberada!*\n\n-${formatMoney(precoNum)}\n💳 Novo saldo: ${formatMoney(novoSaldo)}\n\n📤 Salvando ${episodios.length} episódios em "Meu Conteúdo"...\n\n⏰ *Links válidos por 7 dias*\n⏳ Aguarde alguns instantes...`,
        { parse_mode: 'Markdown' }
      );

      let salvos = 0;
      for (const ep of episodios) {
        try {
          const token = await salvarConteudoComprado(chatId, ep.id, 'series', state.data.title, 0, ep.name, season);
          if (token) salvos++;
        } catch (error) {
          console.error(`Erro ao salvar episódio ${ep.name}:`, error);
        }
      }

      bot.sendMessage(chatId,
        `✅ *Temporada ${season} Completa!*\n\n📦 ${salvos} de ${episodios.length} episódios salvos\n⏰ Válidos por 7 dias\n\nAcesse em "📦 Meu Conteúdo" para assistir!`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '📦 Ver Meu Conteúdo', callback_data: 'my_content' }], [{ text: '🏠 Menu Principal', callback_data: 'back_main' }]] }
        }
      );
      return;
    }

  } catch (error) {
    console.error('Erro ao processar callback query:', error);
    bot.answerCallbackQuery(query.id, { text: 'Erro ao processar ação' }).catch(() => {});
    bot.sendMessage(chatId, '❌ Erro ao processar sua solicitação. Tente novamente.').catch(() => {});
  }
});

// ============================
// TRATAMENTO DE ERROS
// ============================

bot.on('polling_error', (error) => {
  // Ignora erros de conflito (outra instância rodando) e erros de rede temporários
  if (error.code === 'ETELEGRAM' && error.response?.body?.error_code === 409) {
    console.warn('⚠️ Conflito de polling — outra instância do bot está rodando');
  } else {
    console.error('Erro de polling do bot:', error.message);
  }
});

// ============================
// LIMPEZA PERIÓDICA
// ============================

setInterval(() => {
  const agora            = Date.now();
  const TEMPO_EXPIRACAO  = 15 * 60 * 1000;
  for (const [paymentId, payment] of Object.entries(pendingPayments)) {
    if (agora - payment.timestamp > TEMPO_EXPIRACAO) {
      console.log(`🧹 Removendo pagamento expirado: ${paymentId}`);
      delete pendingPayments[paymentId];
      if (paymentCheckIntervals[paymentId]) {
        clearInterval(paymentCheckIntervals[paymentId]);
        delete paymentCheckIntervals[paymentId];
      }
    }
  }
}, 5 * 60 * 1000);

setInterval(async () => {
  try {
    const resultado = await PurchasedContent.deleteMany({ expiresAt: { $lt: new Date() } });
    if (resultado.deletedCount > 0) console.log(`🧹 Removidos ${resultado.deletedCount} conteúdos expirados`);
  } catch (error) { console.error('Erro ao limpar conteúdos expirados:', error); }
}, 60 * 60 * 1000);

setInterval(verificarConteudosExpirando, 60 * 60 * 1000);
setTimeout(verificarConteudosExpirando, 30000);

// ============================
// EXPORTS
// ============================

module.exports = {
  bot,
  initBot: (models, services, dominio) => {
    User             = models.User;
    AssetSize        = models.AssetSize;
    PurchasedContent = models.PurchasedContent;
    vouverService    = services;
    DOMINIO_PUBLICO  = dominio;
    console.log('✅ Bot do Telegram inicializado com sucesso!');
    console.log(`🌐 Domínio configurado: ${DOMINIO_PUBLICO}`);
    console.log(`🔒 Sistema de proteção DRM ativo`);
    console.log(`💰 Preços: R$ 2,50/hora | Cálculo proporcional por minuto`);
    console.log(`🎬 Filmes: Duração exata do HTML | Válido 24h`);
    console.log(`📺 Séries: Estimativa inteligente | Válido 7 dias`);
  },
  processarPagamentoAprovado,
  getUserCredits,
  addCredits
};