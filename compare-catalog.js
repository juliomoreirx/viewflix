#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execSync } = require('child_process');

// Cores para o terminal
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

async function downloadNewCatalog() {
  log('\n🔄 Baixando catálogo atualizado do Vouver...', 'cyan');
  
  try {
    const response = await axios.get('http://vouver.me/app/_search.php?q=a', {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    log('✅ Catálogo baixado com sucesso!', 'green');
    return response.data;
    
  } catch (error) {
    log(`❌ Erro ao baixar catálogo: ${error.message}`, 'red');
    return null;
  }
}

function loadCurrentCatalog() {
  const contentPath = path.join(__dirname, 'content.json');
  
  if (!fs.existsSync(contentPath)) {
    log('⚠️ Arquivo content.json não encontrado', 'yellow');
    return null;
  }
  
  try {
    const fileContent = fs.readFileSync(contentPath, 'utf8');
    return JSON.parse(fileContent);
  } catch (error) {
    log(`❌ Erro ao ler content.json: ${error.message}`, 'red');
    return null;
  }
}

function extractItems(catalog) {
  if (!catalog) return { movies: [], series: [], livetv: [] };
  
  if (catalog.data) {
    return {
      movies: catalog.data.movies || [],
      series: catalog.data.series || [],
      livetv: catalog.data.livetv || []
    };
  } else {
    return {
      movies: catalog.movies || [],
      series: catalog.series || [],
      livetv: catalog.livetv || []
    };
  }
}

function compareCatalogs(current, newCatalog) {
  const currentItems = extractItems(current);
  const newItems = extractItems(newCatalog);
  
  const diff = {
    movies: {
      added: [],
      removed: [],
      total: newItems.movies.length,
      previousTotal: currentItems.movies.length
    },
    series: {
      added: [],
      removed: [],
      total: newItems.series.length,
      previousTotal: currentItems.series.length
    },
    livetv: {
      added: [],
      removed: [],
      total: newItems.livetv.length,
      previousTotal: currentItems.livetv.length
    }
  };
  
  // Criar maps para comparação rápida
  const currentMoviesMap = new Map(currentItems.movies.map(m => [m.id, m]));
  const currentSeriesMap = new Map(currentItems.series.map(s => [s.id, s]));
  const currentLivetvMap = new Map(currentItems.livetv.map(l => [l.id, l]));
  
  const newMoviesMap = new Map(newItems.movies.map(m => [m.id, m]));
  const newSeriesMap = new Map(newItems.series.map(s => [s.id, s]));
  const newLivetvMap = new Map(newItems.livetv.map(l => [l.id, l]));
  
  // Filmes adicionados
  newItems.movies.forEach(movie => {
    if (!currentMoviesMap.has(movie.id)) {
      diff.movies.added.push(movie);
    }
  });
  
  // Filmes removidos
  currentItems.movies.forEach(movie => {
    if (!newMoviesMap.has(movie.id)) {
      diff.movies.removed.push(movie);
    }
  });
  
  // Séries adicionadas
  newItems.series.forEach(serie => {
    if (!currentSeriesMap.has(serie.id)) {
      diff.series.added.push(serie);
    }
  });
  
  // Séries removidas
  currentItems.series.forEach(serie => {
    if (!newSeriesMap.has(serie.id)) {
      diff.series.removed.push(serie);
    }
  });
  
  // Live TV adicionados
  newItems.livetv.forEach(live => {
    if (!currentLivetvMap.has(live.id)) {
      diff.livetv.added.push(live);
    }
  });
  
  // Live TV removidos
  currentItems.livetv.forEach(live => {
    if (!newLivetvMap.has(live.id)) {
      diff.livetv.removed.push(live);
    }
  });
  
  return diff;
}

function printDiff(diff) {
  log('\n' + '='.repeat(80), 'bold');
  log('📊 RELATÓRIO DE COMPARAÇÃO DE CATÁLOGO', 'bold');
  log('='.repeat(80), 'bold');
  
  // Filmes
  log('\n🎬 FILMES:', 'cyan');
  log(`   Total atual: ${diff.movies.previousTotal}`, 'blue');
  log(`   Total novo: ${diff.movies.total}`, 'blue');
  log(`   Diferença: ${diff.movies.total - diff.movies.previousTotal >= 0 ? '+' : ''}${diff.movies.total - diff.movies.previousTotal}`, 
      diff.movies.total - diff.movies.previousTotal >= 0 ? 'green' : 'red');
  
  if (diff.movies.added.length > 0) {
    log(`\n   ✅ ${diff.movies.added.length} novos filmes adicionados:`, 'green');
    diff.movies.added.slice(0, 10).forEach(m => {
      log(`      - ${m.name} (ID: ${m.id})`, 'green');
    });
    if (diff.movies.added.length > 10) {
      log(`      ... e mais ${diff.movies.added.length - 10} filmes`, 'green');
    }
  }
  
  if (diff.movies.removed.length > 0) {
    log(`\n   ❌ ${diff.movies.removed.length} filmes removidos:`, 'red');
    diff.movies.removed.slice(0, 10).forEach(m => {
      log(`      - ${m.name} (ID: ${m.id})`, 'red');
    });
    if (diff.movies.removed.length > 10) {
      log(`      ... e mais ${diff.movies.removed.length - 10} filmes`, 'red');
    }
  }
  
  // Séries
  log('\n📺 SÉRIES:', 'cyan');
  log(`   Total atual: ${diff.series.previousTotal}`, 'blue');
  log(`   Total novo: ${diff.series.total}`, 'blue');
  log(`   Diferença: ${diff.series.total - diff.series.previousTotal >= 0 ? '+' : ''}${diff.series.total - diff.series.previousTotal}`, 
      diff.series.total - diff.series.previousTotal >= 0 ? 'green' : 'red');
  
  if (diff.series.added.length > 0) {
    log(`\n   ✅ ${diff.series.added.length} novas séries adicionadas:`, 'green');
    diff.series.added.slice(0, 10).forEach(s => {
      log(`      - ${s.name} (ID: ${s.id})`, 'green');
    });
    if (diff.series.added.length > 10) {
      log(`      ... e mais ${diff.series.added.length - 10} séries`, 'green');
    }
  }
  
  if (diff.series.removed.length > 0) {
    log(`\n   ❌ ${diff.series.removed.length} séries removidas:`, 'red');
    diff.series.removed.slice(0, 10).forEach(s => {
      log(`      - ${s.name} (ID: ${s.id})`, 'red');
    });
    if (diff.series.removed.length > 10) {
      log(`      ... e mais ${diff.series.removed.length - 10} séries`, 'red');
    }
  }
  
  // Live TV
  log('\n📡 LIVE TV:', 'cyan');
  log(`   Total atual: ${diff.livetv.previousTotal}`, 'blue');
  log(`   Total novo: ${diff.livetv.total}`, 'blue');
  log(`   Diferença: ${diff.livetv.total - diff.livetv.previousTotal >= 0 ? '+' : ''}${diff.livetv.total - diff.livetv.previousTotal}`, 
      diff.livetv.total - diff.livetv.previousTotal >= 0 ? 'green' : 'red');
  
  log('\n' + '='.repeat(80), 'bold');
  
  // Resumo
  const totalAdded = diff.movies.added.length + diff.series.added.length + diff.livetv.added.length;
  const totalRemoved = diff.movies.removed.length + diff.series.removed.length + diff.livetv.removed.length;
  
  log('\n📈 RESUMO:', 'yellow');
  log(`   ✅ Total adicionado: ${totalAdded}`, 'green');
  log(`   ❌ Total removido: ${totalRemoved}`, 'red');
  log(`   📊 Mudanças totais: ${totalAdded + totalRemoved}`, 'cyan');
  
  return { totalAdded, totalRemoved };
}

function saveCatalog(catalog) {
  const contentPath = path.join(__dirname, 'content.json');
  
  try {
    // Adicionar timestamp
    const dataToSave = {
      ...catalog,
      lastUpdated: new Date().toISOString()
    };
    
    fs.writeFileSync(contentPath, JSON.stringify(dataToSave, null, 2), 'utf8');
    log('\n✅ Catálogo salvo em content.json', 'green');
    return true;
  } catch (error) {
    log(`\n❌ Erro ao salvar catálogo: ${error.message}`, 'red');
    return false;
  }
}

function generateReport(diff, filename = 'catalog-diff-report.txt') {
  const lines = [];
  
  lines.push('='.repeat(80));
  lines.push('RELATÓRIO DE COMPARAÇÃO DE CATÁLOGO');
  lines.push(`Data: ${new Date().toLocaleString('pt-BR')}`);
  lines.push('='.repeat(80));
  lines.push('');
  
  // Filmes
  lines.push('FILMES:');
  lines.push(`  Total anterior: ${diff.movies.previousTotal}`);
  lines.push(`  Total novo: ${diff.movies.total}`);
  lines.push(`  Diferença: ${diff.movies.total - diff.movies.previousTotal >= 0 ? '+' : ''}${diff.movies.total - diff.movies.previousTotal}`);
  lines.push('');
  
  if (diff.movies.added.length > 0) {
    lines.push(`  Adicionados (${diff.movies.added.length}):`);
    diff.movies.added.forEach(m => {
      lines.push(`    - ${m.name} (ID: ${m.id})`);
    });
    lines.push('');
  }
  
  if (diff.movies.removed.length > 0) {
    lines.push(`  Removidos (${diff.movies.removed.length}):`);
    diff.movies.removed.forEach(m => {
      lines.push(`    - ${m.name} (ID: ${m.id})`);
    });
    lines.push('');
  }
  
  // Séries
  lines.push('SÉRIES:');
  lines.push(`  Total anterior: ${diff.series.previousTotal}`);
  lines.push(`  Total novo: ${diff.series.total}`);
  lines.push(`  Diferença: ${diff.series.total - diff.series.previousTotal >= 0 ? '+' : ''}${diff.series.total - diff.series.previousTotal}`);
  lines.push('');
  
  if (diff.series.added.length > 0) {
    lines.push(`  Adicionadas (${diff.series.added.length}):`);
    diff.series.added.forEach(s => {
      lines.push(`    - ${s.name} (ID: ${s.id})`);
    });
    lines.push('');
  }
  
  if (diff.series.removed.length > 0) {
    lines.push(`  Removidas (${diff.series.removed.length}):`);
    diff.series.removed.forEach(s => {
      lines.push(`    - ${s.name} (ID: ${s.id})`);
    });
    lines.push('');
  }
  
  lines.push('='.repeat(80));
  
  const reportContent = lines.join('\n');
  
  try {
    fs.writeFileSync(filename, reportContent, 'utf8');
    log(`\n📝 Relatório salvo em: ${filename}`, 'cyan');
    return true;
  } catch (error) {
    log(`\n❌ Erro ao salvar relatório: ${error.message}`, 'red');
    return false;
  }
}

function promptUser(question) {
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise(resolve => {
    readline.question(question, answer => {
      readline.close();
      resolve(answer.toLowerCase());
    });
  });
}

async function commitAndPush(message) {
  try {
    log('\n📦 Fazendo commit e push...', 'cyan');
    
    execSync('git add content.json', { stdio: 'inherit' });
    execSync(`git commit -m "${message}"`, { stdio: 'inherit' });
    execSync('git push origin main', { stdio: 'inherit' });
    
    log('✅ Commit e push realizados com sucesso!', 'green');
    return true;
  } catch (error) {
    log(`❌ Erro ao fazer commit/push: ${error.message}`, 'red');
    return false;
  }
}

async function main() {
  log('\n' + '='.repeat(80), 'bold');
  log('🔍 FERRAMENTA DE COMPARAÇÃO DE CATÁLOGO', 'bold');
  log('='.repeat(80), 'bold');
  
  // 1. Carregar catálogo atual
  log('\n📂 Carregando catálogo atual...', 'cyan');
  const currentCatalog = loadCurrentCatalog();
  
  if (!currentCatalog) {
    log('\n⚠️ Nenhum catálogo atual encontrado. Criando novo...', 'yellow');
  }
  
  // 2. Baixar novo catálogo
  const newCatalog = await downloadNewCatalog();
  
  if (!newCatalog) {
    log('\n❌ Não foi possível baixar o novo catálogo. Abortando.', 'red');
    process.exit(1);
  }
  
  // 3. Comparar
  if (currentCatalog) {
    log('\n🔍 Comparando catálogos...', 'cyan');
    const diff = compareCatalogs(currentCatalog, newCatalog);
    
    // 4. Exibir diferenças
    const { totalAdded, totalRemoved } = printDiff(diff);
    
    // 5. Gerar relatório
    const timestamp = new Date().toISOString().split('T')[0];
    generateReport(diff, `catalog-diff-${timestamp}.txt`);
    
    // 6. Perguntar se quer atualizar
    if (totalAdded > 0 || totalRemoved > 0) {
      log('\n❓ Vale a pena atualizar?', 'yellow');
      
      const answer = await promptUser('   Deseja atualizar o catálogo? (s/n): ');
      
      if (answer === 's' || answer === 'sim' || answer === 'y' || answer === 'yes') {
        if (saveCatalog(newCatalog)) {
          const commitMsg = `chore: atualizar catálogo (+${totalAdded} -${totalRemoved})`;
          
          const pushAnswer = await promptUser('\n   Fazer commit e push automaticamente? (s/n): ');
          
          if (pushAnswer === 's' || pushAnswer === 'sim' || pushAnswer === 'y' || pushAnswer === 'yes') {
            await commitAndPush(commitMsg);
          } else {
            log('\n💡 Para fazer commit manualmente:', 'cyan');
            log(`   git add content.json`, 'blue');
            log(`   git commit -m "${commitMsg}"`, 'blue');
            log(`   git push origin main`, 'blue');
          }
        }
      } else {
        log('\n⏭️ Atualização cancelada.', 'yellow');
      }
    } else {
      log('\n✅ Nenhuma mudança detectada. Catálogo já está atualizado!', 'green');
    }
  } else {
    // Primeiro catálogo
    if (saveCatalog(newCatalog)) {
      log('\n✅ Primeiro catálogo criado com sucesso!', 'green');
      
      const answer = await promptUser('\nFazer commit e push? (s/n): ');
      
      if (answer === 's' || answer === 'sim') {
        await commitAndPush('feat: adicionar catálogo inicial');
      }
    }
  }
  
  log('\n✨ Concluído!\n', 'green');
}

// Executar
main().catch(error => {
  log(`\n❌ Erro fatal: ${error.message}`, 'red');
  process.exit(1);
});