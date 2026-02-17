const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { obterProxiesValidas } = require('./proxy-scraper');
const fs = require('fs');
const path = require('path');

// Usar plugin stealth (anti-detecção)
puppeteer.use(StealthPlugin());

// Cache de proxies (evita buscar toda vez)
let PROXIES_CACHE = null;
let CACHE_TIMESTAMP = 0;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutos

async function obterProxies() {
  const agora = Date.now();
  
  // Se tem cache válido (menos de 30 min), usa
  if (PROXIES_CACHE && (agora - CACHE_TIMESTAMP) < CACHE_DURATION) {
    console.log('✅ Usando proxies do cache (válidas por mais ' + 
                Math.round((CACHE_DURATION - (agora - CACHE_TIMESTAMP)) / 60000) + ' minutos)');
    return PROXIES_CACHE;
  }
  
  // Buscar proxies novas
  console.log('🔄 Cache expirado ou primeiro uso, buscando proxies novas...\n');
  const proxiesNovas = await obterProxiesValidas();
  
  if (proxiesNovas.length > 0) {
    PROXIES_CACHE = proxiesNovas;
    CACHE_TIMESTAMP = agora;
    return proxiesNovas;
  }
  
  // Se não achou nenhuma, usa cache antigo (se tiver)
  if (PROXIES_CACHE) {
    console.log('⚠️ Nenhuma proxy nova, usando cache antigo');
    return PROXIES_CACHE;
  }
  
  // Sem cache e sem proxies novas = erro
  throw new Error('Nenhuma proxy disponível');
}

async function salvarScreenshot(page, proxy, motivo) {
  try {
    // Criar pasta screenshots se não existir
    const screenshotsDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir);
    }
    
    // Nome do arquivo com IP e timestamp
    const timestamp = Date.now();
    const nomeArquivo = `${proxy.host.replace(/\./g, '-')}_${timestamp}_${motivo}.png`;
    const caminhoCompleto = path.join(screenshotsDir, nomeArquivo);
    
    await page.screenshot({ 
      path: caminhoCompleto, 
      fullPage: true 
    });
    
    console.log(`📸 Screenshot salvo: ${nomeArquivo}`);
    
    // Salvar também o HTML
    const htmlContent = await page.content();
    const htmlArquivo = `${proxy.host.replace(/\./g, '-')}_${timestamp}_${motivo}.html`;
    const htmlCaminho = path.join(screenshotsDir, htmlArquivo);
    fs.writeFileSync(htmlCaminho, htmlContent);
    
    console.log(`📝 HTML salvo: ${htmlArquivo}`);
    
    return { screenshot: nomeArquivo, html: htmlArquivo };
    
  } catch (error) {
    console.log(`⚠️ Não foi possível salvar screenshot: ${error.message}`);
    return null;
  }
}

