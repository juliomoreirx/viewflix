// ===== CARREGA VARIÁVEIS DE AMBIENTE =====
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const iconv = require('iconv-lite');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const mongoose = require('mongoose');

// ===== IMPORTA BOT DO TELEGRAM =====
const telegramBot = require('./telegram-bot');

// ===== CONFIGURAÇÕES (TODAS DO .ENV) =====
const DOMINIO_PUBLICO = process.env.DOMINIO_PUBLICO || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 3000;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

// MongoDB
const MONGO_URI = process.env.MONGO_URI;

// Credenciais Vouver
const LOGIN_USER = process.env.LOGIN_USER;
const LOGIN_PASS = process.env.LOGIN_PASS;

// URLs Base
const BASE_URL = process.env.BASE_URL || 'http://vouver.me';
const VIDEO_BASE = process.env.VIDEO_BASE || 'http://goplay.icu/series';
const MOVIE_BASE = process.env.MOVIE_BASE || 'http://goplay.icu/movie';

// ===== VALIDAÇÃO DE VARIÁVEIS OBRIGATÓRIAS =====
const requiredVars = {
  MONGO_URI,
  LOGIN_USER,
  LOGIN_PASS,
  JWT_SECRET
};

for (const [key, value] of Object.entries(requiredVars)) {
  if (!value) {
    console.error(`❌ ERRO CRÍTICO: ${key} não definido no .env`);
    process.exit(1);
  }
}

if (!MP_ACCESS_TOKEN) {
  console.warn('⚠️ AVISO: MP_ACCESS_TOKEN não definido - pagamentos PIX não funcionarão');
}

// ===== LOGS DE INICIALIZAÇÃO =====
console.log('✅ [Bot] Variáveis de ambiente carregadas');
console.log(`🌐 Domínio: ${DOMINIO_PUBLICO}`);
console.log(`🚪 Porta: ${PORT}`);
console.log(`👤 Usuário Vouver: ${LOGIN_USER}`);
console.log(`📡 Base URL: ${BASE_URL}`);
console.log(`🎬 Movie Base: ${MOVIE_BASE}`);
console.log(`📺 Video Base: ${VIDEO_BASE}`);

// ===== CONEXÃO MONGODB =====
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB conectado com sucesso!'))
  .catch(err => {
    console.error('❌ Erro ao conectar MongoDB:', err);
    process.exit(1);
  });

// ===== MODELS =====

const userSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true, index: true },
  firstName: { type: String, required: true },
  lastName: { type: String },
  username: { type: String },
  phoneNumber: { type: String },
  credits: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  isBlocked: { type: Boolean, default: false },
  blockedReason: { type: String },
  registeredAt: { type: Date, default: Date.now },
  lastAccess: { type: Date, default: Date.now },
  totalSpent: { type: Number, default: 0 },
  totalPurchases: { type: Number, default: 0 },
  language: { type: String, default: 'pt-BR' },
  notificationsEnabled: { type: Boolean, default: true },
  metadata: {
    telegramLanguageCode: String,
    isPremium: Boolean,
    lastIp: String
  }
});

userSchema.index({ username: 1 });
userSchema.index({ isActive: 1, isBlocked: 1 });
userSchema.index({ registeredAt: -1 });

const User = mongoose.model('User', userSchema);

const assetSizeSchema = new mongoose.Schema({
  assetId: { type: String, required: true, unique: true, index: true },
  mediaType: { type: String, enum: ['movie', 'series', 'series_ep'], required: true },
  bytes: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now, index: true }
});

assetSizeSchema.index({ assetId: 1, mediaType: 1 });

const AssetSize = mongoose.model('AssetSize', assetSizeSchema);

const purchasedContentSchema = new mongoose.Schema({
  userId: { type: Number, required: true, index: true },
  videoId: { type: String, required: true },
  mediaType: { type: String, enum: ['movie', 'series'], required: true },
  title: { type: String, required: true },
  episodeName: { type: String },
  season: { type: String },
  purchaseDate: { type: Date, default: Date.now, index: true },
  expiresAt: { type: Date, required: true, index: true },
  token: { type: String, required: true, unique: true },
  price: { type: Number, required: true },
  viewed: { type: Boolean, default: false },
  viewCount: { type: Number, default: 0 },
  notificationSent: { type: Boolean, default: false },
  sessionToken: { type: String, unique: true }
});

purchasedContentSchema.index({ userId: 1, expiresAt: 1 });
purchasedContentSchema.index({ expiresAt: 1, notificationSent: 1 });

const PurchasedContent = mongoose.model('PurchasedContent', purchasedContentSchema);

const rateLimitSchema = new mongoose.Schema({
  identifier: { type: String, required: true, unique: true, index: true },
  requests: [{ timestamp: Date, videoId: String }],
  blocked: { type: Boolean, default: false },
  blockedUntil: { type: Date }
});

const RateLimit = mongoose.model('RateLimit', rateLimitSchema);

// ===== EXPRESS + AXIOS + CLOUDSCRAPER =====
const app = express();
const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));

// Cliente Cloudscraper para bypassar Cloudflare
const cloudscraperJar = new CookieJar();
const cloudscraperClient = cloudscraper.defaults({
  jar: cloudscraperJar,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
});

console.log('✅ Cloudscraper configurado (bypass Cloudflare)');

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Origin": BASE_URL,
  "Referer": `${BASE_URL}/index.php?page=login`,
  "X-Requested-With": "XMLHttpRequest"
};

app.use(express.json());
app.use(express.static('public'));
app.use('/covers', express.static(path.join(__dirname, 'public', 'covers')));

// ===== ESTADO GLOBAL =====
let userSession = { user: '', pass: '' };
let CACHE_CONTEUDO = { movies: [], series: [], lastUpdated: 0 };

// ===== FUNÇÕES DE SEGURANÇA =====

function generateStreamToken() {
  return crypto.randomBytes(64).toString('hex');
}

function encryptData(data, secret) {
  try {
    const iv = crypto.randomBytes(16);
    const key = crypto.createHash('sha256').update(secret).digest();
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    
    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return iv.toString('hex') + ':' + encrypted;
  } catch (error) {
    console.error('Erro ao encriptar dados:', error);
    return null;
  }
}

