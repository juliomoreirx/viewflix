const axios = require('axios');
const cheerio = require('cheerio');

// Proxies hardcoded como fallback (atualize com as que você viu funcionando)
const PROXIES_FALLBACK = [
  { host: '200.174.198.32', port: 8888, city: 'Estácio', latency: 916, uptime: 1, anonymity: 'Elite' },
  { host: '45.175.171.4', port: 8085, city: 'Castilho', latency: 940, uptime: 3, anonymity: 'Elite' },
  { host: '187.86.159.54', port: 3128, city: 'Rio Grande', latency: 3503, uptime: 4, anonymity: 'Anônimo' },
  { host: '45.7.80.12', port: 80, city: 'Itanhomi', latency: 406, uptime: 1, anonymity: 'Transparente' },
  { host: '187.0.163.71', port: 80, city: 'Vilhena', latency: 791, uptime: 7, anonymity: 'Transparente' },
  { host: '45.6.0.100', port: 80, city: 'Goiânia', latency: 420, uptime: 1, anonymity: 'Transparente' },
  { host: '177.10.39.36', port: 1088, city: 'São João do Oriente', latency: 1114, uptime: 1, anonymity: 'Anônimo', protocol: 'socks5' }
].map(p => ({
  ...p,
  protocol: p.protocol || 'http',
  location: `Brasil-${p.city} (${p.latency}ms, ${p.uptime}% uptime)`
}));

async function buscarProxiesFreeProxyList() {
  console.log('🔍 Tentando Free-Proxy-List.net...');
  
  try {
    const response = await axios.get('https://free-proxy-list.net/', {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.google.com/',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
        'Cache-Control': 'max-age=0'
      }
    });
    
    const $ = cheerio.load(response.data);
    const proxies = [];
    
    $('table.table tbody tr').each((i, row) => {
      const cols = $(row).find('td');
      
      if (cols.length >= 7) {
        const ip = $(cols[0]).text().trim();
        const port = $(cols[1]).text().trim();
        const country = $(cols[3]).text().trim();
        const anonymity = $(cols[4]).text().trim();
        const https = $(cols[6]).text().trim();
        
        // Só Brazil
        if (country === 'Brazil' && ip && port) {
          proxies.push({
            host: ip,
            port: parseInt(port),
            protocol: https === 'yes' ? 'https' : 'http',
            anonymity: anonymity,
            city: 'Brazil',
            latency: 1000,
            uptime: 50,
            location: `Brasil (${1000}ms)`
          });
        }
      }
    });
    
    console.log(`✅ Free-Proxy-List: ${proxies.length} proxies BR`);
    return proxies;
    
  } catch (error) {
    console.log(`❌ Free-Proxy-List falhou: ${error.message}`);
    return [];
  }
}

