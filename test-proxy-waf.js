require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'http://vouver.me';
const SESSION_COOKIES = process.env.SESSION_COOKIES || '';
const CF_CLEARANCE = process.env.CF_CLEARANCE || '';

const PROXY = {
  protocol: 'http',
  host: 'brd.superproxy.io',
  port: 33335,
  auth: {
    username: 'brd-customer-hl_44b6fe5a-zone-residential_proxy1',
    password: '5ece3xnmc316'
  }
};

function isBlocked(html = '') {
  const t = String(html).toLowerCase();
  return (
    t.includes('you are unable to access') ||
    t.includes('attention required') ||
    t.includes('access denied') ||
    (t.includes('cloudflare') && t.includes('ray id'))
  );
}

function buildCookieHeader() {
  let cookies = SESSION_COOKIES.trim();

  if (CF_CLEARANCE && !cookies.includes('cf_clearance=')) {
    cookies = cookies ? `${cookies}; cf_clearance=${CF_CLEARANCE}` : `cf_clearance=${CF_CLEARANCE}`;
  }

  return cookies;
}

async function run() {
  const cookieHeader = buildCookieHeader();

  if (!cookieHeader) {
    console.log('❌ SESSION_COOKIES/CF_CLEARANCE vazio no .env');
    process.exit(1);
  }

  const urls = [
    `${BASE_URL}/index.php?page=homepage`,
    `${BASE_URL}/index.php?page=moviedetail&id=380267`,
    `${BASE_URL}/?page=moviedetail&id=380267`
  ];

  let ok = 0;
  let fail = 0;

  for (let i = 1; i <= 10; i++) {
    console.log(`\n=== Rodada ${i}/10 ===`);
    for (const url of urls) {
      try {
        const resp = await axios.get(url, {
          proxy: PROXY,
          timeout: 25000,
          maxRedirects: 5,
          validateStatus: s => s < 500,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.8,en-US;q=0.5,en;q=0.3',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Referer': `${BASE_URL}/?page=movies`,
            'Cookie': cookieHeader
          }
        });

        const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
        const blocked = isBlocked(body);

        if (resp.status === 200 && !blocked) {
          ok++;
          console.log(`✅ ${resp.status} ${url}`);
        } else {
          fail++;
          console.log(`❌ ${resp.status} ${url} ${blocked ? '(WAF)' : '(inválido)'}`);
        }
      } catch (e) {
        fail++;
        console.log(`❌ ERRO ${url} -> ${e.message}`);
      }
    }
  }

  const total = ok + fail;
  const rate = total ? ((ok / total) * 100).toFixed(1) : '0.0';

  console.log('\n==============================');
  console.log(`Total: ${total}`);
  console.log(`Sucesso: ${ok}`);
  console.log(`Falha: ${fail}`);
  console.log(`Taxa de sucesso: ${rate}%`);
  console.log('==============================');

  if (+rate >= 95) console.log('🎉 Proxy APROVADA');
  else if (+rate >= 70) console.log('⚠️ Proxy instável');
  else console.log('🚫 Proxy reprovada para esse alvo');
}

run();