function decryptData(encrypted, secret) {
  try {
    const parts = encrypted.split(':');
    if (parts.length !== 2) {
      return null;
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedData = parts[1];
    const key = crypto.createHash('sha256').update(secret).digest();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return JSON.parse(decrypted);
  } catch (error) {
    console.error('Erro ao decriptar dados:', error);
    return null;
  }
}

// ===== MIDDLEWARE: Rate Limiting Avançado =====
async function advancedRateLimit(req, res, next) {
  const identifier = req.ip || req.connection.remoteAddress;
  const now = new Date();
  
  try {
    let limiter = await RateLimit.findOne({ identifier });
    
    if (!limiter) {
      limiter = new RateLimit({ identifier, requests: [] });
    }
    
    if (limiter.blocked && limiter.blockedUntil > now) {
      return res.status(429).json({ 
        error: 'Too many requests. Try again later.',
        retryAfter: Math.ceil((limiter.blockedUntil - now) / 1000)
      });
    }
    
    const sixtySecondsAgo = new Date(now.getTime() - 60000);
    limiter.requests = limiter.requests.filter(r => r.timestamp > sixtySecondsAgo);
    
    limiter.requests.push({ timestamp: now, videoId: req.params.token });
    
    if (limiter.requests.length > 100) {
      limiter.blocked = true;
      limiter.blockedUntil = new Date(now.getTime() + 15 * 60 * 1000);
      await limiter.save();
      
      console.log(`🚫 IP bloqueado por excesso de requisições: ${identifier}`);
      
      return res.status(429).json({ 
        error: 'Rate limit exceeded. Blocked for 15 minutes.',
        retryAfter: 900
      });
    }
    
    await limiter.save();
    next();
  } catch (error) {
    console.error('Erro no rate limiting:', error);
    next();
  }
}

// ===== MIDDLEWARE: Fingerprinting =====
function detectSuspiciousClient(req, res, next) {
  const userAgent = req.headers['user-agent'] || '';
  
  const suspiciousAgents = [
    'wget', 'curl', 'python-requests', 'java', 'go-http-client',
    'download', 'bot', 'spider', 'crawler', 'scraper', 'axios',
    'node-fetch', 'okhttp', 'apache-httpclient', 'downloader'
  ];
  
  const isSuspicious = suspiciousAgents.some(agent => 
    userAgent.toLowerCase().includes(agent)
  );
  
  if (isSuspicious) {
    console.log(`⚠️ Cliente suspeito detectado: ${userAgent} | IP: ${req.ip}`);
    return res.status(403).json({ error: 'Access denied' });
  }
  
  next();
}

// ===== MIDDLEWARE: CORS Restritivo =====
function strictCORS(req, res, next) {
  const origin = req.headers.origin;
  const allowedOrigins = [DOMINIO_PUBLICO];
  
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Stream-Token, X-Encrypted-Data');
  res.setHeader('Access-Control-Max-Age', '600');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
}

// ===== FUNÇÕES DE LOGIN E CACHE COM CLOUDSCRAPER =====

const { fazerLoginComPuppeteer } = require('./vouver-puppeteer');

async function fazerLoginVouver(username, password, tentativa = 1) {
  const MAX_TENTATIVAS = 2; // Reduz tentativas com Puppeteer
  
  if (tentativa > MAX_TENTATIVAS) {
    console.error(`❌ Falha após ${MAX_TENTATIVAS} tentativas de login`);
    return false;
  }
  
  if (tentativa > 1) {
    const delay = tentativa * 3000;
    console.log(`⏳ Aguardando ${delay/1000}s antes da tentativa ${tentativa}...`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  
  console.log(`🔐 Tentativa ${tentativa}/${MAX_TENTATIVAS} - Fazendo login no Vouver...`);
  console.log(`👤 Usuário: ${username}`);
  console.log(`🤖 Usando Puppeteer (navegador real)`);
  
  try {
    const result = await fazerLoginComPuppeteer(username, password, BASE_URL);
    
    if (result.success && result.cookies.length > 0) {
      // Salvar cookies no jar do axios
      result.cookies.forEach(cookie => {
        const cookieString = `${cookie.name}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}`;
        jar.setCookieSync(cookieString, BASE_URL);
      });
      
      userSession.user = username;
      userSession.pass = password;
      
      console.log('✅ Login no Vouver realizado com sucesso!');
      console.log('✅ Cookies transferidos para axios');
      
      await atualizarCache();
      return true;
    } else {
      console.error('❌ Login falhou');
      return await fazerLoginVouver(username, password, tentativa + 1);
    }
    
  } catch (error) {
    console.error(`❌ Erro na tentativa ${tentativa}:`, error.message);
    
    if (tentativa < MAX_TENTATIVAS) {
      return await fazerLoginVouver(username, password, tentativa + 1);
    }
    
    return false;
  }
}

async function atualizarCache() {
  console.log("🔄 Atualizando cache de conteúdo...");
  
  try {
    const response = await client.get(`${BASE_URL}/app/_search.php?q=a`, { 
      headers: HEADERS,
      timeout: 30000
    });
    
    const data = response.data;
    let rawMovies = [], rawSeries = [];
    
    if (data.data) {
      rawMovies = data.data.movies || [];
      rawSeries = data.data.series || [];
    } else if (data.movies) {
      rawMovies = data.movies;
      rawSeries = data.series;
    }
    
    CACHE_CONTEUDO.movies = rawMovies.sort((a, b) => a.name.localeCompare(b.name));
    CACHE_CONTEUDO.series = rawSeries.sort((a, b) => a.name.localeCompare(b.name));
    CACHE_CONTEUDO.lastUpdated = Date.now();
    
    console.log(`✅ Cache atualizado: ${CACHE_CONTEUDO.movies.length} filmes | ${CACHE_CONTEUDO.series.length} séries`);
  } catch (error) {
    console.error("❌ Erro ao atualizar cache:", error.message);
  }
}

// ===== FUNÇÃO: CORRIGIR CARACTERES ESPECIAIS (HTML ENTITIES) =====

function corrigirCaracteresEspeciais(html) {
  const entitiesMap = {
    '&#231;': 'ç', '&#233;': 'é', '&#225;': 'á', '&#227;': 'ã',
    '&#245;': 'õ', '&#237;': 'í', '&#243;': 'ó', '&#250;': 'ú',
    '&#226;': 'â', '&#234;': 'ê', '&#244;': 'ô', '&#224;': 'à',
    '&#199;': 'Ç', '&#201;': 'É', '&#193;': 'Á', '&#195;': 'Ã',
    '&#213;': 'Õ', '&#205;': 'Í', '&#211;': 'Ó', '&#218;': 'Ú',
    '&#194;': 'Â', '&#202;': 'Ê', '&#212;': 'Ô', '&#192;': 'À',
    '&ccedil;': 'ç', '&eacute;': 'é', '&aacute;': 'á', '&atilde;': 'ã',
    '&otilde;': 'õ', '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú',
    '&acirc;': 'â', '&ecirc;': 'ê', '&ocirc;': 'ô', '&agrave;': 'à',
    '&Ccedil;': 'Ç', '&Eacute;': 'É', '&Aacute;': 'Á', '&Atilde;': 'Ã',
    '&Otilde;': 'Õ', '&Iacute;': 'Í', '&Oacute;': 'Ó', '&Uacute;': 'Ú',
    '&Acirc;': 'Â', '&Ecirc;': 'Ê', '&Ocirc;': 'Ô', '&Agrave;': 'À'
  };
  
  for (const [entity, char] of Object.entries(entitiesMap)) {
    html = html.split(entity).join(char);
  }
  
  return html;
}

// ===== FUNÇÃO: LIMPAR E CORRIGIR TEXTO =====

function limparTexto(texto) {
  if (!texto) return '';
  
  texto = texto.trim().replace(/\s+/g, ' ');
  
  texto = texto
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  
  const correcoes = {
    'Ã§': 'ç', 'Ã©': 'é', 'Ã¡': 'á', 'Ã£': 'ã', 'Ãµ': 'õ', 'Ã­': 'í',
    'Ã³': 'ó', 'Ãº': 'ú', 'Ã¢': 'â', 'Ãª': 'ê', 'Ã´': 'ô', 'Ã ': 'à',
    'Ã‡': 'Ç', 'Ã‰': 'É', 'Ã': 'Á', 'Ãƒ': 'Ã', 'Ã': 'Õ', 'Ã': 'Í',
    'Ã"': 'Ó', 'Ãš': 'Ú', 'Ã‚': 'Â', 'ÃŠ': 'Ê', 'Ã"': 'Ô', 'Ã€': 'À',
    '?§': 'ç', '?©': 'é', '?¡': 'á', '?£': 'ã', '?µ': 'õ', '?­': 'í',
    '?³': 'ó', '?º': 'ú', '?¢': 'â', '?ª': 'ê', '?´': 'ô', '? ': 'à',
    'a??o': 'ação', 'A??o': 'Ação', 'A??ES': 'AÇÕES',
    'fic??o': 'ficção', 'Fic??o': 'Ficção',
    'avi?o': 'avião', 'Avi?o': 'Avião',
    'televis?o': 'televisão', 'Televis?o': 'Televisão',
    'miss?o': 'missão', 'Miss?o': 'Missão',
    'cora??o': 'coração', 'Cora??o': 'Coração',
    'tradi??o': 'tradição', 'Tradi??o': 'Tradição',
    'inten??o': 'intenção', 'Inten??o': 'Intenção',
    'aten??o': 'atenção', 'Aten??o': 'Atenção',
    'condi??o': 'condição', 'Condi??o': 'Condição',
    'pris?o': 'prisão', 'Pris?o': 'Prisão',
    'reuni?o': 'reunião', 'Reuni?o': 'Reunião',
    'decis?o': 'decisão', 'Decis?o': 'Decisão',
    'vers?o': 'versão', 'Vers?o': 'Versão',
    'dimens?o': 'dimensão', 'Dimens?o': 'Dimensão',
    'pens?o': 'pensão', 'Pens?o': 'Pensão',
    'tens?o': 'tensão', 'Tens?o': 'Tensão',
    'extens?o': 'extensão', 'Extens?o': 'Extensão',
    'compaix?o': 'compaixão', 'Compaix?o': 'Compaixão',
    'rela??o': 'relação', 'Rela??o': 'Relação',
    'rela??es': 'relações', 'Rela??es': 'Relações',
    'educa??o': 'educação', 'Educa??o': 'Educação',
    'polui??o': 'poluição', 'Polui??o': 'Poluição',
    'produ??o': 'produção', 'Produ??o': 'Produção',
    'intui??o': 'intuição', 'Intui??o': 'Intuição',
    'profu?o': 'profusão', 'Profu?o': 'Profusão',
    'extin??o': 'extinção', 'Extin??o': 'Extinção',
    '? ': 'é ', '?s': 'és',
    'constr?i': 'constrói', 'Constr?i': 'Constrói',
    'bilion?rio': 'bilionário', 'Bilion?rio': 'Bilionário',
    'milion?rio': 'milionário', 'Milion?rio': 'Milionário',
    'ordin?rio': 'ordinário', 'Ordin?rio': 'Ordinário',
    'necess?rio': 'necessário', 'Necess?rio': 'Necessário',
    'tempor?rio': 'temporário', 'Tempor?rio': 'Temporário',
    'prim?rio': 'primário', 'Prim?rio': 'Primário',
    'secret?rio': 'secretário', 'Secret?rio': 'Secretário',
    'advers?rio': 'adversário', 'Advers?rio': 'Adversário',
    'question?rio': 'questionário', 'Question?rio': 'Questionário',
    'liter?rio': 'literário', 'Liter?rio': 'Literário',
    'monet?rio': 'monetário', 'Monet?rio': 'Monetário',
    'sanit?rio': 'sanitário', 'Sanit?rio': 'Sanitário',
    'solid?rio': 'solidário', 'Solid?rio': 'Solidário',
    'volunt?rio': 'voluntário', 'Volunt?rio': 'Voluntário',
    'Bras?lia': 'Brasília',
    'fam?lia': 'família', 'Fam?lia': 'Família',
    'hist?ria': 'história', 'Hist?ria': 'História',
    'mem?ria': 'memória', 'Mem?ria': 'Memória',
    'gl?ria': 'glória', 'Gl?ria': 'Glória',
    'vit?ria': 'vitória', 'Vit?ria': 'Vitória',
    'territ?rio': 'território', 'Territ?rio': 'Território',
    'coment?rio': 'comentário', 'Coment?rio': 'Comentário',
    'relat?rio': 'relatório', 'Relat?rio': 'Relatório',
    'observat?rio': 'observatório', 'Observat?rio': 'Observatório',
    'audit?rio': 'auditório', 'Audit?rio': 'Auditório',
    'laborat?rio': 'laboratório', 'Laborat?rio': 'Laboratório',
    'inv?s': 'invés', 'Inv?s': 'Invés',
    'atrav?s': 'através', 'Atrav?s': 'Através',
    'portugu?s': 'português', 'Portugu?s': 'Português',
    'ingl?s': 'inglês', 'Ingl?s': 'Inglês',
    'franc?s': 'francês', 'Franc?s': 'Francês',
    'japon?s': 'japonês', 'Japon?s': 'Japonês',
    'chin?s': 'chinês', 'Chin?s': 'Chinês',
    'tamb?m': 'também', 'Tamb?m': 'Também',
    'ningu?m': 'ninguém', 'Ningu?m': 'Ninguém',
    'algu?m': 'alguém', 'Algu?m': 'Alguém',
    'por?m': 'porém', 'Por?m': 'Porém',
    'al?m': 'além', 'Al?m': 'Além',
    'cient?fica': 'científica', 'Cient?fica': 'Científica'
  };
  
  for (const [errado, certo] of Object.entries(correcoes)) {
    texto = texto.split(errado).join(certo);
  }
  
  return texto;
}

// ===== BUSCAR DETALHES COM CLOUDSCRAPER =====

async function buscarDetalhes(id, type) {
  let pageType = type === 'movies' ? 'moviedetail' : 'seriesdetail';
  
  try {
    let response = await client.get(`${BASE_URL}/index.php`, {
      params: { page: pageType, id },
      headers: HEADERS,
      timeout: 15000,
      responseType: 'arraybuffer'
    });
    
    let html = null;
    const encodings = ['ISO-8859-1', 'Windows-1252', 'UTF-8', 'latin1'];
    
    for (const encoding of encodings) {
      try {
        const decoded = iconv.decode(Buffer.from(response.data), encoding);
        if (!decoded.includes('�') && !decoded.includes('?�')) {
          html = decoded;
          console.log(`✅ Encoding correto detectado: ${encoding}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!html) {
      html = iconv.decode(Buffer.from(response.data), 'ISO-8859-1');
      html = corrigirCaracteresEspeciais(html);
    }
    
    let $ = cheerio.load(html, { decodeEntities: false });

    if ($('.tab_episode').length === 0 && type !== 'movies') {
      response = await client.get(`${BASE_URL}/index.php`, {
        params: { page: 'moviedetail', id },
        headers: HEADERS,
        timeout: 15000,
        responseType: 'arraybuffer'
      });
      
      html = null;
      for (const encoding of encodings) {
        try {
          const decoded = iconv.decode(Buffer.from(response.data), encoding);
          if (!decoded.includes('�') && !decoded.includes('?�')) {
            html = decoded;
            break;
          }
        } catch (e) {
          continue;
        }
      }
      
      if (!html) {
        html = iconv.decode(Buffer.from(response.data), 'ISO-8859-1');
        html = corrigirCaracteresEspeciais(html);
      }
      
      $ = cheerio.load(html, { decodeEntities: false });
    }

    const data = { seasons: {}, info: {} };
    data.title = limparTexto($('.left-wrap h2').first().text());
    data.info.sinopse = limparTexto($('.left-wrap p').first().text());
    data.mediaType = $('.tab_episode').length > 0 ? 'series' : 'movie';
    
    if (data.mediaType === 'movie') {
      const tags = [];
      $('.left-wrap .tag').each((i, el) => {
        const tagText = limparTexto($(el).text());
        if (tagText) {
          tags.push(tagText);
        }
      });
      
      const imdbText = limparTexto($('.left-wrap .rnd').first().text());
      const imdbMatch = imdbText.match(/IMDB\s+([\d.]+)/i);
      if (imdbMatch) {
        data.info.imdb = parseFloat(imdbMatch[1]);
      }
      
      for (const tag of tags) {
        if (/^\d{4}$/.test(tag)) {
          data.info.ano = parseInt(tag);
        }
        
        const duracaoMatch = tag.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
        if (duracaoMatch) {
          const horas = parseInt(duracaoMatch[1]);
          const minutos = parseInt(duracaoMatch[2]);
          const segundos = parseInt(duracaoMatch[3]);
          
          data.info.duracaoMinutos = (horas * 60) + minutos + Math.ceil(segundos / 60);
          data.info.duracaoTexto = tag;
          
          console.log(`✅ [FILME] Duração exata extraída: ${tag} = ${data.info.duracaoMinutos} minutos`);
        }
        
        if (!tag.includes(':') && isNaN(tag) && !/^\d{4}$/.test(tag)) {
          if (!data.info.genero) {
            data.info.genero = tag;
          }
        }
      }
    }

    if (data.mediaType === 'series') {
      $('.tab_episode').each((i, el) => {
        const seasonNum = i + 1;
        const episodes = [];
        
        $(el).find('a.ep-list-min').each((j, link) => {
          const epId = $(link).attr('data-id');
          const epName = limparTexto($(link).find('.ep-title').text());
          
          if (epId && epName) {
            episodes.push({ name: epName, id: epId });
          }
        });
        
        if (episodes.length > 0) {
          data.seasons[seasonNum] = episodes;
        }
      });
    } else {
      data.seasons["Filme"] = [{ name: data.title || "Filme Completo", id }];
    }
    
    return data;
  } catch (error) {
    console.error("❌ Erro ao buscar detalhes:", error.message);
    return null;
  }
}

// ===== ESTIMAR DURAÇÃO: FILMES (HTML) vs EPISÓDIOS (ESTIMATIVA) =====

async function estimarDuracao(mediaType, id, duracaoDoHTML = null) {
  try {
    if (mediaType === 'movie' && duracaoDoHTML && duracaoDoHTML > 0) {
      console.log(`✅ [FILME] Usando duração exata do HTML: ${duracaoDoHTML}min`);
      
      await AssetSize.findOneAndUpdate(
        { assetId: id, mediaType: 'movie' },
        { 
          bytes: duracaoDoHTML * 60 * 1024 * 1024 * 15, 
          updatedAt: new Date() 
        },
        { upsert: true, new: true }
      );
      
      return duracaoDoHTML;
    }
    
    const cached = await AssetSize.findOne({ 
      assetId: id,
      mediaType: mediaType === 'movie' ? 'movie' : 'series_ep'
    });
    
    if (cached && cached.bytes > 0) {
      const minutos = Math.round(cached.bytes / (1024 * 1024 * 15));
      const duracaoFinal = Math.max(minutos, mediaType === 'movie' ? 90 : 20);
      console.log(`✅ [${mediaType.toUpperCase()}] Duração do cache: ${duracaoFinal}min`);
      return duracaoFinal;
    }
    
    console.log(`🔍 [${mediaType.toUpperCase()}] Buscando tamanho via HEAD/Range: ${id}...`);
    
    const base = mediaType === 'movie' ? MOVIE_BASE : VIDEO_BASE;
    const url = `${base}/${userSession.user}/${userSession.pass}/${id}.mp4`;
    
    try {
      const headResponse = await axios.head(url, {
        headers: {
          'User-Agent': HEADERS['User-Agent'],
          'Referer': BASE_URL,
          'Accept': '*/*'
        },
        timeout: 10000,
        maxRedirects: 5
      });
      
      const contentLength = parseInt(headResponse.headers['content-length'] || '0');
      
      if (contentLength > 0) {
        const minutos = Math.round(contentLength / (1024 * 1024 * 15));
        const duracaoFinal = Math.max(minutos, mediaType === 'movie' ? 90 : 20);
        
        await AssetSize.findOneAndUpdate(
          { assetId: id, mediaType: mediaType === 'movie' ? 'movie' : 'series_ep' },
          { bytes: contentLength, updatedAt: new Date() },
          { upsert: true, new: true }
        );
        
        console.log(`✅ [${mediaType.toUpperCase()}] Duração via HEAD: ${duracaoFinal}min (${(contentLength / (1024 * 1024)).toFixed(2)} MB)`);
        return duracaoFinal;
      }
    } catch (headError) {
      console.log(`⚠️ [${mediaType.toUpperCase()}] HEAD falhou: ${headError.message}`);
    }
    
    try {
      const rangeResponse = await axios.get(url, {
        headers: {
          'User-Agent': HEADERS['User-Agent'],
          'Referer': BASE_URL,
          'Accept': '*/*',
          'Range': 'bytes=0-0'
        },
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: (status) => status === 206 || status === 200 || status === 416
      });
      
      const contentRange = rangeResponse.headers['content-range'];
      if (contentRange) {
        const match = contentRange.match(/bytes \d+-\d+\/(\d+)/);
        if (match) {
          const totalSize = parseInt(match[1]);
          const minutos = Math.round(totalSize / (1024 * 1024 * 15));
          const duracaoFinal = Math.max(minutos, mediaType === 'movie' ? 90 : 20);
          
          await AssetSize.findOneAndUpdate(
            { assetId: id, mediaType: mediaType === 'movie' ? 'movie' : 'series_ep' },
            { bytes: totalSize, updatedAt: new Date() },
            { upsert: true, new: true }
          );
          
          console.log(`✅ [${mediaType.toUpperCase()}] Duração via Range: ${duracaoFinal}min`);
          return duracaoFinal;
        }
      }
    } catch (rangeError) {
      console.log(`⚠️ [${mediaType.toUpperCase()}] Range falhou: ${rangeError.message}`);
    }
    
    const duracaoPadrao = mediaType === 'movie' ? 110 : 42;
    console.log(`⚠️ [${mediaType.toUpperCase()}] Usando duração padrão: ${duracaoPadrao}min`);
    return duracaoPadrao;
    
  } catch (error) {
    console.error(`❌ Erro ao estimar duração: ${error.message}`);
    return mediaType === 'movie' ? 110 : 42;
  }
}

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ===== ENDPOINTS WEB =====

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.json({ status: 'error', message: 'Usuário e senha são obrigatórios' });
    }
    
    const success = await fazerLoginVouver(username, password);
    res.json({ 
      status: success ? 'success' : 'error',
      message: success ? 'Login realizado com sucesso' : 'Falha no login'
    });
  } catch (error) {
    console.error('Erro no endpoint /api/login:', error);
    res.json({ status: 'error', message: 'Erro ao fazer login' });
  }
});

app.get('/api/list', async (req, res) => {
  try {
    const { type = 'movies', page = 1, q } = req.query;
    const pageNum = parseInt(page) || 1;
    const limit = 20;
    
    if (CACHE_CONTEUDO.series.length === 0) {
      await atualizarCache();
    }

    const isAdulto = n => /[\[\(]xxx|\+18|adulto|hentai/i.test(n.toUpperCase());
    
    let lista;
    if (type === 'adult') {
      lista = [...CACHE_CONTEUDO.movies, ...CACHE_CONTEUDO.series].filter(i => isAdulto(i.name));
    } else {
      lista = (CACHE_CONTEUDO[type] || []).filter(i => !isAdulto(i.name));
    }
    
    if (q) {
      lista = lista.filter(i => i.name.toLowerCase().includes(q.toLowerCase()));
    }

    const total = lista.length;
    const items = lista.slice((pageNum - 1) * limit, pageNum * limit);
    
    const data = items.map(item => {
      const folder = type === 'adult' 
        ? (CACHE_CONTEUDO.movies.find(m => m.id === item.id) ? 'movies' : 'series')
        : type;
      
      const coverPath = path.join(__dirname, 'public', 'covers', folder, `${item.id}.jpg`);
      const img = fs.existsSync(coverPath) 
        ? `/covers/${folder}/${item.id}.jpg`
        : 'https://via.placeholder.com/300x450?text=' + encodeURIComponent(item.name);
      
      return { id: item.id, title: item.name, img, type: folder };
    });
    
    res.json({
      data,
      currentPage: pageNum,
      totalPages: Math.ceil(total / limit),
      totalItems: total
    });
  } catch (error) {
    console.error('Erro no endpoint /api/list:', error);
    res.status(500).json({ error: 'Erro ao listar conteúdo' });
  }
});

app.get('/api/details', async (req, res) => {
  try {
    const { id, type } = req.query;
    
    if (!id || !type) {
      return res.status(400).json({ error: 'ID e tipo são obrigatórios' });
    }
    
    const detalhes = await buscarDetalhes(id, type);
    
    if (!detalhes) {
      return res.status(404).json({ error: 'Conteúdo não encontrado' });
    }
    
    res.json(detalhes);
  } catch (error) {
    console.error('Erro no endpoint /api/details:', error);
    res.status(500).json({ error: 'Erro ao buscar detalhes' });
  }
});

// ===== ENDPOINT: Player com Video.js =====
app.get('/player/:token', async (req, res) => {
  try {
    const decoded = jwt.verify(req.params.token, JWT_SECRET);
    const { videoId, mediaType, userId } = decoded;
    
    const purchase = await PurchasedContent.findOne({ token: req.params.token });
    
    if (!purchase) {
      throw new Error('Conteúdo não encontrado');
    }
    
    if (new Date() > purchase.expiresAt) {
      throw new Error('Link expirado');
    }
    
    const user = await User.findOne({ userId });
    if (!user || user.isBlocked) {
      throw new Error('Usuário bloqueado');
    }
    
    purchase.viewed = true;
    purchase.viewCount += 1;
    await purchase.save();
    
    const streamPath = `/api/stream-secure/${req.params.token}/${purchase.sessionToken}`;
    
    res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${purchase.title} - FastTV</title>
    
    <link href="https://vjs.zencdn.net/8.10.0/video-js.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body {
            background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%);
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            color: #fff;
            user-select: none;
        }
        
        .container { width: 100%; max-width: 1400px; padding: 20px; position: relative; }
        
        .logo {
            color: #E50914;
            font-size: 36px;
            font-weight: bold;
            text-align: center;
            margin-bottom: 30px;
            text-shadow: 0 0 20px rgba(229, 9, 20, 0.5);
        }
        
        .video-wrapper {
            position: relative;
            width: 100%;
            background: #000;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 20px 60px rgba(0,0,0,0.8);
        }
        
        .video-js {
            width: 100%;
            height: 80vh;
            font-family: 'Segoe UI', Arial, sans-serif;
        }
        
        .vjs-theme-fasttv .vjs-control-bar {
            background: linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.7) 50%, transparent 100%);
            height: 4em;
        }
        
        .vjs-theme-fasttv .vjs-big-play-button {
            background: rgba(229, 9, 20, 0.9);
            border: none;
            border-radius: 50%;
            width: 2em;
            height: 2em;
            line-height: 2em;
            font-size: 3em;
            left: 50%;
            top: 50%;
            transform: translate(-50%, -50%);
            transition: all 0.3s;
        }
        
        .vjs-theme-fasttv .vjs-big-play-button:hover {
            background: rgba(229, 9, 20, 1);
            transform: translate(-50%, -50%) scale(1.1);
        }
        
        .vjs-theme-fasttv .vjs-play-progress {
            background-color: #E50914;
        }
        
        .vjs-theme-fasttv .vjs-volume-level {
            background-color: #E50914;
        }
        
        .vjs-theme-fasttv .vjs-slider {
            background-color: rgba(255,255,255,0.3);
        }
        
        .vjs-theme-fasttv .vjs-load-progress {
            background: rgba(255,255,255,0.2);
        }
        
        .vjs-download-button,
        .vjs-picture-in-picture-control {
            display: none !important;
        }
        
        .vjs-loading-spinner {
            border-color: #E50914 transparent transparent transparent;
        }
        
        .info-bar {
            background: rgba(20,20,20,0.95);
            backdrop-filter: blur(10px);
            padding: 20px;
            border-radius: 12px;
            margin-top: 20px;
            border: 1px solid rgba(255,255,255,0.1);
        }
        
        .title { font-size: 24px; font-weight: bold; margin-bottom: 10px; color: #fff; }
        
        .meta {
            display: flex;
            gap: 20px;
            flex-wrap: wrap;
            font-size: 14px;
            color: #aaa;
            margin-bottom: 15px;
        }
        
        .meta span { display: flex; align-items: center; gap: 8px; }
        
        .controls {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            justify-content: center;
            margin-top: 20px;
        }
        
        .btn {
            background: linear-gradient(135deg, #E50914 0%, #B20710 100%);
            color: #fff;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 16px;
            cursor: pointer;
            transition: all 0.3s;
            display: flex;
            align-items: center;
            gap: 8px;
            box-shadow: 0 4px 15px rgba(229, 9, 20, 0.3);
        }
        
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(229, 9, 20, 0.5);
        }
        
        .btn.secondary { background: linear-gradient(135deg, #333 0%, #222 100%); }
        
        .warning {
            text-align: center;
            margin-top: 20px;
            padding: 15px;
            background: rgba(229, 9, 20, 0.1);
            border-radius: 8px;
            font-size: 14px;
            border: 1px solid rgba(229, 9, 20, 0.3);
        }
        
        .timer {
            display: inline-block;
            background: rgba(229, 9, 20, 0.2);
            padding: 5px 12px;
            border-radius: 20px;
            font-weight: bold;
        }
        
        @media (max-width: 768px) {
            .logo { font-size: 28px; }
            .title { font-size: 20px; }
            .controls { flex-direction: column; }
            .btn { width: 100%; justify-content: center; }
            .video-js { height: 50vh; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">FAST<span style="color: #fff">TV</span></div>
        
        <div class="video-wrapper">
            <video 
                id="player" 
                class="video-js vjs-theme-fasttv vjs-big-play-centered"
                controls
                preload="auto"
                data-setup='{
                    "fluid": true,
                    "aspectRatio": "16:9",
                    "playbackRates": [0.5, 0.75, 1, 1.25, 1.5, 2],
                    "controlBar": {
                        "pictureInPictureToggle": false,
                        "volumePanel": {
                            "inline": false
                        }
                    }
                }'
            >
                <source src="${streamPath}" type="video/mp4">
                <p class="vjs-no-js">
                    Para visualizar este vídeo, ative o JavaScript ou use um navegador que suporte HTML5.
                </p>
            </video>
        </div>
        
        <div class="info-bar">
            <div class="title">${purchase.title}</div>
            ${purchase.episodeName ? `<div class="meta"><span><i class="fas fa-tv"></i> ${purchase.episodeName}</span></div>` : ''}
            <div class="meta">
                <span><i class="fas fa-calendar"></i> Comprado em ${new Date(purchase.purchaseDate).toLocaleDateString('pt-BR')}</span>
                <span><i class="fas fa-clock"></i> Expira em <span class="timer" id="countdown"></span></span>
                <span><i class="fas fa-eye"></i> ${purchase.viewCount} visualizaç${purchase.viewCount === 1 ? 'ão' : 'ões'}</span>
            </div>
            
            <div class="controls">
                <button class="btn" onclick="toggleFullscreen()">
                    <i class="fas fa-expand"></i> Tela Cheia
                </button>
                <button class="btn secondary" onclick="setSpeed(1.5)">
                    <i class="fas fa-forward"></i> 1.5x
                </button>
                <button class="btn secondary" onclick="setSpeed(1.0)">
                    <i class="fas fa-play"></i> Normal
                </button>
                <button class="btn secondary" onclick="setSpeed(0.75)">
                    <i class="fas fa-backward"></i> 0.75x
                </button>
            </div>
        </div>
        
        <div class="warning">
            <i class="fas fa-shield-alt"></i>
            Este link é pessoal e intransferível • Protegido por DRM • ID: ${userId}
        </div>
    </div>
    
    <script src="https://vjs.zencdn.net/8.10.0/video.min.js"></script>
    
    <script>
        const expiresAt = new Date('${purchase.expiresAt.toISOString()}');
        let player;
        
        document.addEventListener('DOMContentLoaded', function() {
            player = videojs('player', {
                controls: true,
                autoplay: false,
                preload: 'auto',
                fluid: true,
                responsive: true
            });
            
            player.el().addEventListener('contextmenu', function(e) {
                e.preventDefault();
                return false;
            });
            
            document.addEventListener('contextmenu', function(e) {
                e.preventDefault();
                return false;
            });
            
            document.addEventListener('keydown', function(e) {
                if (
                    e.keyCode === 123 ||
                    (e.ctrlKey && e.shiftKey && e.keyCode === 73) ||
                    (e.ctrlKey && e.shiftKey && e.keyCode === 74) ||
                    (e.ctrlKey && e.keyCode === 85) ||
                    (e.ctrlKey && e.keyCode === 83)
                ) {
                    e.preventDefault();
                    return false;
                }
            });
            
            (function() {
                const threshold = 160;
                setInterval(function() {
                    if (window.outerWidth - window.innerWidth > threshold ||
                        window.outerHeight - window.innerHeight > threshold) {
                        document.body.innerHTML = '<div style="color:#fff;text-align:center;padding:50px;"><h1>⚠️ Acesso Negado</h1><p>DevTools detectado.</p></div>';
                        if (player) {
                            player.pause();
                            player.dispose();
                        }
                    }
                }, 1000);
            })();
            
            let playLogged = false;
            player.on('play', function() {
                if (!playLogged) {
                    fetch('/api/log-view', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            userId: ${userId},
                            videoId: '${videoId}',
                            token: '${req.params.token}',
                            timestamp: Date.now()
                        })
                    });
                    playLogged = true;
                }
            });
            
            player.on('enterpictureinpicture', function(e) {
                e.preventDefault();
                document.exitPictureInPicture().catch(() => {});
            });
        });
        
        function updateCountdown() {
            const now = new Date();
            const diff = expiresAt - now;
            
            if (diff <= 0) {
                document.getElementById('countdown').innerText = 'EXPIRADO';
                if (player) {
                    player.pause();
                    player.dispose();
                }
                return;
            }
            
            const hours = Math.floor(diff / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            
            document.getElementById('countdown').innerText = hours + 'h ' + minutes + 'm';
        }
        
        updateCountdown();
        setInterval(updateCountdown, 60000);
        
        function toggleFullscreen() {
            if (player) {
                if (!player.isFullscreen()) {
                    player.requestFullscreen();
                } else {
                    player.exitFullscreen();
                }
            }
        }
        
        function setSpeed(speed) {
            if (player) {
                player.playbackRate(speed);
            }
        }
        
        document.addEventListener('keydown', function(e) {
            if (!player) return;
            
            switch(e.code) {
                case 'Space':
                    e.preventDefault();
                    if (player.paused()) {
                        player.play();
                    } else {
                        player.pause();
                    }
                    break;
                    
                case 'ArrowRight':
                    player.currentTime(player.currentTime() + 10);
                    break;
                    
                case 'ArrowLeft':
                    player.currentTime(player.currentTime() - 10);
                    break;
                    
                case 'ArrowUp':
                    e.preventDefault();
                    player.volume(Math.min(1, player.volume() + 0.1));
                    break;
                    
                case 'ArrowDown':
                    e.preventDefault();
                    player.volume(Math.max(0, player.volume() - 0.1));
                    break;
                    
                case 'KeyF':
                    toggleFullscreen();
                    break;
                    
                case 'KeyM':
                    player.muted(!player.muted());
                    break;
            }
        });
    </script>
</body>
</html>
    `);
  } catch (error) {
    console.error('Erro no player:', error.message);
    res.status(403).send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <title>Acesso Negado - FastTV</title>
    <style>
        body {
            background: #0a0a0a;
            color: #fff;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            font-family: Arial, sans-serif;
            text-align: center;
        }
        .error { max-width: 600px; padding: 40px; }
        h1 { color: #E50914; margin-bottom: 20px; }
    </style>
</head>
<body>
    <div class="error">
        <h1>⚠️ Acesso Negado</h1>
        <p>Link inválido, expirado ou usuário bloqueado.</p>
    </div>
</body>
</html>
    `);
  }
});

// ===== ENDPOINT: Streaming Progressivo Seguro =====
app.get('/api/stream-secure/:token/:sessionToken', 
  detectSuspiciousClient,
  advancedRateLimit,
  async (req, res) => {
    try {
      const contentToken = req.params.token;
      const sessionToken = req.params.sessionToken;
      
      const decoded = jwt.verify(contentToken, JWT_SECRET);
      const { videoId, mediaType, userId } = decoded;
      
      const purchase = await PurchasedContent.findOne({ 
        token: contentToken,
        sessionToken: sessionToken 
      });
      
      if (!purchase || new Date() > purchase.expiresAt) {
        console.log('⚠️ Conteúdo expirado ou não encontrado');
        return res.sendStatus(403);
      }
      
      const user = await User.findOne({ userId });
      if (!user || user.isBlocked) {
        console.log('⚠️ Usuário bloqueado');
        return res.sendStatus(403);
      }
      
      const base = mediaType === 'movie' ? MOVIE_BASE : VIDEO_BASE;
      const videoUrl = `${base}/${userSession.user}/${userSession.pass}/${videoId}.mp4`;
      
      console.log(`🎬 Streaming: ${videoId} | User: ${userId}`);
      
      const response = await axios({
        url: videoUrl,
        method: 'GET',
        responseType: 'stream',
        headers: {
          Range: req.headers.range,
          'User-Agent': HEADERS['User-Agent'],
          Referer: BASE_URL
        },
        timeout: 30000
      });
      
      ['content-range', 'accept-ranges', 'content-length', 'content-type'].forEach(h => {
        if (response.headers[h]) {
          res.setHeader(h, response.headers[h]);
        }
      });
      
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      
      res.status(response.status);
      response.data.pipe(res);
      
    } catch (error) {
      console.error('Erro no streaming:', error.message);
      res.sendStatus(403);
    }
  }
);

app.post('/api/log-view', async (req, res) => {
  try {
    const { userId, videoId, token, timestamp } = req.body;
    console.log(`📊 Play: User ${userId} | Vídeo ${videoId}`);
    res.sendStatus(200);
  } catch (error) {
    res.sendStatus(500);
  }
});

// ===== API ADMINISTRATIVA =====

function adminAuth(req, res, next) {
  const authToken = req.headers['authorization'];
  const validToken = process.env.ADMIN_API_TOKEN || 'seu-token-super-secreto';
  
  if (authToken !== `Bearer ${validToken}`) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  
  next();
}

app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    
    const users = await User.find()
      .sort({ registeredAt: -1 })
      .skip(skip)
      .limit(limit);
    
    const total = await User.countDocuments();
    
    res.json({
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    res.status(500).json({ error: 'Erro ao listar usuários' });
  }
});

app.get('/api/admin/users/:userId', adminAuth, async (req, res) => {
  try {
    const user = await User.findOne({ userId: parseInt(req.params.userId) });
    
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const purchases = await PurchasedContent.find({ userId: user.userId })
      .sort({ purchaseDate: -1 })
      .limit(10);
    
    res.json({ user, recentPurchases: purchases });
  } catch (error) {
    console.error('Erro ao buscar usuário:', error);
    res.status(500).json({ error: 'Erro ao buscar usuário' });
  }
});

app.put('/api/admin/users/:userId/credits', adminAuth, async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = parseInt(req.params.userId);
    
    const user = await User.findOne({ userId });
    
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    user.credits += amount;
    await user.save();
    
    res.json({ success: true, newBalance: user.credits });
  } catch (error) {
    console.error('Erro ao atualizar créditos:', error);
    res.status(500).json({ error: 'Erro ao atualizar créditos' });
  }
});

app.put('/api/admin/users/:userId/block', adminAuth, async (req, res) => {
  try {
    const { blocked, reason } = req.body;
    const userId = parseInt(req.params.userId);
    
    const user = await User.findOne({ userId });
    
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    user.isBlocked = blocked;
    user.blockedReason = reason || null;
    await user.save();
    
    res.json({ success: true, user });
  } catch (error) {
    console.error('Erro ao bloquear usuário:', error);
    res.status(500).json({ error: 'Erro ao bloquear usuário' });
  }
});

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const stats = {
      users: {
        total: await User.countDocuments(),
        active: await User.countDocuments({ isActive: true, isBlocked: false }),
        blocked: await User.countDocuments({ isBlocked: true })
      },
      purchases: {
        total: (await User.aggregate([
          { $group: { _id: null, total: { $sum: '$totalPurchases' } } }
        ]))[0]?.total || 0,
        revenue: (await User.aggregate([
          { $group: { _id: null, total: { $sum: '$totalSpent' } } }
        ]))[0]?.total || 0
      },
      content: {
        active: await PurchasedContent.countDocuments({ expiresAt: { $gt: new Date() } }),
        expired: await PurchasedContent.countDocuments({ expiresAt: { $lte: new Date() } })
      },
      catalog: {
        movies: CACHE_CONTEUDO.movies.length,
        series: CACHE_CONTEUDO.series.length
      }
    };
    
    res.json(stats);
  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    res.status(500).json({ error: 'Erro ao buscar estatísticas' });
  }
});

// ===== WEBHOOK MERCADO PAGO =====

app.post('/webhook/mercadopago', async (req, res) => {
  console.log('📥 Webhook do Mercado Pago recebido');

  try {
    let paymentId;

    if (req.body.type === 'payment' && req.body.data?.id) {
      paymentId = req.body.data.id;
    } else if (req.body.action === 'payment.updated' && req.body.data?.id) {
      paymentId = req.body.data.id;
    } else if (req.body.topic === 'payment' && req.body.resource) {
      const resourceParts = req.body.resource.split('/');
      paymentId = resourceParts[resourceParts.length - 1];
    } else {
      return res.sendStatus(200);
    }

    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${paymentId}`,
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`
        },
        timeout: 10000
      }
    );

    const payment = response.data;

    if (payment.status === 'approved') {
      const userId = parseInt(payment.external_reference);
      const amount = Math.round(payment.transaction_amount * 100);

      if (!userId || !amount) {
        return res.sendStatus(200);
      }

      const sucesso = await telegramBot.processarPagamentoAprovado(paymentId, userId, amount);

      if (sucesso) {
        console.log(`✅ Créditos adicionados: User ${userId} | Valor: R$ ${(amount/100).toFixed(2)}`);
      }
    }
  } catch (error) {
    console.error('❌ Erro ao processar webhook:', error.message);
  }

  res.sendStatus(200);
});

// ===== LIMPEZA AUTOMÁTICA =====

setInterval(async () => {
  try {
    const result = await RateLimit.deleteMany({
      blocked: false,
      'requests.0': { $exists: false }
    });
    
    if (result.deletedCount > 0) {
      console.log(`🧹 Removidos ${result.deletedCount} rate limiters inativos`);
    }
  } catch (error) {
    console.error('Erro ao limpar rate limiters:', error);
  }
}, 60 * 60 * 1000);

setInterval(async () => {
  try {
    const resultado = await PurchasedContent.deleteMany({
      expiresAt: { $lt: new Date() }
    });
    
    if (resultado.deletedCount > 0) {
      console.log(`🧹 Removidos ${resultado.deletedCount} conteúdos expirados`);
    }
  } catch (error) {
    console.error('Erro ao limpar conteúdos expirados:', error);
  }
}, 60 * 60 * 1000);

// ===== INICIALIZAÇÃO =====

async function iniciarServidor() {
  try {
    if (LOGIN_USER && LOGIN_PASS) {
      console.log('🔐 Fazendo login automático no Vouver...');
      const loginSucesso = await fazerLoginVouver(LOGIN_USER, LOGIN_PASS);
      
      if (!loginSucesso) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('⚠️ MODO DEGRADADO ATIVADO');
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('Login no Vouver falhou, mas sistema continua funcionando.');
        console.error('Algumas funcionalidades podem estar limitadas:');
        console.error('  - Cache pode estar vazio');
        console.error('  - Busca pode não funcionar');
        console.error('  - Streaming pode falhar');
        console.error('');
        console.error('💡 SOLUÇÕES:');
        console.error('  1. Verifique credenciais: LOGIN_USER e LOGIN_PASS');
        console.error('  2. Teste login manual em: http://vouver.me');
        console.error('  3. Considere usar proxy se IP estiver bloqueado');
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        userSession.user = LOGIN_USER;
        userSession.pass = LOGIN_PASS;
      }
    }

    telegramBot.initBot(
      { User, AssetSize, PurchasedContent },
      {
        buscarDetalhes,
        estimarDuracao,
        atualizarCache,
        CACHE_CONTEUDO
      },
      DOMINIO_PUBLICO
    );

    app.listen(PORT, () => {
      console.log('\n' + '='.repeat(60));
      console.log('🚀 FastTV Server - Versão Final Completa!');
      console.log('='.repeat(60));
      console.log(`📡 Servidor: ${DOMINIO_PUBLICO}`);
      console.log(`🔒 Streaming Progressivo: Ativo`);
      console.log(`🌐 URLs Relativas: Compatível com qualquer domínio`);
      console.log(`🎬 Player: Video.js com proteção DRM`);
      console.log(`💰 Preços: R$ 2,50/hora (Cálculo proporcional)`);
      console.log(`📝 Encoding: UTF-8 corrigido (200+ padrões)`);
      console.log(`⏱️ Duração: Exata para filmes (HTML)`);
      console.log(`🤖 Bot: Ativo`);
      console.log(`💳 PIX: ${MP_ACCESS_TOKEN ? 'Ativo' : 'Inativo'}`);
      console.log(`📊 Cache: ${CACHE_CONTEUDO.movies.length} filmes | ${CACHE_CONTEUDO.series.length} séries`);
      console.log('='.repeat(60) + '\n');
    });

    setInterval(async () => {
      await atualizarCache();
    }, 6 * 60 * 60 * 1000);

  } catch (error) {
    console.error('❌ Erro ao iniciar servidor:', error);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

iniciarServidor();