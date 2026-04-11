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
const { HttpProxyAgent } = require('http-proxy-agent');

// ===== IMPORTA BOT DO TELEGRAM =====
const telegramBot = require('./telegram-bot');

// ===== CONFIGURAÇÕES (TODAS DO .ENV) =====
const DOMINIO_PUBLICO    = process.env.DOMINIO_PUBLICO    || 'http://localhost:3000';
const JWT_SECRET         = process.env.JWT_SECRET;
const SIGNED_URL_SECRET  = process.env.SIGNED_URL_SECRET;
const PORT               = process.env.PORT               || 3000;
const MP_ACCESS_TOKEN    = process.env.MP_ACCESS_TOKEN;

// MongoDB
const MONGO_URI = process.env.MONGO_URI;

// Credenciais Vouver
const LOGIN_USER = process.env.LOGIN_USER;
const LOGIN_PASS = process.env.LOGIN_PASS;

// URLs Base
const BASE_URL   = process.env.BASE_URL   || 'http://vouver.me';
const VIDEO_BASE = process.env.VIDEO_BASE || 'http://goplay.icu/series';
const MOVIE_BASE = process.env.MOVIE_BASE || 'http://goplay.icu/movie';

// Cloudflare Worker
const CLOUDFLARE_WORKER_URL = process.env.CLOUDFLARE_WORKER_URL;

// Cloudflare clearance cookie (obter do browser logado)
const CF_CLEARANCE = process.env.CF_CLEARANCE || '';

// Sessão pré-autenticada (gerada localmente e colada no .env)
const SESSION_COOKIES_ENV = process.env.SESSION_COOKIES || '';

// Janela de validade da URL assinada (segundos)
const SIGNED_URL_TTL = parseInt(process.env.SIGNED_URL_TTL || '60', 10);

// Secret compartilhado entre Worker e VPS para o endpoint /relay-stream
// Gere com: openssl rand -hex 32
// Coloque no .env do VPS e no CF Secret (wrangler secret put RELAY_SECRET)
const RELAY_SECRET = process.env.RELAY_SECRET;