async function buscarProxiesProxyScrape() {
  console.log('🔍 Tentando ProxyScrape API...');
  
  try {
    // API pública de proxies
    const response = await axios.get('https://api.proxyscrape.com/v2/', {
      params: {
        request: 'displayproxies',
        protocol: 'http',
        timeout: 10000,
        country: 'BR',
        ssl: 'all',
        anonymity: 'all'
      },
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const proxies = [];
    const lines = response.data.split('\n');
    
    lines.forEach(line => {
      const [ip, port] = line.trim().split(':');
      if (ip && port && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        proxies.push({
          host: ip,
          port: parseInt(port),
          protocol: 'http',
          anonymity: 'Unknown',
          city: 'Brazil',
          latency: 1000,
          uptime: 50,
          location: `Brasil (API)`
        });
      }
    });
    
    console.log(`✅ ProxyScrape: ${proxies.length} proxies BR`);
    return proxies;
    
  } catch (error) {
    console.log(`❌ ProxyScrape falhou: ${error.message}`);
    return [];
  }
}

async function buscarProxiesGeonode() {
  console.log('🔍 Tentando Geonode API...');
  
  try {
    const response = await axios.get('https://proxylist.geonode.com/api/proxy-list', {
      params: {
        limit: 50,
        page: 1,
        sort_by: 'lastChecked',
        sort_type: 'desc',
        country: 'BR',
        protocols: 'http,https'
      },
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const proxies = [];
    
    if (response.data && response.data.data) {
      response.data.data.forEach(p => {
        proxies.push({
          host: p.ip,
          port: parseInt(p.port),
          protocol: p.protocols && p.protocols[0] ? p.protocols[0] : 'http',
          anonymity: p.anonymityLevel || 'Unknown',
          city: p.city || 'Brazil',
          latency: p.latency || 1000,
          uptime: p.upTime || 50,
          location: `Brasil-${p.city || 'Unknown'} (${p.latency || 1000}ms)`
        });
      });
    }
    
    console.log(`✅ Geonode: ${proxies.length} proxies BR`);
    return proxies;
    
  } catch (error) {
    console.log(`❌ Geonode falhou: ${error.message}`);
    return [];
  }
}

async function buscarProxiesBrasil() {
  console.log('🔍 Buscando proxies grátis do Brasil de múltiplas fontes...\n');
  
  let todasProxies = [];
  
  // Tentar múltiplas fontes
  const fontes = [
    buscarProxiesGeonode,
    buscarProxiesProxyScrape,
    buscarProxiesFreeProxyList
  ];
  
  for (const fonte of fontes) {
    try {
      const proxies = await fonte();
      todasProxies = todasProxies.concat(proxies);
      
      // Se já encontrou pelo menos 3, pode parar
      if (todasProxies.length >= 3) {
        break;
      }
      
      // Aguardar 1s entre fontes
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      console.log(`⚠️ Erro ao buscar de uma fonte: ${error.message}`);
    }
  }
  
  // Se não encontrou nenhuma, usa fallback
  if (todasProxies.length === 0) {
    console.log('⚠️ Nenhuma proxy encontrada nas APIs');
    console.log('📦 Usando lista hardcoded (fallback)');
    todasProxies = PROXIES_FALLBACK;
  }
  
  // Remover duplicatas (mesmo IP)
  const proxiesUnicas = [];
  const ipsVistos = new Set();
  
  todasProxies.forEach(p => {
    if (!ipsVistos.has(p.host)) {
      ipsVistos.add(p.host);
      proxiesUnicas.push(p);
    }
  });
  
  // Ordenar por latência
  proxiesUnicas.sort((a, b) => a.latency - b.latency);
  
  console.log(`\n✅ Total: ${proxiesUnicas.length} proxies únicas do Brasil`);
  
  return proxiesUnicas;
}

async function testarProxyRapido(proxy) {
  try {
    const response = await axios.get('http://vouver.me', {
      proxy: {
        protocol: 'http',
        host: proxy.host,
        port: proxy.port
      },
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      validateStatus: () => true
    });
    
    const isBlocked = response.data.toString().includes('Sorry, you have been blocked');
    
    if (isBlocked) {
      return { success: false, reason: 'Bloqueado pelo Cloudflare' };
    }
    
    return { success: true, status: response.status };
    
  } catch (error) {
    return { success: false, reason: error.message };
  }
}

async function obterProxiesValidas() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔍 BUSCANDO PROXIES GRÁTIS BRASILEIRAS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  const proxies = await buscarProxiesBrasil();
  
  if (proxies.length === 0) {
    console.log('⚠️ Nenhuma proxy encontrada (nem fallback!)');
    return [];
  }
  
  console.log(`\n📋 ${proxies.length} proxies para testar:\n`);
  proxies.slice(0, 10).forEach((p, i) => {
    console.log(`   ${i + 1}. ${p.host}:${p.port} | ${p.city} | ${p.latency}ms | ${p.anonymity}`);
  });
  
  if (proxies.length > 10) {
    console.log(`   ... e mais ${proxies.length - 10} proxies`);
  }
  
  console.log('\n🧪 Testando proxies rapidamente...\n');
  
  const proxiesComStatus = [];
  
  // Testar até 15 proxies (ou todas se for menos)
  const proxiesParaTestar = proxies.slice(0, 15);
  
  for (let i = 0; i < proxiesParaTestar.length; i++) {
    const proxy = proxiesParaTestar[i];
    
    process.stdout.write(`   [${i + 1}/${proxiesParaTestar.length}] ${proxy.host}:${proxy.port} ... `);
    
    const resultado = await testarProxyRapido(proxy);
    
    if (resultado.success) {
      console.log(`✅ OK`);
      proxiesComStatus.push({ ...proxy, testOk: true });
    } else {
      console.log(`❌ ${resultado.reason}`);
      proxiesComStatus.push({ ...proxy, testOk: false, failReason: resultado.reason });
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  const proxiesOk = proxiesComStatus.filter(p => p.testOk);
  const proxiesFalha = proxiesComStatus.filter(p => !p.testOk);
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ ${proxiesOk.length} proxies OK para usar`);
  console.log(`❌ ${proxiesFalha.length} proxies falharam no teste`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  if (proxiesOk.length > 0) {
    console.log('📋 Proxies disponíveis para login:');
    proxiesOk.forEach((p, i) => {
      console.log(`   ${i + 1}. ${p.host}:${p.port} (${p.city}, ${p.latency}ms)`);
    });
    console.log('');
  }
  
  return proxiesOk;
}

module.exports = { obterProxiesValidas };