async function fazerLoginComPuppeteer(username, password, baseUrl) {
  let browser;
  let page;
  
  try {
    // Obter proxies dinâmicas
    const proxies = await obterProxies();
    
    if (proxies.length === 0) {
      throw new Error('Nenhuma proxy disponível para login');
    }
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🌐 ${proxies.length} proxies disponíveis para tentar`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    // TENTAR TODAS AS PROXIES
    for (let i = 0; i < proxies.length; i++) {
      const proxy = proxies[i];
      
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`🌐 Proxy ${i + 1}/${proxies.length}`);
      console.log(`   IP: ${proxy.host}:${proxy.port}`);
      console.log(`   Local: ${proxy.city}`);
      console.log(`   Latência: ${proxy.latency}ms`);
      console.log(`   Uptime: ${proxy.uptime}%`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      try {
        console.log('🤖 Iniciando Puppeteer...');
        
        browser = await puppeteer.launch({
          headless: 'new',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            `--proxy-server=http://${proxy.host}:${proxy.port}`
          ],
          timeout: 60000
        });
        
        console.log('✅ Navegador iniciado');
        
        page = await browser.newPage();
        
        // SEM autenticação (proxies grátis não precisam)
        
        page.setDefaultTimeout(45000);
        page.setDefaultNavigationTimeout(45000);
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });
        
        await page.setExtraHTTPHeaders({
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Connection': 'keep-alive'
        });
        
        console.log('📡 Navegando para página inicial...');
        
        await page.goto(baseUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45000
        });
        
        console.log('✅ Página principal carregada');
        console.log('⏳ Aguardando Cloudflare (15s)...');
        
        await new Promise(resolve => setTimeout(resolve, 15000));
        
        // Verificar se foi bloqueado
        const pageInfo = await page.evaluate(() => {
          return {
            title: document.title,
            bodyText: document.body.innerText.substring(0, 300),
            hasChallenge: document.body.innerText.includes('Checking your browser') ||
                         document.body.innerText.includes('Just a moment'),
            isBlocked: document.body.innerText.includes('Sorry, you have been blocked')
          };
        });
        
        console.log(`📄 Título: ${pageInfo.title}`);
        
        if (pageInfo.isBlocked) {
          console.log('❌ BLOQUEADO pelo Cloudflare!');
          console.log(`📄 Mensagem: ${pageInfo.bodyText}`);
          
          // SALVAR SCREENSHOT COM IP
          await salvarScreenshot(page, proxy, 'BLOQUEADO');
          
          // Fechar e tentar próxima
          await browser.close();
          browser = null;
          
          console.log(`⚠️ Proxy ${proxy.host}:${proxy.port} bloqueada, tentando próxima...\n`);
          continue;
        }
        
        if (pageInfo.hasChallenge) {
          console.log('⏳ Challenge ainda ativo, aguardando mais 15s...');
          await new Promise(resolve => setTimeout(resolve, 15000));
        } else {
          console.log('✅ Cloudflare resolvido!');
        }
        
        console.log('📡 Navegando para login...');
        
        await page.goto(`${baseUrl}/index.php?page=login`, {
          waitUntil: 'domcontentloaded',
          timeout: 45000
        });
        
        console.log('✅ Página de login carregada');
        
        // Verificar formulário
        const temFormulario = await page.evaluate(() => {
          return {
            hasForm: !!document.getElementById('username'),
            title: document.title,
            isBlocked: document.body.innerText.includes('Sorry, you have been blocked')
          };
        });
        
        if (temFormulario.isBlocked) {
          console.log('❌ BLOQUEADO na página de login!');
          
          await salvarScreenshot(page, proxy, 'BLOQUEADO-LOGIN');
          
          await browser.close();
          browser = null;
          
          console.log(`⚠️ Proxy ${proxy.host}:${proxy.port} bloqueada no login, tentando próxima...\n`);
          continue;
        }
        
        if (!temFormulario.hasForm) {
          console.log('❌ Formulário não encontrado!');
          console.log(`📄 Título: ${temFormulario.title}`);
          
          await salvarScreenshot(page, proxy, 'SEM-FORMULARIO');
          
          await browser.close();
          browser = null;
          
          console.log(`⚠️ Proxy ${proxy.host}:${proxy.port} sem formulário, tentando próxima...\n`);
          continue;
        }
        
        console.log('✅ Formulário encontrado!');
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        console.log('📝 Preenchendo credenciais...');
        
        await page.evaluate((user, pass) => {
          document.getElementById('username').value = user;
          document.getElementById('sifre').value = pass;
        }, username, password);
        
        console.log('✅ Credenciais preenchidas');
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log('🚀 Executando login via AJAX...');
        
        const loginSuccess = await page.evaluate(() => {
          return new Promise((resolve) => {
            const username = document.getElementById('username').value;
            const sifre = document.getElementById('sifre').value;
            
            fetch('app/_login.php', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                'username': username,
                'password': sifre,
                'type': '1'
              })
            })
            .then(response => response.text())
            .then(data => {
              if (data.trim() == '1') {
                resolve({ success: true, response: data });
              } else {
                resolve({ success: false, response: data });
              }
            })
            .catch(error => {
              resolve({ success: false, error: error.message });
            });
          });
        });
        
        console.log('📊 Resultado AJAX:', loginSuccess);
        
        if (!loginSuccess.success) {
          console.error('❌ Login AJAX falhou');
          
          await salvarScreenshot(page, proxy, 'LOGIN-FALHOU');
          
          await browser.close();
          browser = null;
          
          console.log(`⚠️ Login falhou com ${proxy.host}:${proxy.port}, tentando próxima...\n`);
          continue;
        }
        
        console.log('✅ Login AJAX bem-sucedido!');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        console.log('📡 Navegando para homepage...');
        
        try {
          await page.goto(`${baseUrl}/index.php?page=homepage`, {
            waitUntil: 'domcontentloaded',
            timeout: 20000
          });
          console.log('✅ Homepage carregada');
        } catch (e) {
          console.log('⚠️ Erro ao navegar (continuando...)');
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const cookies = await page.cookies();
        console.log(`🍪 ${cookies.length} cookies extraídos`);
        
        if (cookies.length > 0) {
          cookies.forEach(cookie => {
            console.log(`   🍪 ${cookie.name} = ${cookie.value.substring(0, 20)}...`);
          });
        }
        
        const sessionCookie = cookies.find(c => 
          c.name === 'vouverme' || 
          c.name.toLowerCase().includes('phpsessid')
        );
        
        if (sessionCookie || cookies.length > 0) {
          console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('✅✅✅ LOGIN 100% BEM-SUCEDIDO! ✅✅✅');
          console.log(`🌐 Proxy usada: ${proxy.host}:${proxy.port}`);
          console.log(`📍 Local: ${proxy.city}`);
          console.log(`⚡ Latência: ${proxy.latency}ms`);
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
          
          // Screenshot de sucesso
          await salvarScreenshot(page, proxy, 'SUCESSO');
          
          return {
            success: true,
            cookies: cookies,
            proxy: `${proxy.host}:${proxy.port}`
          };
        }
        
        console.log('⚠️ Sem cookies, tentando próxima proxy...\n');
        
        await browser.close();
        browser = null;
        
      } catch (error) {
        console.error(`❌ Erro com proxy ${proxy.host}:${proxy.port}:`, error.message);
        
        // Salvar screenshot do erro
        if (page) {
          await salvarScreenshot(page, proxy, 'ERRO');
        }
        
        if (browser) {
          try {
            await browser.close();
          } catch (e) {}
          browser = null;
        }
        
        // Se não é a última proxy, continua
        if (i < proxies.length - 1) {
          console.log(`⚠️ Tentando próxima proxy...\n`);
          continue;
        }
      }
    }
    
    // Se chegou aqui, todas falharam
    console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('❌ TODAS AS PROXIES FALHARAM');
    console.error(`📊 Total testadas: ${proxies.length}`);
    console.error('📸 Screenshots salvos na pasta /screenshots');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    return {
      success: false,
      cookies: [],
      error: `Todas as ${proxies.length} proxies falharam`
    };
    
  } catch (error) {
    console.error('❌ Erro geral:', error.message);
    
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
    
    return {
      success: false,
      cookies: [],
      error: error.message
    };
  }
}