// ===== PROXY RESIDENCIAL =====
const RES_PROXY_ENABLED = String(process.env.RES_PROXY_ENABLED || 'false')
  .replace(/['"]/g, '').trim().toLowerCase() === 'true';

const RES_PROXY_HOST = (process.env.RES_PROXY_HOST || '').trim();
const RES_PROXY_PORT = parseInt(String(process.env.RES_PROXY_PORT || '0').trim(), 10);
const RES_PROXY_USER = process.env.RES_PROXY_USER || '';
const RES_PROXY_PASS = process.env.RES_PROXY_PASS || '';

let residentialProxyAgent = null;
if (RES_PROXY_ENABLED && RES_PROXY_HOST && RES_PROXY_PORT && RES_PROXY_USER && RES_PROXY_PASS) {
  const proxyUrl = `http://${encodeURIComponent(RES_PROXY_USER)}:${encodeURIComponent(RES_PROXY_PASS)}@${RES_PROXY_HOST}:${RES_PROXY_PORT}`;
  residentialProxyAgent = new HttpProxyAgent(proxyUrl);
  console.log(`🏠 Proxy residencial ativada: ${RES_PROXY_HOST}:${RES_PROXY_PORT}`);
} else {
  console.log('ℹ️ Proxy residencial inativa');
}

if (CLOUDFLARE_WORKER_URL) {
  console.log(`☁️ Cloudflare Worker configurado: ${CLOUDFLARE_WORKER_URL}`);
}

// ===== VALIDAÇÃO DE VARIÁVEIS OBRIGATÓRIAS =====
const requiredVars = { MONGO_URI, LOGIN_USER, LOGIN_PASS, JWT_SECRET, SIGNED_URL_SECRET, RELAY_SECRET };

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
console.log(`🔐 Signed URL TTL: ${SIGNED_URL_TTL}s`);
console.log(`🔒 Relay Secret: ${RELAY_SECRET ? 'Configurado' : '❌ AUSENTE'}`);

// ===== CONEXÃO MONGODB =====
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB conectado com sucesso!'))
  .catch(err => {
    console.error('❌ Erro ao conectar MongoDB:', err);
    process.exit(1);
  });

// ===== MODELS =====
const userSchema = new mongoose.Schema({
  userId:        { type: Number,  required: true, unique: true, index: true },
  firstName:     { type: String,  required: true },
  lastName:      { type: String },
  username:      { type: String },
  phoneNumber:   { type: String },
  credits:       { type: Number,  default: 0 },
  isActive:      { type: Boolean, default: true },
  isBlocked:     { type: Boolean, default: false },
  blockedReason: { type: String },
  registeredAt:  { type: Date,    default: Date.now },
  lastAccess:    { type: Date,    default: Date.now },
  totalSpent:    { type: Number,  default: 0 },
  totalPurchases:{ type: Number,  default: 0 },
  language:      { type: String,  default: 'pt-BR' },
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
  assetId:   { type: String, required: true, unique: true, index: true },
  mediaType: { type: String, enum: ['movie', 'series', 'series_ep'], required: true },
  bytes:     { type: Number, default: 0 },
  updatedAt: { type: Date,   default: Date.now, index: true }
});
assetSizeSchema.index({ assetId: 1, mediaType: 1 });
const AssetSize = mongoose.model('AssetSize', assetSizeSchema);

const purchasedContentSchema = new mongoose.Schema({
  userId:       { type: Number, required: true, index: true },
  videoId:      { type: String, required: true },
  mediaType:    { type: String, enum: ['movie', 'series'], required: true },
  title:        { type: String, required: true },
  episodeName:  { type: String },
  season:       { type: String },
  purchaseDate: { type: Date,   default: Date.now, index: true },
  expiresAt:    { type: Date,   required: true, index: true },
  token:        { type: String, required: true, unique: true },
  price:        { type: Number, required: true },
  viewed:       { type: Boolean, default: false },
  viewCount:    { type: Number,  default: 0 },
  notificationSent: { type: Boolean, default: false },
  sessionToken: { type: String, unique: true }
});
purchasedContentSchema.index({ userId: 1, expiresAt: 1 });
purchasedContentSchema.index({ expiresAt: 1, notificationSent: 1 });
const PurchasedContent = mongoose.model('PurchasedContent', purchasedContentSchema);

const rateLimitSchema = new mongoose.Schema({
  identifier: { type: String, required: true, unique: true, index: true },
  requests:   [{ timestamp: Date, videoId: String }],
  blocked:    { type: Boolean, default: false },
  blockedUntil: { type: Date }
});
const RateLimit = mongoose.model('RateLimit', rateLimitSchema);

// ===== EXPRESS + AXIOS =====
const app = express();
const jar = new CookieJar();

// client com cookie jar (NÃO usar com agent custom)
const client = wrapper(axios.create({ jar, withCredentials: true }));

// client sem jar (usar com proxy agent + Cookie manual)
const clientNoJar = axios.create({ withCredentials: false });

const HEADERS = {
  "User-Agent":        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language":   "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding":   "gzip, deflate, br",
  "Connection":        "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control":     "max-age=0",
  "Sec-Fetch-Dest":    "document",
  "Sec-Fetch-Mode":    "navigate",
  "Sec-Fetch-Site":    "none",
  "Sec-Fetch-User":    "?1"
};

app.use(express.json());
app.use(express.static('public'));
app.use('/covers', express.static(path.join(__dirname, 'public', 'covers')));

// ===== ESTADO GLOBAL =====
let userSession   = { user: '', pass: '' };
let CACHE_CONTEUDO = { movies: [], series: [], lastUpdated: 0 };
let SESSION_COOKIES = '';

// ===== HELPERS PROXY/HTTP =====
function shouldUseResidentialProxy(url) {
  try {
    const u    = new URL(url);
    const host = u.hostname.toLowerCase();
    return (
      host === 'vouver.me'     || host.endsWith('.vouver.me') ||
      host === 'goplay.icu'    || host.endsWith('.goplay.icu')
    );
  } catch {
    return false;
  }
}

function withOptionalResidentialProxy(axiosConfig = {}, url = '') {
  if (residentialProxyAgent && shouldUseResidentialProxy(url)) {
    return { ...axiosConfig, httpAgent: residentialProxyAgent, httpsAgent: residentialProxyAgent, proxy: false };
  }
  return axiosConfig;
}

function getHttpClientForUrl(url) {
  if (residentialProxyAgent && shouldUseResidentialProxy(url)) {
    return clientNoJar;
  }
  return client;
}

function buildCookieHeader() {
  let cookies = (SESSION_COOKIES || '').trim();
  if (CF_CLEARANCE && !cookies.includes('cf_clearance=')) {
    cookies = cookies ? `${cookies}; cf_clearance=${CF_CLEARANCE}` : `cf_clearance=${CF_CLEARANCE}`;
  }
  return cookies;
}

// ===== FUNÇÕES DE COOKIES =====
async function hydrateJarFromCookieString(cookieStr, baseUrl) {
  if (!cookieStr) return;
  const parts = cookieStr.split(';').map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name  = part.substring(0, idx).trim();
    const value = part.substring(idx + 1).trim();
    try {
      await jar.setCookie(`${name}=${value}; Path=/`, baseUrl);
      await jar.setCookie(`${name}=${value}; Path=/`, baseUrl.replace(/^http:\/\//i, 'https://'));
    } catch {
      console.log(`⚠️ Falha ao setar cookie no jar: ${name}`);
    }
  }
}

async function refreshSessionCookiesFromJar() {
  try {
    const cookiesHttp  = await jar.getCookies(BASE_URL);
    const cookiesHttps = await jar.getCookies(BASE_URL.replace(/^http:\/\//i, 'https://'));
    const merged = new Map();
    [...cookiesHttp, ...cookiesHttps].forEach(c => merged.set(c.key, c.value));
    SESSION_COOKIES = Array.from(merged.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
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
  } catch {
    console.log(`⚠️ [${context}] Não foi possível listar cookies`);
  }
}

// ===== FUNÇÕES DE SEGURANÇA =====
function generateStreamToken() {
  return crypto.randomBytes(64).toString('hex');
}

function encryptData(data, secret) {
  try {
    const iv  = crypto.randomBytes(16);
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
    if (parts.length !== 2) return null;
    const iv            = Buffer.from(parts[0], 'hex');
    const encryptedData = parts[1];
    const key           = crypto.createHash('sha256').update(secret).digest();
    const decipher      = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (error) {
    console.error('Erro ao decriptar dados:', error);
    return null;
  }
}

// ===== GERAR / VALIDAR URL ASSINADA =====
function gerarUrlAssinada(videoId, userId, mediaType) {
  const videoPath = `/stream/${videoId}.mp4`;
  const exp       = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL;

  const sigPayload = `${videoPath}:${exp}:${userId}`;
  const sig = crypto
    .createHmac('sha256', SIGNED_URL_SECRET)
    .update(sigPayload)
    .digest('hex');

  const base = CLOUDFLARE_WORKER_URL || 'https://stream.seudominio.com';
  return `${base}${videoPath}?sig=${sig}&exp=${exp}&uid=${userId}&type=${mediaType}`;
}

function validarUrlAssinada(videoId, sig, exp, userId) {
  try {
    const now = Math.floor(Date.now() / 1000);
    if (now > parseInt(exp, 10) + 5) return false;

    const videoPath  = `/stream/${videoId}.mp4`;
    const sigPayload = `${videoPath}:${exp}:${userId}`;
    const expected   = crypto
      .createHmac('sha256', SIGNED_URL_SECRET)
      .update(sigPayload)
      .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

// ===== MIDDLEWARE: Rate Limiting Avançado =====
async function advancedRateLimit(req, res, next) {
  const identifier = req.ip || req.connection.remoteAddress;
  const now = new Date();

  try {
    let limiter = await RateLimit.findOne({ identifier });
    if (!limiter) limiter = new RateLimit({ identifier, requests: [] });

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
      limiter.blocked      = true;
      limiter.blockedUntil = new Date(now.getTime() + 15 * 60 * 1000);
      await limiter.save();
      console.log(`🚫 IP bloqueado por excesso de requisições: ${identifier}`);
      return res.status(429).json({ error: 'Rate limit exceeded. Blocked for 15 minutes.', retryAfter: 900 });
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
  const isSuspicious = suspiciousAgents.some(a => userAgent.toLowerCase().includes(a));
  if (isSuspicious) {
    console.log(`⚠️ Cliente suspeito detectado: ${userAgent} | IP: ${req.ip}`);
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
}

// ===== MIDDLEWARE: CORS Restritivo =====
function strictCORS(req, res, next) {
  const origin         = req.headers.origin;
  const allowedOrigins = [DOMINIO_PUBLICO];
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Stream-Token, X-Encrypted-Data');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
}

// ===== FUNÇÃO AUXILIAR: EXTRAIR E MESCLAR COOKIES =====
function extrairCookies(setCookieHeader, cookiesArray = []) {
  const cookies = [...cookiesArray];
  (setCookieHeader || []).forEach(cookieStr => {
    const pair = cookieStr.split(';')[0];
    const idx  = pair.indexOf('=');
    if (idx > 0) {
      const name  = pair.substring(0, idx).trim();
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
    await jar.removeAllCookies();

    if (CF_CLEARANCE) {
      await jar.setCookie(`cf_clearance=${CF_CLEARANCE}; Path=/`, BASE_URL);
      await jar.setCookie(`cf_clearance=${CF_CLEARANCE}; Path=/`, BASE_URL.replace(/^http:\/\//i, 'https://'));
      console.log('🛡️ cf_clearance injetado no CookieJar');
    } else {
      console.log('⚠️ CF_CLEARANCE não definido no .env — pode falhar no WAF');
    }

    // GET login page
    const loginUrl    = `${BASE_URL}/index.php?page=login`;
    const loginClient = getHttpClientForUrl(loginUrl);
    const loginUseManualCookie = loginClient === clientNoJar;

    const loginPageResponse = await loginClient.get(
      loginUrl,
      withOptionalResidentialProxy({
        headers: {
          ...HEADERS,
          'Sec-Fetch-Site': 'none',
          ...(loginUseManualCookie ? { Cookie: buildCookieHeader() } : {})
        },
        timeout: 30000, maxRedirects: 5, validateStatus: s => s < 500
      }, loginUrl)
    );

    const htmlPage  = loginPageResponse.data || '';
    const csrfMatch =
      String(htmlPage).match(/name=["']csrf_token["']\s+value=["']([\w-]+)["']/i) ||
      String(htmlPage).match(/csrf_token["']\s+value=["']([a-f0-9-]+)["']/i) ||
      String(htmlPage).match(/name=["']csrf_token["'][^>]*value=["']([a-f0-9-]+)["']/i);
    const csrfToken = csrfMatch ? csrfMatch[1] : '';

    await logCurrentCookies('login-page');

    // POST form login
    const formData = new URLSearchParams({
      username, sifre: password, beni_hatirla: 'on',
      csrf_token: csrfToken, recaptcha_response: '', login: 'Acessar'
    });

    const loginPostUrl  = `${BASE_URL}/index.php?page=login`;
    const postClient    = getHttpClientForUrl(loginPostUrl);
    const postUseManualCookie = postClient === clientNoJar;

    await postClient.post(
      loginPostUrl, formData.toString(),
      withOptionalResidentialProxy({
        headers: {
          ...HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: BASE_URL, Referer: `${BASE_URL}/index.php?page=login`,
          'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-User': '?1', 'Sec-Fetch-Dest': 'document', 'Upgrade-Insecure-Requests': '1',
          ...(postUseManualCookie ? { Cookie: buildCookieHeader() } : {})
        },
        timeout: 30000, maxRedirects: 5, validateStatus: s => s < 500
      }, loginPostUrl)
    );

    // AJAX login
    const ajaxData = new URLSearchParams({ username, password, csrf_token: csrfToken, type: '1' });
    const ajaxUrl  = `${BASE_URL}/ajax/login.php`;
    const ajaxClient = getHttpClientForUrl(ajaxUrl);
    const ajaxUseManualCookie = ajaxClient === clientNoJar;

    await ajaxClient.post(
      ajaxUrl, ajaxData.toString(),
      withOptionalResidentialProxy({
        headers: {
          ...HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: BASE_URL, Referer: `${BASE_URL}/index.php?page=login`,
          'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
          ...(ajaxUseManualCookie ? { Cookie: buildCookieHeader() } : {})
        },
        timeout: 30000, maxRedirects: 5, validateStatus: s => s < 500
      }, ajaxUrl)
    );

    // GET homepage para verificar login
    const homepageUrl  = `${BASE_URL}/index.php?page=homepage`;
    const homeClient   = getHttpClientForUrl(homepageUrl);
    const homeUseManualCookie = homeClient === clientNoJar;

    const homepageResponse = await homeClient.get(
      homepageUrl,
      withOptionalResidentialProxy({
        headers: {
          ...HEADERS,
          Referer: `${BASE_URL}/index.php?page=login`,
          'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'navigate', 'Upgrade-Insecure-Requests': '1',
          ...(homeUseManualCookie ? { Cookie: buildCookieHeader() } : {})
        },
        timeout: 30000, maxRedirects: 5
      }, homepageUrl)
    );

    const homepageHtml = String(homepageResponse.data || '');
    if (homepageHtml.includes('Meu Perfil') || homepageHtml.includes('Sair') || homepageHtml.includes('sair')) {
      console.log('✅✅✅ LOGIN VERIFICADO COM SUCESSO!');
      userSession.user = username;
      userSession.pass = password;
      await refreshSessionCookiesFromJar();
      await logCurrentCookies('login-sucesso');
      console.log(`🍪 SESSION_COOKIES atualizado (${SESSION_COOKIES.length} chars)`);
      await atualizarCache();
      return true;
    }

    console.log('⚠️ Homepage não indica login bem-sucedido, tentando novamente...');
    return await fazerLoginVouver(username, password, tentativa + 1);

  } catch (error) {
    console.error(`❌ Erro na tentativa ${tentativa}:`, error.message);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      const body = typeof error.response.data === 'string'
        ? error.response.data.slice(0, 300)
        : JSON.stringify(error.response.data).slice(0, 300);
      console.error(`   Body: ${body}`);
    }
    if (tentativa < MAX_TENTATIVAS) {
      console.log('🔄 Tentando novamente...');
      return await fazerLoginVouver(username, password, tentativa + 1);
    }
    return false;
  }
}

// ===== FUNÇÃO: ATUALIZAR CACHE =====
async function atualizarCache() {
  console.log("🔄 Atualizando cache de conteúdo...");

  try {
    const contentPath = path.join(__dirname, 'content.json');

    // 1) arquivo local
    if (fs.existsSync(contentPath)) {
      console.log('📦 Carregando catálogo do arquivo content.json...');
      try {
        const fileContent = fs.readFileSync(contentPath, 'utf8');
        const cacheData   = JSON.parse(fileContent);
        let rawMovies = [], rawSeries = [];

        if (cacheData.data) {
          rawMovies = cacheData.data.movies || [];
          rawSeries = cacheData.data.series || [];
        } else if (cacheData.movies) {
          rawMovies = cacheData.movies;
          rawSeries = cacheData.series;
        }

        if (rawMovies.length > 0 || rawSeries.length > 0) {
          CACHE_CONTEUDO.movies      = rawMovies.sort((a, b) => a.name.localeCompare(b.name));
          CACHE_CONTEUDO.series      = rawSeries.sort((a, b) => a.name.localeCompare(b.name));
          CACHE_CONTEUDO.lastUpdated = Date.now();
          console.log(`✅ Cache carregado do arquivo JSON: ${CACHE_CONTEUDO.movies.length} filmes | ${CACHE_CONTEUDO.series.length} séries`);
          return;
        }
      } catch (jsonError) {
        console.error('❌ Erro ao ler content.json:', jsonError.message);
      }
    }

    // 2) worker
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
          if (data.data.data) { rawMovies = data.data.data.movies || []; rawSeries = data.data.data.series || []; }
          else if (data.data.movies) { rawMovies = data.data.movies; rawSeries = data.data.series; }

          if (rawMovies.length > 0 || rawSeries.length > 0) {
            CACHE_CONTEUDO.movies      = rawMovies.sort((a, b) => a.name.localeCompare(b.name));
            CACHE_CONTEUDO.series      = rawSeries.sort((a, b) => a.name.localeCompare(b.name));
            CACHE_CONTEUDO.lastUpdated = Date.now();
            console.log(`✅ Cache obtido via Worker: ${CACHE_CONTEUDO.movies.length} filmes | ${CACHE_CONTEUDO.series.length} séries`);

            try {
              fs.writeFileSync(contentPath, JSON.stringify({
                status: true, error: null,
                data: { movies: rawMovies, series: rawSeries },
                lastUpdated: new Date().toISOString()
              }, null, 2), 'utf8');
              console.log('💾 Cache salvo em content.json');
            } catch { console.log('⚠️ Não foi possível salvar content.json'); }
            return;
          }
        }
      } catch (workerError) {
        console.log('⚠️ Worker falhou:', workerError.message);
      }
    }

    // 3) direto
    if (SESSION_COOKIES) {
      console.log('🌐 Buscando cache diretamente...');
      try {
        await refreshSessionCookiesFromJar();
        const searchUrl  = `${BASE_URL}/app/_search.php?q=a`;
        const httpClient = getHttpClientForUrl(searchUrl);
        const manualCookie = httpClient === clientNoJar;

        const cacheResponse = await httpClient.get(
          searchUrl,
          withOptionalResidentialProxy({
            headers: {
              'User-Agent': HEADERS['User-Agent'],
              'Accept': 'application/json, text/plain, */*',
              'Referer': `${BASE_URL}/index.php?page=homepage`,
              ...(manualCookie ? { Cookie: buildCookieHeader() } : {})
            },
            timeout: 30000, validateStatus: s => s < 500
          }, searchUrl)
        );

        const cacheData = cacheResponse.data;
        let rawMovies = [], rawSeries = [];
        if (cacheData.data) { rawMovies = cacheData.data.movies || []; rawSeries = cacheData.data.series || []; }
        else if (cacheData.movies) { rawMovies = cacheData.movies; rawSeries = cacheData.series; }

        if (rawMovies.length > 0 || rawSeries.length > 0) {
          CACHE_CONTEUDO.movies      = rawMovies.sort((a, b) => a.name.localeCompare(b.name));
          CACHE_CONTEUDO.series      = rawSeries.sort((a, b) => a.name.localeCompare(b.name));
          CACHE_CONTEUDO.lastUpdated = Date.now();
          console.log(`✅ Cache obtido diretamente: ${CACHE_CONTEUDO.movies.length} filmes | ${CACHE_CONTEUDO.series.length} séries`);

          try {
            fs.writeFileSync(contentPath, JSON.stringify({
              status: true, error: null,
              data: { movies: rawMovies, series: rawSeries },
              lastUpdated: new Date().toISOString()
            }, null, 2), 'utf8');
            console.log('💾 Cache salvo em content.json');
          } catch { console.log('⚠️ Não foi possível salvar content.json'); }
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
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const correcoes = {
    'Ã§': 'ç', 'Ã©': 'é', 'Ã¡': 'á', 'Ã£': 'ã', 'Ãµ': 'õ', 'Ã­': 'í',
    'Ã³': 'ó', 'Ãº': 'ú', 'Ã¢': 'â', 'Ãª': 'ê', 'Ã´': 'ô', 'Ã ': 'à',
    'a??o': 'ação', 'A??o': 'Ação', 'fic??o': 'ficção', 'miss?o': 'missão', 'cora??o': 'coração'
  };
  for (const [errado, certo] of Object.entries(correcoes)) {
    texto = texto.split(errado).join(certo);
  }
  return texto;
}

// ===== BUSCAR DETALHES =====
async function buscarDetalhes(id, type) {
  const pageType = type === 'movies' ? 'moviedetail' : 'seriesdetail';

  const isBlockedPage = (html = '') => {
    const t = String(html).toLowerCase();
    return (
      t.includes('you are unable to access') || t.includes('attention required') ||
      t.includes('cf-browser-verification') ||
      (t.includes('cloudflare') && t.includes('ray id')) || t.includes('access denied')
    );
  };

  const decodeHtml = (buffer) => {
    let html = null;
    for (const encoding of ['ISO-8859-1', 'Windows-1252', 'UTF-8', 'latin1']) {
      try {
        const decoded = iconv.decode(Buffer.from(buffer), encoding);
        if (!decoded.includes('â€') && !decoded.includes('?â€')) { html = decoded; break; }
      } catch {}
    }
    if (!html) {
      html = iconv.decode(Buffer.from(buffer), 'ISO-8859-1');
      html = corrigirCaracteresEspeciais(html);
    }
    return html;
  };

  const fetchDetailHtml = async (detailPage, contentId, refererPage = 'movies') => {
    const attempts = [
      { url: `${BASE_URL}/index.php`, config: { params: { page: detailPage, id: contentId } } },
      { url: `${BASE_URL}/`,          config: { params: { page: detailPage, id: contentId } } }
    ];
    for (const attempt of attempts) {
      try {
        const httpClient    = getHttpClientForUrl(attempt.url);
        const manualCookie  = httpClient === clientNoJar;
        const resp = await httpClient.get(
          attempt.url,
          withOptionalResidentialProxy({
            ...attempt.config,
            headers: {
              'User-Agent': HEADERS['User-Agent'],
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'pt-BR,pt;q=0.8,en-US;q=0.5,en;q=0.3',
              'Referer': `${BASE_URL}/?page=${refererPage}`,
              ...(manualCookie ? { Cookie: buildCookieHeader() } : {})
            },
            timeout: 30000, responseType: 'arraybuffer', validateStatus: s => s < 500
          }, attempt.url)
        );
        const html = decodeHtml(resp.data);
        if (isBlockedPage(html)) {
          console.log(`⚠️ Página bloqueada detectada em ${attempt.url}, tentando fallback...`);
          continue;
        }
        return html;
      } catch (e) {
        console.log(`⚠️ Falha ao buscar ${detailPage}/${contentId}: ${e.message}`);
      }
    }
    return null;
  };

  try {
    // 1) Worker
    if (CLOUDFLARE_WORKER_URL && SESSION_COOKIES) {
      console.log(`🔍 Buscando detalhes via Worker: ${type}/${id}...`);
      try {
        const response = await axios.post(
          `${CLOUDFLARE_WORKER_URL}/details-direct`,
          { id, type, cookies: SESSION_COOKIES },
          { timeout: 15000 }
        );
        const data = response.data;
        if (data.success && data.data) {
          const d      = data.data;
          const titulo = String(d.title || '').toLowerCase();
          const sinopse= String(d.info?.sinopse || '').toLowerCase();
          const bloqueado = titulo.includes('you are unable to access') || titulo.includes('cloudflare') || sinopse.includes('cloudflare');
          const invalido  = !d.title || d.title.length < 2 || (!d.seasons && !d.info);
          if (!bloqueado && !invalido) {
            console.log('✅ Detalhes obtidos via Worker');
            return d;
          }
          console.log('⚠️ Worker retornou conteúdo inválido/bloqueio, tentando direto...');
        }
      } catch (workerError) {
        console.log('⚠️ Worker falhou:', workerError.message);
      }
    }

    // 2) Direto
    console.log(`🌐 Buscando detalhes diretamente: ${type}/${id}...`);
    await refreshSessionCookiesFromJar();
    await logCurrentCookies(`detalhes-${type}-${id}`);

    let html = await fetchDetailHtml(pageType, id, type === 'movies' ? 'movies' : 'series');
    if (!html) { console.error(`❌ Não foi possível obter HTML de detalhes (${type}/${id})`); return null; }

    let $ = cheerio.load(html, { decodeEntities: false });

    if ($('.tab_episode').length === 0 && type !== 'movies') {
      const html2 = await fetchDetailHtml('moviedetail', id, 'series');
      if (html2) $ = cheerio.load(html2, { decodeEntities: false });
    }

    const data = { seasons: {}, info: {} };
    data.title        = limparTexto($('.left-wrap h2').first().text());
    data.info.sinopse = limparTexto($('.left-wrap p').first().text());
    data.mediaType    = $('.tab_episode').length > 0 ? 'series' : 'movie';

    if (data.mediaType === 'movie') {
      const tags = [];
      $('.left-wrap .tag').each((i, el) => { const t = limparTexto($(el).text()); if (t) tags.push(t); });
      const imdbText  = limparTexto($('.left-wrap .rnd').first().text());
      const imdbMatch = imdbText.match(/IMDB\s+([\d.]+)/i);
      if (imdbMatch) data.info.imdb = parseFloat(imdbMatch[1]);

      for (const tag of tags) {
        if (/^\d{4}$/.test(tag)) data.info.ano = parseInt(tag, 10);
        const duracaoMatch = tag.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
        if (duracaoMatch) {
          const horas   = parseInt(duracaoMatch[1], 10);
          const minutos = parseInt(duracaoMatch[2], 10);
          const segundos= parseInt(duracaoMatch[3], 10);
          data.info.duracaoMinutos = (horas * 60) + minutos + Math.ceil(segundos / 60);
          data.info.duracaoTexto   = tag;
          console.log(`✅ [FILME] Duração: ${tag} = ${data.info.duracaoMinutos}min`);
        }
        if (!tag.includes(':') && isNaN(tag) && !/^\d{4}$/.test(tag)) {
          if (!data.info.genero) data.info.genero = tag;
        }
      }
    }

    if (data.mediaType === 'series') {
      $('.tab_episode').each((i, el) => {
        const seasonNum = i + 1;
        const episodes  = [];
        $(el).find('a.ep-list-min').each((j, link) => {
          const epId   = $(link).attr('data-id');
          const epName = limparTexto($(link).find('.ep-title').text());
          if (epId && epName) episodes.push({ name: epName, id: epId });
        });
        if (episodes.length > 0) data.seasons[seasonNum] = episodes;
      });
    } else {
      data.seasons["Filme"] = [{ name: data.title || "Filme Completo", id }];
    }

    if (!data.title || data.title.length < 2) {
      console.log('⚠️ HTML retornado sem título válido (possível bloqueio/sessão inválida)');
      return null;
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

    const cached = await AssetSize.findOne({ assetId: id, mediaType: mediaType === 'movie' ? 'movie' : 'series_ep' });
    if (cached && cached.bytes > 0) {
      const minutos = Math.round(cached.bytes / (1024 * 1024 * 15));
      const duracaoFinal = Math.max(minutos, mediaType === 'movie' ? 90 : 20);
      console.log(`✅ Duração do cache: ${duracaoFinal}min`);
      return duracaoFinal;
    }

    console.log(`🔍 Buscando tamanho via HEAD: ${id}...`);
    const base      = mediaType === 'movie' ? MOVIE_BASE : VIDEO_BASE;
    const url       = `${base}/${userSession.user}/${userSession.pass}/${id}.mp4`;
    const httpClient = getHttpClientForUrl(url);
    const manualCookie = httpClient === clientNoJar;

    // HEAD
    try {
      const headResponse = await httpClient.head(
        url,
        withOptionalResidentialProxy({
          headers: { 'User-Agent': HEADERS['User-Agent'], 'Referer': BASE_URL, 'Accept': '*/*', ...(manualCookie ? { Cookie: buildCookieHeader() } : {}) },
          timeout: 10000, maxRedirects: 5, validateStatus: s => s < 500
        }, url)
      );
      let contentLength = parseInt(headResponse.headers['content-length'] || '0', 10);
      if (contentLength > 0) {
        const minutos = Math.round(contentLength / (1024 * 1024 * 15));
        const duracaoFinal = Math.max(minutos, mediaType === 'movie' ? 90 : 20);
        await AssetSize.findOneAndUpdate(
          { assetId: id, mediaType: mediaType === 'movie' ? 'movie' : 'series_ep' },
          { bytes: contentLength, updatedAt: new Date() }, { upsert: true, new: true }
        );
        console.log(`✅ Duração via HEAD: ${duracaoFinal}min`);
        return duracaoFinal;
      }
      throw new Error('HEAD sem content-length');
    } catch (headError) {
      console.log(`⚠️ HEAD falhou (${headError.message}), tentando GET Range...`);
    }

    // GET Range fallback
    try {
      const rangeResponse = await httpClient.get(
        url,
        withOptionalResidentialProxy({
          headers: { 'User-Agent': HEADERS['User-Agent'], 'Referer': BASE_URL, 'Accept': '*/*', 'Range': 'bytes=0-0', ...(manualCookie ? { Cookie: buildCookieHeader() } : {}) },
          timeout: 12000, maxRedirects: 5, responseType: 'stream', validateStatus: s => s < 500
        }, url)
      );
      if (rangeResponse.data && typeof rangeResponse.data.destroy === 'function') rangeResponse.data.destroy();
      let totalBytes = 0;
      const cr = rangeResponse.headers['content-range'];
      if (cr) { const m = String(cr).match(/\/(\d+)$/); if (m) totalBytes = parseInt(m[1], 10); }
      if (!totalBytes) totalBytes = parseInt(rangeResponse.headers['content-length'] || '0', 10);
      if (totalBytes > 0) {
        const minutos = Math.round(totalBytes / (1024 * 1024 * 15));
        const duracaoFinal = Math.max(minutos, mediaType === 'movie' ? 90 : 20);
        await AssetSize.findOneAndUpdate(
          { assetId: id, mediaType: mediaType === 'movie' ? 'movie' : 'series_ep' },
          { bytes: totalBytes, updatedAt: new Date() }, { upsert: true, new: true }
        );
        console.log(`✅ Duração via GET Range: ${duracaoFinal}min`);
        return duracaoFinal;
      }
    } catch (rangeErr) {
      console.log(`⚠️ GET Range falhou: ${rangeErr.message}`);
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
    network: residentialProxyAgent ? 'Proxy residencial ativa' : 'IP direto',
    streaming: 'Worker → VPS relay → proxy residencial → goplay.icu',
    signedUrlTTL: `${SIGNED_URL_TTL}s`,
    cacheSize: { movies: CACHE_CONTEUDO.movies.length, series: CACHE_CONTEUDO.series.length },
    session: SESSION_COOKIES ? 'Ativa' : 'Inativa',
    relaySecret: RELAY_SECRET ? 'Configurado' : '❌ AUSENTE'
  });
});

// ===== ENDPOINTS WEB =====

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ status: 'error', message: 'Usuário e senha são obrigatórios' });
    const success = await fazerLoginVouver(username, password);
    res.json({ status: success ? 'success' : 'error', message: success ? 'Login realizado com sucesso' : 'Falha no login' });
  } catch (error) {
    console.error('Erro no endpoint /api/login:', error);
    res.json({ status: 'error', message: 'Erro ao fazer login' });
  }
});

app.get('/api/list', async (req, res) => {
  try {
    const { type = 'movies', page = 1, q } = req.query;
    const pageNum = parseInt(page, 10) || 1;
    const limit   = 20;

    if (CACHE_CONTEUDO.series.length === 0) await atualizarCache();

    const isAdulto = n => /[\[\(]xxx|\+18|adulto|hentai/i.test(String(n).toUpperCase());

    let lista;
    if (type === 'adult') {
      lista = [...CACHE_CONTEUDO.movies, ...CACHE_CONTEUDO.series].filter(i => isAdulto(i.name));
    } else {
      lista = (CACHE_CONTEUDO[type] || []).filter(i => !isAdulto(i.name));
    }

    if (q) lista = lista.filter(i => i.name.toLowerCase().includes(String(q).toLowerCase()));

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

    res.json({ data, currentPage: pageNum, totalPages: Math.ceil(total / limit), totalItems: total });
  } catch (error) {
    console.error('Erro no endpoint /api/list:', error);
    res.status(500).json({ error: 'Erro ao listar conteúdo' });
  }
});

app.get('/api/details', async (req, res) => {
  try {
    const { id, type } = req.query;
    if (!id || !type) return res.status(400).json({ error: 'ID e tipo são obrigatórios' });
    const detalhes = await buscarDetalhes(id, type);
    if (!detalhes) return res.status(404).json({ error: 'Conteúdo não encontrado' });
    res.json(detalhes);
  } catch (error) {
    console.error('Erro no endpoint /api/details:', error);
    res.status(500).json({ error: 'Erro ao buscar detalhes' });
  }
});

// ===== ENDPOINT: Player com Video.js =====
app.get('/player/:token', async (req, res) => {
  try {
    const decoded  = jwt.verify(req.params.token, JWT_SECRET);
    const { videoId, mediaType, userId } = decoded;

    const purchase = await PurchasedContent.findOne({ token: req.params.token });
    if (!purchase)                   throw new Error('Conteúdo não encontrado');
    if (new Date() > purchase.expiresAt) throw new Error('Link expirado');

    const user = await User.findOne({ userId });
    if (!user || user.isBlocked)     throw new Error('Usuário bloqueado');

    purchase.viewed    = true;
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
      display: flex; flex-direction: column; justify-content: center; align-items: center;
      min-height: 100vh; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #fff; user-select: none;
    }
    .container { width: 100%; max-width: 1400px; padding: 20px; position: relative; }
    .logo { color: #E50914; font-size: 36px; font-weight: bold; text-align: center; margin-bottom: 30px; text-shadow: 0 0 20px rgba(229,9,20,0.5); }
    .video-wrapper { position: relative; width: 100%; background: #000; border-radius: 12px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.8); }
    .video-js { width: 100%; height: 80vh; font-family: 'Segoe UI', Arial, sans-serif; }
    .vjs-theme-fasttv .vjs-control-bar { background: linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.7) 50%, transparent 100%); height: 4em; }
    .vjs-theme-fasttv .vjs-big-play-button { background: rgba(229,9,20,0.9); border: none; border-radius: 50%; width: 2em; height: 2em; line-height: 2em; font-size: 3em; left: 50%; top: 50%; transform: translate(-50%,-50%); transition: all 0.3s; }
    .vjs-theme-fasttv .vjs-big-play-button:hover { background: rgba(229,9,20,1); transform: translate(-50%,-50%) scale(1.1); }
    .vjs-theme-fasttv .vjs-play-progress, .vjs-theme-fasttv .vjs-volume-level { background-color: #E50914; }
    .info-bar { background: rgba(20,20,20,0.95); backdrop-filter: blur(10px); padding: 20px; border-radius: 12px; margin-top: 20px; border: 1px solid rgba(255,255,255,0.1); }
    .title { font-size: 24px; font-weight: bold; margin-bottom: 10px; color: #fff; }
    .meta { display: flex; gap: 20px; flex-wrap: wrap; font-size: 14px; color: #aaa; margin-bottom: 15px; }
    .meta span { display: flex; align-items: center; gap: 8px; }
    .warning { text-align: center; margin-top: 20px; padding: 15px; background: rgba(229,9,20,0.1); border-radius: 8px; font-size: 14px; border: 1px solid rgba(229,9,20,0.3); }
    .timer { display: inline-block; background: rgba(229,9,20,0.2); padding: 5px 12px; border-radius: 20px; font-weight: bold; }
    @media (max-width: 768px) { .video-js { height: 50vh; } }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">FAST<span style="color:#fff">TV</span></div>
    <div class="video-wrapper">
      <video id="player" class="video-js vjs-theme-fasttv vjs-big-play-centered" controls preload="auto"
        data-setup='{"fluid":true,"aspectRatio":"16:9","playbackRates":[0.5,0.75,1,1.25,1.5,2]}'>
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
      Este link é pessoal e intransferível • Protegido por assinatura HMAC • ID: ${userId}
    </div>
  </div>
  <script src="https://vjs.zencdn.net/8.10.0/video.min.js"></script>
  <script>
    const expiresAt = new Date('${purchase.expiresAt.toISOString()}');
    let player;

    document.addEventListener('DOMContentLoaded', function() {
      player = videojs('player');
      player.el().addEventListener('contextmenu', e => { e.preventDefault(); return false; });

      player.ready(function() { player.load(); });

      let playLogged = false;
      player.on('play', function() {
        if (!playLogged) {
          fetch('/api/log-view', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: ${userId}, videoId: '${videoId}', token: '${req.params.token}', timestamp: Date.now() })
          });
          playLogged = true;
        }
      });

      player.on('error', function() {
        const err = player.error();
        if (err && (err.code === 2 || err.code === 4)) {
          console.log('⚠️ Erro no stream, recarregando link...');
          fetch('/api/refresh-stream/${req.params.token}/${purchase.sessionToken}')
            .then(r => r.json())
            .then(d => { if (d.url) { player.src({ src: d.url, type: 'video/mp4' }); player.play(); } })
            .catch(() => {});
        }
      });
    });

    function updateCountdown() {
      const now  = new Date();
      const diff = expiresAt - now;
      if (diff <= 0) {
        document.getElementById('countdown').innerText = 'EXPIRADO';
        if (player) { player.pause(); player.dispose(); }
        return;
      }
      const hours   = Math.floor(diff / (1000*60*60));
      const minutes = Math.floor((diff % (1000*60*60)) / (1000*60));
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
  <meta charset="UTF-8"><title>Acesso Negado - FastTV</title>
  <style>body{background:#0a0a0a;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;font-family:Arial,sans-serif;text-align:center}.error{max-width:600px;padding:40px}h1{color:#E50914;margin-bottom:20px}</style>
</head>
<body><div class="error"><h1>⚠️ Acesso Negado</h1><p>Link inválido, expirado ou usuário bloqueado.</p></div></body>
</html>`);
  }
});

// ===== ENDPOINT: Signed URL → Worker =====
app.get('/api/stream-secure/:token/:sessionToken',
  detectSuspiciousClient,
  advancedRateLimit,
  async (req, res) => {
    try {
      const contentToken = req.params.token;
      const sessionToken = req.params.sessionToken;

      const decoded = jwt.verify(contentToken, JWT_SECRET);
      const { videoId, mediaType, userId } = decoded;

      const purchase = await PurchasedContent.findOne({ token: contentToken, sessionToken });
      if (!purchase || new Date() > purchase.expiresAt) {
        console.log('⚠️ Conteúdo expirado ou não encontrado');
        return res.sendStatus(403);
      }

      const user = await User.findOne({ userId });
      if (!user || user.isBlocked) {
        console.log('⚠️ Usuário bloqueado');
        return res.sendStatus(403);
      }

      const signedUrl = gerarUrlAssinada(videoId, userId, mediaType);

      console.log(`🔀 Signed URL gerada: User ${userId} | Vídeo ${videoId} | TTL ${SIGNED_URL_TTL}s`);

      res.setHeader('Cache-Control', 'no-store, no-cache, private, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      res.redirect(302, signedUrl);

    } catch (error) {
      console.error('Erro no stream redirect:', error.message);
      res.sendStatus(403);
    }
  }
);

// ===== ENDPOINT: Refresh do link de stream =====
app.get('/api/refresh-stream/:token/:sessionToken',
  detectSuspiciousClient,
  async (req, res) => {
    try {
      const contentToken = req.params.token;
      const sessionToken = req.params.sessionToken;

      const decoded = jwt.verify(contentToken, JWT_SECRET);
      const { videoId, mediaType, userId } = decoded;

      const purchase = await PurchasedContent.findOne({ token: contentToken, sessionToken });
      if (!purchase || new Date() > purchase.expiresAt) return res.status(403).json({ error: 'Expirado' });

      const user = await User.findOne({ userId });
      if (!user || user.isBlocked) return res.status(403).json({ error: 'Bloqueado' });

      const signedUrl = gerarUrlAssinada(videoId, userId, mediaType);

      console.log(`🔄 Refresh de stream: User ${userId} | Vídeo ${videoId}`);
      res.json({ url: signedUrl });

    } catch (error) {
      console.error('Erro no refresh-stream:', error.message);
      res.status(403).json({ error: 'Inválido' });
    }
  }
);

// ===== ENDPOINT: RELAY STREAM =====
// Chamado exclusivamente pelo Cloudflare Worker (autenticado via RELAY_SECRET).
// Faz pipe do vídeo usando a proxy residencial — IP nunca é da Cloudflare.
// O usuário nunca acessa esta rota diretamente; ela não aparece no browser.
app.get('/relay-stream', async (req, res) => {
  try {
    // 1) Valida o secret compartilhado com o Worker
    const secret = req.query.relay_secret;
    if (!secret || secret !== RELAY_SECRET) {
      console.warn(`⚠️ /relay-stream: secret inválido | IP: ${req.ip}`);
      return res.status(403).send('Forbidden');
    }

    // 2) Valida e sanitiza a URL de destino
    const targetUrl = req.query.target;
    if (!targetUrl) {
      return res.status(400).send('Missing target');
    }

    // Aceita apenas URLs do goplay.icu para evitar SSRF
    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      return res.status(400).send('Invalid target URL');
    }

    const allowedHosts = ['goplay.icu'];
    if (!allowedHosts.some(h => parsedTarget.hostname === h || parsedTarget.hostname.endsWith('.' + h))) {
      console.warn(`⚠️ /relay-stream: host não permitido: ${parsedTarget.hostname}`);
      return res.status(403).send('Host not allowed');
    }

    // 3) Monta headers para o goplay.icu
    const upstreamHeaders = {
      'User-Agent':      HEADERS['User-Agent'],
      'Referer':         'http://vouver.me/',
      'Origin':          'http://vouver.me',
      'Accept':          '*/*',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'Connection':      'keep-alive',
    };

    // Repassa Range se vier do Worker (para seek funcionar no player)
    const rangeParam = req.query.range || req.headers['range'];
    if (rangeParam) {
      upstreamHeaders['Range'] = rangeParam;
    }

    console.log(`📡 Relay → ${parsedTarget.hostname}${parsedTarget.pathname} | Proxy: ${residentialProxyAgent ? 'residencial' : 'direto'}`);

    // 4) Faz o request usando a proxy residencial
    const upstream = await axios({
      method:       'get',
      url:          targetUrl,
      headers:      upstreamHeaders,
      responseType: 'stream',
      // Usa a proxy residencial se configurada — este é o ponto chave
      ...(residentialProxyAgent ? {
        httpAgent:  residentialProxyAgent,
        httpsAgent: residentialProxyAgent,
        proxy:      false
      } : {}),
      timeout: 30000,
      validateStatus: s => s < 500,
    });

    console.log(`✅ Relay upstream status: ${upstream.status}`);

    // 5) Repassa headers relevantes para o Worker/cliente
    const headersToForward = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    headersToForward.forEach(h => {
      if (upstream.headers[h]) res.set(h, upstream.headers[h]);
    });

    res.set('Cache-Control', 'no-store, private');
    res.set('X-Content-Type-Options', 'nosniff');
    res.status(upstream.status);

    // 6) Pipe do stream diretamente para o Worker
    upstream.data.pipe(res);

    // Lida com erros durante o pipe
    upstream.data.on('error', (err) => {
      console.error('❌ Relay pipe error:', err.message);
      if (!res.headersSent) res.status(502).send('Stream error');
    });

    req.on('close', () => {
      // Cliente desconectou — destrói o stream upstream para não desperdiçar banda
      if (upstream.data && typeof upstream.data.destroy === 'function') {
        upstream.data.destroy();
      }
    });

  } catch (error) {
    console.error('❌ Erro no /relay-stream:', error.message);
    if (!res.headersSent) res.status(502).send('Stream error');
  }
});

app.post('/api/log-view', async (req, res) => {
  try {
    const { userId, videoId } = req.body;
    console.log(`📊 Play: User ${userId} | Vídeo ${videoId}`);
    res.sendStatus(200);
  } catch { res.sendStatus(500); }
});

// ===== API ADMINISTRATIVA =====
function adminAuth(req, res, next) {
  const authToken  = req.headers['authorization'];
  const validToken = process.env.ADMIN_API_TOKEN || 'seu-token-super-secreto';
  if (authToken !== `Bearer ${validToken}`) return res.status(401).json({ error: 'Não autorizado' });
  next();
}

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const stats = {
      users: {
        total:   await User.countDocuments(),
        active:  await User.countDocuments({ isActive: true, isBlocked: false }),
        blocked: await User.countDocuments({ isBlocked: true })
      },
      purchases: {
        total:   (await User.aggregate([{ $group: { _id: null, total: { $sum: '$totalPurchases' } } }]))[0]?.total || 0,
        revenue: (await User.aggregate([{ $group: { _id: null, total: { $sum: '$totalSpent' } } }]))[0]?.total || 0
      },
      content: {
        active:  await PurchasedContent.countDocuments({ expiresAt: { $gt: new Date() } }),
        expired: await PurchasedContent.countDocuments({ expiresAt: { $lte: new Date() } })
      },
      catalog: { movies: CACHE_CONTEUDO.movies.length, series: CACHE_CONTEUDO.series.length },
      network:  residentialProxyAgent ? 'Proxy residencial ativa (scraping + relay)' : 'IP direto',
      streaming: `Worker → VPS relay → proxy residencial → goplay.icu`,
      session:   SESSION_COOKIES ? 'Ativa' : 'Inativa'
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
    res.json({ success: true, movies: CACHE_CONTEUDO.movies.length, series: CACHE_CONTEUDO.series.length, lastUpdated: CACHE_CONTEUDO.lastUpdated });
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
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` }, timeout: 10000 }
    );
    const payment = response.data;

    if (payment.status === 'approved') {
      const userId = parseInt(payment.external_reference, 10);
      const amount = Math.round(payment.transaction_amount * 100);
      if (!userId || !amount) return res.sendStatus(200);
      const sucesso = await telegramBot.processarPagamentoAprovado(paymentId, userId, amount);
      if (sucesso) console.log(`✅ Créditos adicionados: User ${userId} | Valor: R$ ${(amount / 100).toFixed(2)}`);
    }
  } catch (error) {
    console.error('❌ Erro ao processar webhook:', error.message);
  }
  res.sendStatus(200);
});

// ===== LIMPEZA AUTOMÁTICA =====
setInterval(async () => {
  try {
    const result = await RateLimit.deleteMany({ blocked: false, 'requests.0': { $exists: false } });
    if (result.deletedCount > 0) console.log(`🧹 Removidos ${result.deletedCount} rate limiters inativos`);
  } catch (error) { console.error('Erro ao limpar rate limiters:', error); }
}, 60 * 60 * 1000);

setInterval(async () => {
  try {
    const resultado = await PurchasedContent.deleteMany({ expiresAt: { $lt: new Date() } });
    if (resultado.deletedCount > 0) console.log(`🧹 Removidos ${resultado.deletedCount} conteúdos expirados`);
  } catch (error) { console.error('Erro ao limpar conteúdos expirados:', error); }
}, 60 * 60 * 1000);

// ===== INICIALIZAÇÃO =====
async function iniciarServidor() {
  try {
    if (SESSION_COOKIES_ENV) {
      console.log('🍪 SESSION_COOKIES encontrado no .env — hidratando CookieJar e pulando login...');
      await hydrateJarFromCookieString(SESSION_COOKIES_ENV, BASE_URL);

      if (CF_CLEARANCE) {
        await jar.setCookie(`cf_clearance=${CF_CLEARANCE}; Path=/`, BASE_URL);
        await jar.setCookie(`cf_clearance=${CF_CLEARANCE}; Path=/`, BASE_URL.replace(/^http:\/\//i, 'https://'));
      }

      userSession.user = LOGIN_USER;
      userSession.pass = LOGIN_PASS;
      await refreshSessionCookiesFromJar();
      await logCurrentCookies('boot-env-session');
      console.log('✅ Sessão carregada do .env com sucesso!');
      await atualizarCache();

    } else if (LOGIN_USER && LOGIN_PASS) {
      console.log('🔐 SESSION_COOKIES não definido — tentando login automático...');
      const loginSucesso = await fazerLoginVouver(LOGIN_USER, LOGIN_PASS);

      if (!loginSucesso) {
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('⚠️ MODO DEGRADADO ATIVADO');
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        userSession.user = LOGIN_USER;
        userSession.pass = LOGIN_PASS;
      }
    }

    telegramBot.initBot(
      { User, AssetSize, PurchasedContent },
      { buscarDetalhes, estimarDuracao, atualizarCache, CACHE_CONTEUDO },
      DOMINIO_PUBLICO
    );

    app.listen(PORT, () => {
      console.log('\n' + '='.repeat(60));
      console.log('🚀 FastTV Server — Relay Edition');
      console.log('='.repeat(60));
      console.log(`📡 Servidor:      ${DOMINIO_PUBLICO}`);
      console.log(`🔀 Streaming:     Worker → VPS /relay-stream → proxy → goplay.icu`);
      console.log(`🔐 Assinatura:    HMAC-SHA256 / TTL ${SIGNED_URL_TTL}s`);
      console.log(`🌐 Rede scraping: ${residentialProxyAgent ? 'Proxy residencial' : 'IP direto'}`);
      console.log(`🌐 Rede relay:    ${residentialProxyAgent ? 'Proxy residencial' : '⚠️ IP direto (configure RES_PROXY_ENABLED=true)'}`);
      console.log(`☁️ Worker:        ${CLOUDFLARE_WORKER_URL ? 'Ativo' : 'Inativo'}`);
      console.log(`🔒 Relay Secret:  ${RELAY_SECRET ? 'Configurado' : '❌ AUSENTE'}`);
      console.log(`🎬 Player:        Video.js com refresh automático`);
      console.log(`💰 Preços:        R$ 2,50/hora (cálculo proporcional)`);
      console.log(`🤖 Bot:           Ativo`);
      console.log(`💳 PIX:           ${MP_ACCESS_TOKEN ? 'Ativo' : 'Inativo'}`);
      console.log(`📊 Cache:         ${CACHE_CONTEUDO.movies.length} filmes | ${CACHE_CONTEUDO.series.length} séries`);
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

process.on('unhandledRejection', (reason) => { console.error('❌ Unhandled Rejection:', reason); });
process.on('uncaughtException',  (error)  => { console.error('❌ Uncaught Exception:', error); process.exit(1); });

iniciarServidor();