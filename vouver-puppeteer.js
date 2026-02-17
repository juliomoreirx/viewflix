const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Usar plugin stealth (anti-detecção)
puppeteer.use(StealthPlugin());

async function fazerLoginComPuppeteer(username, password, baseUrl) {
  let browser;
  let page;
  
  try {
    console.log('🤖 Iniciando Puppeteer com Stealth Plugin...');
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      timeout: 60000
    });
    
    console.log('✅ Navegador iniciado (modo stealth)');
    
    page = await browser.newPage();
    
    // Configurar timeout padrão maior
    page.setDefaultTimeout(45000);
    page.setDefaultNavigationTimeout(45000);
    
    // User agent realista
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Viewport
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Extra headers para parecer mais real
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    });
    
    console.log('📡 Navegando para página inicial (bypassando Cloudflare)...');
    
    // Passo 1: Ir para página principal PRIMEIRO (não login direto)
    await page.goto(baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });
    
    console.log('✅ Página principal carregada');
    console.log('⏳ Aguardando Cloudflare resolver challenge...');
    
    // Aguardar Cloudflare challenge resolver (10 segundos)
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Verificar se ainda tem challenge
    const hasChallenge = await page.evaluate(() => {
      return document.body.innerText.includes('Checking your browser') ||
             document.body.innerText.includes('Just a moment') ||
             document.title.includes('Just a moment');
    });
    
    if (hasChallenge) {
      console.log('⏳ Challenge ainda ativo, aguardando mais...');
      await new Promise(resolve => setTimeout(resolve, 10000));
    } else {
      console.log('✅ Cloudflare challenge resolvido!');
    }
    
    console.log('📡 Navegando para página de login...');
    
    // Passo 2: AGORA navega para login
    await page.goto(`${baseUrl}/index.php?page=login`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });
    
    console.log('✅ Página de login carregada');
    
    // Aguardar um pouco
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('⏳ Procurando formulário de login...');
    
    // Aguardar formulário aparecer
    await page.waitForSelector('input[name="username"]', { 
      visible: true,
      timeout: 20000
    });
    
    console.log('✅ Formulário encontrado!');
    
    // Aguardar mais um pouco (comportamento humano)
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    console.log('📝 Preenchendo credenciais...');
    
    // Focar e limpar campo username
    await page.click('input[name="username"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    
    // Digitar username devagar (parecer humano)
    await page.type('input[name="username"]', username, { delay: 80 + Math.random() * 40 });
    
    await new Promise(resolve => setTimeout(resolve, 800));
    
    // Focar e limpar campo password
    await page.click('input[name="sifre"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    
    // Digitar senha devagar
    await page.type('input[name="sifre"]', password, { delay: 90 + Math.random() * 50 });
    
    await new Promise(resolve => setTimeout(resolve, 1200));
    
    console.log('🚀 Submetendo formulário...');
    
    // Clicar no botão de login
    const navigationPromise = page.waitForNavigation({ 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    }).catch(err => {
      console.log('⚠️ Timeout na navegação (pode ser normal)');
      return null;
    });
    
    await page.click('input[name="login"]');
    
    // Aguardar navegação ou timeout
    await navigationPromise;
    
    console.log('✅ Formulário enviado');
    
    // Aguardar um pouco para processar
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Pegar URL atual
    const currentUrl = page.url();
    console.log('📍 URL atual:', currentUrl);
    
    // Extrair cookies
    const cookies = await page.cookies();
    
    console.log(`🍪 ${cookies.length} cookies extraídos:`);
    
    cookies.forEach(cookie => {
      console.log(`   🍪 ${cookie.name} = ${cookie.value.substring(0, 20)}...`);
    });
    
    // Verificar cookie de sessão
    const sessionCookie = cookies.find(c => 
      c.name === 'vouverme' || 
      c.name.toLowerCase().includes('session') ||
      c.name.toLowerCase().includes('phpsessid')
    );
    
    if (sessionCookie) {
      console.log('✅ Cookie de sessão encontrado:', sessionCookie.name);
      
      return {
        success: true,
        cookies: cookies
      };
    }
    
    // Verificar se saiu da página de login
    if (!currentUrl.includes('page=login')) {
      console.log('✅ Redirecionado da página de login (possível sucesso)');
      
      // Mesmo sem cookie específico, pode ter funcionado
      if (cookies.length > 0) {
        return {
          success: true,
          cookies: cookies
        };
      }
    }
    
    console.error('❌ Cookie de sessão não encontrado');
    
    // Debug: verificar se tem mensagem de erro
    try {
      const errorMsg = await page.evaluate(() => {
        const alerts = document.querySelectorAll('.alert, .error, .alert-danger, .alert-warning');
        if (alerts.length > 0) {
          return Array.from(alerts).map(el => el.innerText).join(' | ');
        }
        return null;
      });
      
      if (errorMsg) {
        console.error('❌ Erro na página:', errorMsg);
      }
    } catch (e) {
      // Ignora
    }
    
    // Screenshot para debug
    try {
      const screenshotPath = `debug-login-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`📸 Screenshot salvo: ${screenshotPath}`);
    } catch (e) {
      console.warn('⚠️ Não foi possível salvar screenshot');
    }
    
    return {
      success: false,
      cookies: []
    };
    
  } catch (error) {
    console.error('❌ Erro no Puppeteer:', error.message);
    
    if (error.stack) {
      console.error('Stack:', error.stack.split('\n').slice(0, 5).join('\n'));
    }
    
    // Tentar screenshot mesmo com erro
    if (page) {
      try {
        const screenshotPath = `debug-error-${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`📸 Screenshot de erro salvo: ${screenshotPath}`);
      } catch (e) {
        // Ignora
      }
    }
    
    return {
      success: false,
      cookies: [],
      error: error.message
    };
  } finally {
    if (browser) {
      console.log('🔒 Fechando navegador...');
      try {
        await browser.close();
        console.log('✅ Navegador fechado');
      } catch (e) {
        console.warn('⚠️ Erro ao fechar navegador:', e.message);
      }
    }
  }
}

module.exports = { fazerLoginComPuppeteer };