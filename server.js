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

// Cloudflare Worker
const CLOUDFLARE_WORKER_URL = process.env.CLOUDFLARE_WORKER_URL;

// Cloudflare clearance cookie (obter do browser logado)
const CF_CLEARANCE = process.env.CF_CLEARANCE || '';

// Sessão pré-autenticada (gerada localmente e colada no .env)
const SESSION_COOKIES_ENV = process.env.SESSION_COOKIES || '';

if (CLOUDFLARE_WORKER_URL) {
  console.log(`☁️ Cloudflare Worker configurado: ${CLOUDFLARE_WORKER_URL}`);
}

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

// ===== EXPRESS + AXIOS =====
const app = express();
const jar = new CookieJar();
const client = wrapper(axios.create({ jar, withCredentials: true }));

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "max-age=0",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1"
};

app.use(express.json());
app.use(express.static('public'));
app.use('/covers', express.static(path.join(__dirname, 'public', 'covers')));

// ===== ESTADO GLOBAL =====
let userSession = { user: '', pass: '' };
let CACHE_CONTEUDO = { movies: [], series: [], lastUpdated: 0 };
let SESSION_COOKIES = '';

// ===== FUNÇÕES DE COOKIES (PATCH) =====
async function hydrateJarFromCookieString(cookieStr, baseUrl) {
  if (!cookieStr) return;
  const parts = cookieStr.split(';').map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.substring(0, idx).trim();
    const value = part.substring(idx + 1).trim();
    try {
      await jar.setCookie(`${name}=${value}; Path=/`, baseUrl);
    } catch (e) {
      console.log(`⚠️ Falha ao setar cookie no jar: ${name}`);
    }
  }
}

async function refreshSessionCookiesFromJar() {
  try {
    const cookies = await jar.getCookies(BASE_URL);
    SESSION_COOKIES = cookies.map(c => `${c.key}=${c.value}`).join('; ');
    return SESSION_COOKIES;
  } catch (e) {
    console.error('❌ Erro ao ler cookies do jar:', e.message);
    return SESSION_COOKIES;
  }
}

async function logCurrentCookies(context = '') {
  try {
    const cookies = await jar.getCookies(BASE_URL);
    console.log(`🍪 [${context}] Cookies no jar (${cookies.length}): ${cookies.map(c => c.key).join(', ')}`);
  } catch (e) {
    console.log(`⚠️ [${context}] Não foi possível listar cookies`);
  }
}

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

// ===== FUNÇÃO AUXILIAR: EXTRAIR E MESCLAR COOKIES =====

function extrairCookies(setCookieHeader, cookiesArray = []) {
  const cookies = [...cookiesArray];
  (setCookieHeader || []).forEach(cookieStr => {
    const pair = cookieStr.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const name = pair.substring(0, idx).trim();
      const value = pair.substring(idx + 1).trim();
      const existing = cookies.findIndex(c => c.name === name);
      if (existing >= 0) cookies[existing].value = value;
      else cookies.push({ name, value });
    }
  });
  return cookies;
}

function cookieString(arr) {
  return arr.map(c => `${c.name}=${c.value}`).join('; ');
}

// ===== FUNÇÃO DE LOGIN =====