// ===== FUNÇÃO: BUSCAR CACHE COM PUPPETEER =====

async function buscarCacheComPuppeteer(cookies, baseUrl) {
  let browser;
  let page;
  
  try {
    console.log('🔄 Buscando cache via Puppeteer (mesma sessão do login)...');
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ],
      timeout: 60000
    });
    
    page = await browser.newPage();
    
    // Setar os mesmos cookies do login
    await page.setCookie(...cookies);
    
    console.log('✅ Cookies do login aplicados');
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Buscar cache
    await page.goto(`${baseUrl}/app/_search.php?q=a`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    console.log('✅ Página de cache acessada');
    
    // Extrair JSON da página
    const cacheData = await page.evaluate(() => {
      try {
        const bodyText = document.body.innerText;
        return JSON.parse(bodyText);
      } catch (e) {
        console.log('Erro ao parsear JSON:', e.message);
        return null;
      }
    });
    
    await browser.close();
    
    if (cacheData) {
      console.log('✅ Cache obtido via Puppeteer');
      
      // Log de quantos itens foram obtidos
      let totalMovies = 0;
      let totalSeries = 0;
      
      if (cacheData.data) {
        totalMovies = (cacheData.data.movies || []).length;
        totalSeries = (cacheData.data.series || []).length;
      } else if (cacheData.movies) {
        totalMovies = (cacheData.movies || []).length;
        totalSeries = (cacheData.series || []).length;
      }
      
      console.log(`📊 Cache: ${totalMovies} filmes | ${totalSeries} séries`);
      
      return cacheData;
    } else {
      console.log('⚠️ Resposta do cache não é JSON válido');
      return null;
    }
    
  } catch (error) {
    console.error('❌ Erro ao buscar cache via Puppeteer:', error.message);
    
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
    
    return null;
  }
}

module.exports = { fazerLoginComPuppeteer, buscarCacheComPuppeteer };