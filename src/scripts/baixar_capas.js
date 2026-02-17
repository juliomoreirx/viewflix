const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs-extra');
const path = require('path');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const stringSimilarity = require('string-similarity');

// --- SUA CHAVE DO TMDB (JÁ INSERIDA) ---
const TMDB_API_KEY = "af9f169135b4b5ea4ce03be8154e70c7"; 
const LANGUAGE = "pt-BR"; // Idioma das capas (Português do Brasil)

// Configurações do Site Alvo
const BASE_URL = "http://vouver.me";
// Suas credenciais do site Vouver
const CREDENCIAIS = { username: "vbx86272", password: "qbr96687" };

// Configurações de Download
const CONCURRENCY = 5; // Downloads simultâneos (não aumente muito para não ser bloqueado)
const MIN_SCORE = 0.3; // Grau de precisão do nome (0.3 é flexível, 1.0 é exato)

const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Origin": BASE_URL,
    "Referer": `${BASE_URL}/index.php?page=login`
};

// Pastas de Destino
const DIR_FILMES = path.join(__dirname, 'public', 'covers', 'movies');
const DIR_SERIES = path.join(__dirname, 'public', 'covers', 'series');

// Logs de erros
let LISTA_ERROS = [];

// --- FUNÇÕES AUXILIARES ---

function limparNome(nome) {
    // Remove sufixos como [L], [4K], dublado, anos, etc para limpar a busca
    return nome
        .replace(/\[.*?\]/g, '') // Remove [Texto]
        .replace(/\(.*?\)/g, '') // Remove (Texto)
        .replace(/4K|FHD|HD|Dublado|Legendado/gi, '')
        .replace(/-/g, ' ')
        .trim();
}

async function buscarNoTMDB(nomeOriginal, tipo) {
    if (!TMDB_API_KEY) return null;

    const nomeLimpo = limparNome(nomeOriginal);
    // Define se busca por filme ou série na API
    const tmdbType = tipo === 'series' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/search/${tmdbType}`;

    try {
        const res = await axios.get(url, {
            params: {
                api_key: TMDB_API_KEY,
                query: nomeLimpo,
                language: LANGUAGE,
                page: 1,
                include_adult: true // Tenta incluir conteúdo adulto se houver
            }
        });

        if (res.data.results && res.data.results.length > 0) {
            const resultados = res.data.results;
            
            // Cria lista de nomes encontrados para comparar
            const nomesEncontrados = resultados.map(r => r.title || r.name || "");
            
            // Encontra qual resultado tem o nome mais parecido com o nosso
            const match = stringSimilarity.findBestMatch(nomeLimpo, nomesEncontrados);
            const melhorResultado = resultados[match.bestMatchIndex];

            // Se a similaridade for muito baixa, provavelmente é o filme errado
            if (match.bestMatch.rating < MIN_SCORE) {
                return null; 
            }

            if (melhorResultado.poster_path) {
                // Retorna a imagem em qualidade w500 (padrão de poster)
                return `https://image.tmdb.org/t/p/w500${melhorResultado.poster_path}`;
            }
        }
    } catch (e) {
        // Silencia erros da API para não parar o loop
    }
    return null;
}