async function fazerLoginVouver(username, password, tentativa = 1) {
  const MAX_TENTATIVAS = 3;

  if (tentativa > MAX_TENTATIVAS) {
    console.error(`❌ Falha após ${MAX_TENTATIVAS} tentativas`);
    return false;
  }

  console.log(`🔐 Tentativa ${tentativa}/${MAX_TENTATIVAS} - Fazendo login no Vouver...`);
  console.log(`👤 Usuário: ${username}`);

  try {
    // Reinicia jar por tentativa (reduz lixo de sessão quebrada)
    await jar.removeAllCookies();

    // Injeta cf_clearance se houver
    if (CF_CLEARANCE) {
      await jar.setCookie(`cf_clearance=${CF_CLEARANCE}; Path=/`, BASE_URL);
      console.log('🛡️ cf_clearance injetado no CookieJar');
    } else {
      console.log('⚠️ CF_CLEARANCE não definido no .env — pode falhar no WAF');
    }

    // ── PASSO 1: Carregar página de login e extrair CSRF token ──
    console.log('📡 Acessando página de login...');

    const loginPageResponse = await client.get(`${BASE_URL}/index.php?page=login`, {
      headers: {
        ...HEADERS,
        'Sec-Fetch-Site': 'none'
      },
      timeout: 30000,
      maxRedirects: 5
    });

    console.log(`📄 Status página login: ${loginPageResponse.status}`);
    console.log(`📄 Tamanho HTML: ${String(loginPageResponse.data || '').length} chars`);

    // Extrair CSRF token do HTML
    const htmlPage = loginPageResponse.data;
    const csrfMatch =
      htmlPage.match(/name=["']csrf_token["']\s+value=["']([\w-]+)["']/i) ||
      htmlPage.match(/csrf_token["']\s+value=["']([a-f0-9-]+)["']/i) ||
      htmlPage.match(/name=["']csrf_token["'][^>]*value=["']([a-f0-9-]+)["']/i);
    const csrfToken = csrfMatch ? csrfMatch[1] : '';

    console.log(`🔑 CSRF token: ${csrfToken ? csrfToken.substring(0, 16) + '...' : 'NÃO ENCONTRADO'}`);

    await logCurrentCookies('login-page');

    // ── PASSO 2: POST no form HTML ──
    console.log('🚀 Submetendo formulário de login...');

    const formData = new URLSearchParams({
      'username': username,
      'sifre': password,
      'beni_hatirla': 'on',
      'csrf_token': csrfToken,
      'recaptcha_response': '',
      'login': 'Acessar'
    });

    await client.post(
      `${BASE_URL}/index.php?page=login`,
      formData.toString(),
      {
        headers: {
          ...HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': BASE_URL,
          'Referer': `${BASE_URL}/index.php?page=login`,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-User': '?1',
          'Sec-Fetch-Dest': 'document',
          'Upgrade-Insecure-Requests': '1'
        },
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: s => s < 500
      }
    );

    // ── PASSO 3: AJAX login ──
    console.log('🚀 Fazendo AJAX login...');

    const ajaxData = new URLSearchParams({
      'username': username,
      'password': password,
      'csrf_token': csrfToken,
      'type': '1'
    });

    const ajaxResponse = await client.post(
      `${BASE_URL}/ajax/login.php`,
      ajaxData.toString(),
      {
        headers: {
          ...HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': BASE_URL,
          'Referer': `${BASE_URL}/index.php?page=login`,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty'
        },
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: s => s < 500
      }
    );

    console.log('📊 Resposta AJAX:', ajaxResponse.data);

    // ── PASSO 4: Verificar homepage ──
    console.log('📡 Verificando login na homepage...');

    const homepageResponse = await client.get(
      `${BASE_URL}/index.php?page=homepage`,
      {
        headers: {
          ...HEADERS,
          'Referer': `${BASE_URL}/index.php?page=login`,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'navigate',
          'Upgrade-Insecure-Requests': '1'
        },
        timeout: 30000,
        maxRedirects: 5
      }
    );

    const homepageHtml = homepageResponse.data;

    if (homepageHtml.includes('Meu Perfil') || homepageHtml.includes('Sair') || homepageHtml.includes('sair')) {
      console.log('✅✅✅ LOGIN VERIFICADO COM SUCESSO!');

      userSession.user = username;
      userSession.pass = password;

      await refreshSessionCookiesFromJar();
      await logCurrentCookies('login-sucesso');

      console.log(`🍪 SESSION_COOKIES atualizado (${SESSION_COOKIES.length} chars)`);

      await atualizarCache();
      return true;
    } else {
      console.log('⚠️ Homepage não indica login bem-sucedido, tentando novamente...');
      return await fazerLoginVouver(username, password, tentativa + 1);
    }

  } catch (error) {
    console.error(`❌ Erro na tentativa ${tentativa}:`, error.message);
    if (error.code) console.error(`   Código do erro: ${error.code}`);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      const body = typeof error.response.data === 'string'
        ? error.response.data.substring(0, 300)
        : JSON.stringify(error.response.data).substring(0, 300);
      console.error(`   Body: ${body}`);
    }

    if (tentativa < MAX_TENTATIVAS) {
      console.log(`🔄 Tentando novamente...`);
      return await fazerLoginVouver(username, password, tentativa + 1);
    }
    return false;
  }
}

// ===== FUNÇÃO: ATUALIZAR CACHE =====

async function atualizarCache() {
  console.log("🔄 Atualizando cache de conteúdo...");

  try {
    // ===== 1. TENTAR ARQUIVO LOCAL PRIMEIRO =====
    const contentPath = path.join(__dirname, 'content.json');

    if (fs.existsSync(contentPath)) {
      console.log('📦 Carregando catálogo do arquivo content.json...');

      try {
        const fileContent = fs.readFileSync(contentPath, 'utf8');
        const cacheData = JSON.parse(fileContent);

        let rawMovies = [], rawSeries = [];

        if (cacheData.data) {
          rawMovies = cacheData.data.movies || [];
          rawSeries = cacheData.data.series || [];
        } else if (cacheData.movies) {
          rawMovies = cacheData.movies;
          rawSeries = cacheData.series;
        }

        if (rawMovies.length > 0 || rawSeries.length > 0) {
          CACHE_CONTEUDO.movies = rawMovies.sort((a, b) => a.name.localeCompare(b.name));
          CACHE_CONTEUDO.series = rawSeries.sort((a, b) => a.name.localeCompare(b.name));
          CACHE_CONTEUDO.lastUpdated = Date.now();

          console.log(`✅ Cache carregado do arquivo JSON: ${CACHE_CONTEUDO.movies.length} filmes | ${CACHE_CONTEUDO.series.length} séries`);
          return;
        }
      } catch (jsonError) {
        console.error('❌ Erro ao ler content.json:', jsonError.message);
      }
    }

    // ===== 2. TENTAR VIA CLOUDFLARE WORKER =====
    if (CLOUDFLARE_WORKER_URL && SESSION_COOKIES) {
      console.log('☁️ Tentando buscar cache via Cloudflare Worker...');

      try {
        const response = await axios.post(
          `${CLOUDFLARE_WORKER_URL}/cache-direct`,
          { cookies: SESSION_COOKIES },
          { timeout: 30000 }
        );

        const data = response.data;

        if (data.success && data.data) {
          let rawMovies = [], rawSeries = [];

          if (data.data.data) {
            rawMovies = data.data.data.movies || [];
            rawSeries = data.data.data.series || [];
          } else if (data.data.movies) {
            rawMovies = data.data.movies;
            rawSeries = data.data.series;
          }

          if (rawMovies.length > 0 || rawSeries.length > 0) {
            CACHE_CONTEUDO.movies = rawMovies.sort((a, b) => a.name.localeCompare(b.name));
            CACHE_CONTEUDO.series = rawSeries.sort((a, b) => a.name.localeCompare(b.name));
            CACHE_CONTEUDO.lastUpdated = Date.now();

            console.log(`✅ Cache obtido via Worker: ${CACHE_CONTEUDO.movies.length} filmes | ${CACHE_CONTEUDO.series.length} séries`);

            try {
              const dataToSave = {
                status: true,
                error: null,
                data: { movies: rawMovies, series: rawSeries },
                lastUpdated: new Date().toISOString()
              };

              fs.writeFileSync(contentPath, JSON.stringify(dataToSave, null, 2), 'utf8');
              console.log('💾 Cache salvo em content.json');
            } catch (saveError) {
              console.log('⚠️ Não foi possível salvar content.json');
            }

            return;
          }
        }
      } catch (workerError) {
        console.log('⚠️ Worker falhou:', workerError.message);
      }
    }

    // ===== 3. BUSCAR DIRETAMENTE (IP LOCAL) =====
    if (SESSION_COOKIES) {
      console.log('🌐 Buscando cache diretamente (IP local)...');

      try {
        await refreshSessionCookiesFromJar();

        const cacheResponse = await client.get(
          `${BASE_URL}/app/_search.php?q=a`,
          {
            headers: {
              'User-Agent': HEADERS['User-Agent'],
              'Accept': 'application/json, text/plain, */*',
              'Referer': `${BASE_URL}/index.php?page=homepage`
            },
            timeout: 30000
          }
        );

        const cacheData = cacheResponse.data;

        let rawMovies = [], rawSeries = [];

        if (cacheData.data) {
          rawMovies = cacheData.data.movies || [];
          rawSeries = cacheData.data.series || [];
        } else if (cacheData.movies) {
          rawMovies = cacheData.movies;
          rawSeries = cacheData.series;
        }

        if (rawMovies.length > 0 || rawSeries.length > 0) {
          CACHE_CONTEUDO.movies = rawMovies.sort((a, b) => a.name.localeCompare(b.name));
          CACHE_CONTEUDO.series = rawSeries.sort((a, b) => a.name.localeCompare(b.name));
          CACHE_CONTEUDO.lastUpdated = Date.now();

          console.log(`✅ Cache obtido diretamente: ${CACHE_CONTEUDO.movies.length} filmes | ${CACHE_CONTEUDO.series.length} séries`);

          try {
            const dataToSave = {
              status: true,
              error: null,
              data: { movies: rawMovies, series: rawSeries },
              lastUpdated: new Date().toISOString()
            };

            fs.writeFileSync(contentPath, JSON.stringify(dataToSave, null, 2), 'utf8');
            console.log('💾 Cache salvo em content.json');
          } catch (saveError) {
            console.log('⚠️ Não foi possível salvar content.json');
          }

          return;
        }
      } catch (directError) {
        console.error('❌ Erro ao buscar cache diretamente:', directError.message);
      }
    }

    console.error("⚠️ Cache não pôde ser carregado");

  } catch (error) {
    console.error("❌ Erro ao atualizar cache:", error.message);
  }
}

// ===== FUNÇÃO: CORRIGIR CARACTERES ESPECIAIS =====

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

// ===== FUNÇÃO: LIMPAR TEXTO =====

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
    'a??o': 'ação', 'A??o': 'Ação',
    'fic??o': 'ficção', 'miss?o': 'missão', 'cora??o': 'coração'
  };

  for (const [errado, certo] of Object.entries(correcoes)) {
    texto = texto.split(errado).join(certo);
  }

  return texto;
}

// ===== BUSCAR DETALHES =====

async function buscarDetalhes(id, type) {
  let pageType = type === 'movies' ? 'moviedetail' : 'seriesdetail';

  try {
    // ===== TENTAR VIA CLOUDFLARE WORKER =====
    if (CLOUDFLARE_WORKER_URL && SESSION_COOKIES) {
      console.log(`🔍 Buscando detalhes via Worker: ${type}/${id}...`);

      try {
        const response = await axios.post(
          `${CLOUDFLARE_WORKER_URL}/details-direct`,
          {
            id: id,
            type: type,
            cookies: SESSION_COOKIES
          },
          { timeout: 15000 }
        );

        const data = response.data;

        if (data.success && data.data) {
          console.log('✅ Detalhes obtidos via Worker');
          return data.data;
        }
      } catch (workerError) {
        console.log('⚠️ Worker falhou:', workerError.message);
      }
    }

    // ===== BUSCAR DIRETAMENTE (IP LOCAL) =====
    console.log(`🌐 Buscando detalhes diretamente (IP local): ${type}/${id}...`);
    await refreshSessionCookiesFromJar();
    await logCurrentCookies(`detalhes-${type}-${id}`);

    const response = await client.get(
      `${BASE_URL}/index.php`,
      {
        params: { page: pageType, id },
        headers: {
          'User-Agent': HEADERS['User-Agent'],
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.8,en-US;q=0.5,en;q=0.3',
          'Referer': `${BASE_URL}/?page=movies`
        },
        timeout: 30000,
        responseType: 'arraybuffer'
      }
    );

    let html = null;
    const encodings = ['ISO-8859-1', 'Windows-1252', 'UTF-8', 'latin1'];

    for (const encoding of encodings) {
      try {
        const decoded = iconv.decode(Buffer.from(response.data), encoding);
        if (!decoded.includes('â€') && !decoded.includes('?â€')) {
          html = decoded;
          console.log(`✅ Encoding correto: ${encoding}`);
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

    // Se não encontrou episódios e é série, tentar como filme
    if ($('.tab_episode').length === 0 && type !== 'movies') {
      const response2 = await client.get(
        `${BASE_URL}/index.php`,
        {
          params: { page: 'moviedetail', id },
          headers: {
            'User-Agent': HEADERS['User-Agent'],
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.8,en-US;q=0.5,en;q=0.3',
            'Referer': `${BASE_URL}/?page=series`
          },
          timeout: 30000,
          responseType: 'arraybuffer'
        }
      );

      html = null;
      for (const encoding of encodings) {
        try {
          const decoded = iconv.decode(Buffer.from(response2.data), encoding);
          if (!decoded.includes('â€') && !decoded.includes('?â€')) {
            html = decoded;
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (!html) {
        html = iconv.decode(Buffer.from(response2.data), 'ISO-8859-1');
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
        if (tagText) tags.push(tagText);
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

          console.log(`✅ [FILME] Duração: ${tag} = ${data.info.duracaoMinutos}min`);
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

// ===== ESTIMAR DURAÇÃO =====

async function estimarDuracao(mediaType, id, duracaoDoHTML = null) {
  try {
    if (mediaType === 'movie' && duracaoDoHTML && duracaoDoHTML > 0) {
      console.log(`✅ [FILME] Usando duração exata: ${duracaoDoHTML}min`);

      await AssetSize.findOneAndUpdate(
        { assetId: id, mediaType: 'movie' },
        { bytes: duracaoDoHTML * 60 * 1024 * 1024 * 15, updatedAt: new Date() },
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
      console.log(`✅ Duração do cache: ${duracaoFinal}min`);
      return duracaoFinal;
    }

    console.log(`🔍 Buscando tamanho via HEAD: ${id}...`);

    const base = mediaType === 'movie' ? MOVIE_BASE : VIDEO_BASE;
    const url = `${base}/${userSession.user}/${userSession.pass}/${id}.mp4`;

    try {
      const headResponse = await client.head(url, {
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

        console.log(`✅ Duração via HEAD: ${duracaoFinal}min`);
        return duracaoFinal;
      }
    } catch (headError) {
      console.log(`⚠️ HEAD falhou: ${headError.message}`);
    }

    const duracaoPadrao = mediaType === 'movie' ? 110 : 42;
    console.log(`⚠️ Usando duração padrão: ${duracaoPadrao}min`);
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
    timestamp: new Date().toISOString(),
    network: 'IP local direto',
    cacheSize: {
      movies: CACHE_CONTEUDO.movies.length,
      series: CACHE_CONTEUDO.series.length
    },
    session: SESSION_COOKIES ? 'Ativa' : 'Inativa'
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
                    "playbackRates": [0.5, 0.75, 1, 1.25, 1.5, 2]
                }'
            >
                <source src="${streamPath}" type="video/mp4">
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
            player = videojs('player');

            player.el().addEventListener('contextmenu', function(e) {
                e.preventDefault();
                return false;
            });

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

      await refreshSessionCookiesFromJar();
      await logCurrentCookies(`stream-${videoId}`);

      console.log(`🎬 Streaming: ${videoId} | User: ${userId}`);

      const response = await client.get(videoUrl, {
        method: 'GET',
        responseType: 'stream',
        headers: {
          Range: req.headers.range,
          'User-Agent': HEADERS['User-Agent'],
          Referer: `${BASE_URL}/index.php?page=homepage`,
          Accept: '*/*'
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
      if (error.response) {
        console.error('Status upstream:', error.response.status);
      }
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
      },
      network: 'IP local direto',
      session: SESSION_COOKIES ? 'Ativa' : 'Inativa'
    };

    res.json(stats);
  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    res.status(500).json({ error: 'Erro ao buscar estatísticas' });
  }
});

app.post('/api/admin/refresh-cache', adminAuth, async (req, res) => {
  try {
    console.log('🔄 Recarregando cache manualmente...');
    await atualizarCache();

    res.json({
      success: true,
      movies: CACHE_CONTEUDO.movies.length,
      series: CACHE_CONTEUDO.series.length,
      lastUpdated: CACHE_CONTEUDO.lastUpdated
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
        console.log(`✅ Créditos adicionados: User ${userId} | Valor: R$ ${(amount / 100).toFixed(2)}`);
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
    // ===== SESSÃO VIA .ENV (prioritário — evita login via Cloudflare) =====
    if (SESSION_COOKIES_ENV) {
      console.log('🍪 SESSION_COOKIES encontrado no .env — hidratando CookieJar e pulando login...');
      await hydrateJarFromCookieString(SESSION_COOKIES_ENV, BASE_URL);

      if (CF_CLEARANCE) {
        await jar.setCookie(`cf_clearance=${CF_CLEARANCE}; Path=/`, BASE_URL);
      }

      userSession.user = LOGIN_USER;
      userSession.pass = LOGIN_PASS;

      await refreshSessionCookiesFromJar();
      await logCurrentCookies('boot-env-session');

      console.log('✅ Sessão carregada do .env com sucesso!');
      await atualizarCache();
    } else if (LOGIN_USER && LOGIN_PASS) {
      // Fallback: tentar login normal (só funciona em IP residencial)
      console.log('🔐 SESSION_COOKIES não definido — tentando login automático...');
      const loginSucesso = await fazerLoginVouver(LOGIN_USER, LOGIN_PASS);

      if (!loginSucesso) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('⚠️ MODO DEGRADADO ATIVADO');
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━��');
        console.error('Login falhou e SESSION_COOKIES não definido.');
        console.error('Solução: rode capturar-cookies.js localmente');
        console.error('e cole SESSION_COOKIES=... no .env do servidor.');
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
      console.log('🚀 FastTV Server - IP Local Edition!');
      console.log('='.repeat(60));
      console.log(`📡 Servidor: ${DOMINIO_PUBLICO}`);
      console.log(`🔒 Streaming Progressivo: Ativo`);
      console.log(`🌐 Rede: IP local direto (sem proxy)`);
      console.log(`☁️ Worker: ${CLOUDFLARE_WORKER_URL ? 'Ativo (fallback)' : 'Inativo'}`);
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
      console.log('🔄 Atualização automática do cache (6h)...');
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