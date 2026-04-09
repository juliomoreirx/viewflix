require('dotenv').config();
const axios = require('axios');

const BASE_URL = 'http://vouver.me';
const LOGIN_USER = process.env.LOGIN_USER;
const LOGIN_PASS = process.env.LOGIN_PASS;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9",
};

function extrairCookies(setCookieHeader, arr = []) {
  const cookies = [...arr];
  (setCookieHeader || []).forEach(str => {
    const pair = str.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const name = pair.substring(0, idx).trim();
      const value = pair.substring(idx + 1).trim();
      const ex = cookies.findIndex(c => c.name === name);
      if (ex >= 0) cookies[ex].value = value;
      else cookies.push({ name, value });
    }
  });
  return cookies;
}

function cookieString(arr) {
  return arr.map(c => `${c.name}=${c.value}`).join('; ');
}

async function capturar() {
  console.log('🔐 Fazendo login localmente...');

  const r1 = await axios.get(`${BASE_URL}/index.php?page=login`, { headers: HEADERS, timeout: 15000 });
  let cookies = extrairCookies(r1.headers['set-cookie']);

  const html = r1.data;
  const csrfMatch = html.match(/name=["']csrf_token["'][^>]*value=["']([a-f0-9\w]+)["']/);
  const csrf = csrfMatch ? csrfMatch[1] : '';
  console.log('CSRF:', csrf ? '✅' : '❌ não encontrado');

  const form = new URLSearchParams({ username: LOGIN_USER, sifre: LOGIN_PASS, beni_hatirla: 'on', csrf_token: csrf, recaptcha_response: '', login: 'Acessar' });

  const r2 = await axios.post(`${BASE_URL}/index.php?page=login`, form.toString(), {
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieString(cookies), 'Origin': BASE_URL, 'Referer': `${BASE_URL}/index.php?page=login` },
    maxRedirects: 5, validateStatus: s => s < 500, timeout: 15000
  });
  cookies = extrairCookies(r2.headers['set-cookie'], cookies);

  const ajax = new URLSearchParams({ username: LOGIN_USER, password: LOGIN_PASS, csrf_token: csrf, type: '1' });
  const r3 = await axios.post(`${BASE_URL}/ajax/login.php`, ajax.toString(), {
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', 'Cookie': cookieString(cookies), 'Origin': BASE_URL, 'Referer': `${BASE_URL}/index.php?page=login` },
    timeout: 15000
  });
  cookies = extrairCookies(r3.headers['set-cookie'], cookies);
  console.log('AJAX:', r3.data);

  const r4 = await axios.get(`${BASE_URL}/index.php?page=homepage`, {
    headers: { ...HEADERS, 'Cookie': cookieString(cookies) }, timeout: 15000
  });
  cookies = extrairCookies(r4.headers['set-cookie'], cookies);

  if (r4.data.includes('Sair') || r4.data.includes('Meu Perfil')) {
    const final = cookieString(cookies);
    console.log('\n✅ LOGIN OK! Cole isso no .env do servidor:\n');
    console.log(`SESSION_COOKIES=${final}`);
    console.log('\nCookies individuais:');
    cookies.forEach(c => console.log(`  ${c.name}=${c.value.substring(0,30)}...`));
  } else {
    console.log('❌ Login falhou');
  }
}

capturar().catch(console.error);