// Fallback: Se o TMDB não tiver, tenta pegar do site original (Vouver)
async function buscarNoSiteOriginal(id, tipo) {
    try {
        const page = tipo === 'series' ? 'seriesdetail' : 'moviedetail';
        const html = await client.get(`${BASE_URL}/index.php?page=${page}&id=${id}`, { headers: HEADERS });
        const $ = cheerio.load(html.data);
        
        let imgUrl = $('.slide-image img').attr('src');
        const bgImg = $('.right-wrap').css('background-image');
        
        // Tenta pegar do background que costuma ser melhor
        if (!imgUrl && bgImg) {
            imgUrl = bgImg.replace(/^url\(['"]?/, '').replace(/['"]?\)$/, '');
        }

        if (imgUrl && !imgUrl.startsWith('http')) return `${BASE_URL}/${imgUrl}`;
        return imgUrl;
    } catch (e) {
        return null;
    }
}

// --- LÓGICA PRINCIPAL ---

async function login() {
    console.log("🔓 [Sistema] Autenticando no Vouver...");
    const params = new URLSearchParams();
    params.append('username', CREDENCIAIS.username);
    params.append('sifre', CREDENCIAIS.password);
    params.append('beni_hatirla', 'on');
    params.append('recaptcha_response', '');
    params.append('login', 'Acessar');

    try {
        await client.post(`${BASE_URL}/index.php?page=login`, params, { headers: HEADERS });
        const cookies = await jar.getCookies(BASE_URL);
        if(cookies.some(c => c.key === 'vouverme')) {
            console.log("✅ Login realizado com sucesso!");
            return true;
        }
        console.error("❌ Falha no login.");
        return false;
    } catch (e) {
        console.error("❌ Erro de conexão:", e.message);
        return false;
    }
}

async function processarItem(item, tipo, pastaDestino) {
    const arquivoFinal = path.join(pastaDestino, `${item.id}.jpg`);
    
    // Se a imagem já existe no PC, pula
    if (fs.existsSync(arquivoFinal)) return 'SKIPPED';

    let imgUrl = null;
    let fonte = '';

    // 1. TENTA TMDB PRIMEIRO (Alta Qualidade)
    imgUrl = await buscarNoTMDB(item.name, tipo);
    if (imgUrl) fonte = 'TMDB';

    // 2. SE FALHAR, TENTA O SITE ORIGINAL (Baixa Qualidade/Fallback)
    if (!imgUrl) {
        imgUrl = await buscarNoSiteOriginal(item.id, tipo);
        if (imgUrl) fonte = 'SITE';
    }

    // Se não achou em lugar nenhum, registra erro
    if (!imgUrl) {
        LISTA_ERROS.push({ id: item.id, nome: item.name, tipo: tipo });
        return 'ERROR';
    }

    // 3. BAIXA A IMAGEM
    try {
        const writer = fs.createWriteStream(arquivoFinal);
        const response = await axios({
            url: imgUrl,
            method: 'GET',
            responseType: 'stream',
            timeout: 15000 // 15 segundos timeout
        });
        response.data.pipe(writer);
        
        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve(fonte));
            writer.on('error', () => {
                fs.unlink(arquivoFinal, () => {}); // Apaga arquivo corrompido
                reject();
            });
        });
    } catch (e) {
        return 'ERROR';
    }
}

async function iniciar() {
    fs.ensureDirSync(DIR_FILMES);
    fs.ensureDirSync(DIR_SERIES);

    if (await login()) {
        console.log("📋 Baixando lista completa de filmes e séries...");
        // Faz uma busca genérica para pegar tudo
        const resp = await client.get(`${BASE_URL}/app/_search.php?q=a`, { headers: HEADERS });
        
        // Verifica estrutura do JSON
        let dados = { movies: [], series: [] };
        if (resp.data.data) dados = resp.data.data;
        else if (resp.data.series || resp.data.movies) dados = resp.data;

        // Junta tudo num array único para processar
        const todas = [
            ...(dados.series || []).map(i => ({ ...i, tipo: 'series' })),
            ...(dados.movies || []).map(i => ({ ...i, tipo: 'movies' }))
        ];

        console.log(`🚀 Iniciando download de capas para ${todas.length} itens...`);
        console.log(`ℹ️  Prioridade: TMDB (Alta Qualidade) > Site Original (Backup)`);

        let processados = 0;
        let stats = { tmdb: 0, site: 0, skip: 0, erro: 0 };

        // Processamento em Lotes (Concurrency)
        for (let i = 0; i < todas.length; i += CONCURRENCY) {
            const lote = todas.slice(i, i + CONCURRENCY);
            
            await Promise.all(lote.map(async (item) => {
                const pasta = item.tipo === 'series' ? DIR_SERIES : DIR_FILMES;
                const res = await processarItem(item, item.tipo, pasta);
                
                if (res === 'TMDB') stats.tmdb++;
                else if (res === 'SITE') stats.site++;
                else if (res === 'SKIPPED') stats.skip++;
                else stats.erro++;
                
                processados++;
            }));

            // Barra de Progresso
            process.stdout.write(`\rProgresso: ${processados}/${todas.length} | 🌟 TMDB: ${stats.tmdb} | 💾 Site: ${stats.site} | ⏭️ Já tem: ${stats.skip} | ❌ X: ${stats.erro}`);
        }

        console.log("\n\n✅ Processo Finalizado!");
        
        // Relatório de Erros
        if (LISTA_ERROS.length > 0) {
            console.log(`⚠️ ${LISTA_ERROS.length} itens ficaram sem capa (Ficaram com 'X').`);
            fs.writeFileSync('erros_finais.json', JSON.stringify(LISTA_ERROS, null, 4));
            console.log("📄 Lista salva em 'erros_finais.json' para verificação manual.");
        } else {
            console.log("✨ Perfeito! Todas as capas foram baixadas.");
        }
    }
}

iniciar();