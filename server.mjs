import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { walletHistory, marketContext, marketSeconds, isAddress, poolInfo, solUsdDay, solUsdQuote } from './solana.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const editions = new Map([['/violet', 'violet'], ['/red', 'red'], ['/original', 'original']]);
const homeWallet = process.env.WALLET_ADDRESS || '8PhVUPWrcU5eE1QYX6MqEseSgycPnbdRkdBUK5Rt6cDF';

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    'Cache-Control': 'no-store',
  });
  response.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const { pathname, searchParams: params } = url;
  if (request.method !== 'GET') return send(response, 405, { error: 'Используйте GET.' });

  try {
    if (editions.has(pathname)) {
      const template = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
      const html = template.replace('data-edition="original"', `data-edition="${editions.get(pathname)}"`);
      return send(response, 200, html, 'text/html; charset=utf-8');
    }
    if (files.has(pathname)) {
      const [file, type] = files.get(pathname);
      return send(response, 200, await readFile(new URL(`./public/${file}`, import.meta.url)), type);
    }
    if (pathname === '/api/config') return send(response, 200, { homeWallet });
    if (pathname === '/api/sol-quote') {
      try {
        return send(response, 200, await solUsdQuote());
      } catch {
        return send(response, 503, { error: 'Котировка SOL/USD временно недоступна.' });
      }
    }
    if (pathname === '/api/sol-usd') {
      const day = Number(params.get('day'));
      if (!Number.isInteger(day) || day % 86400 || day < 1586217600 || day > Date.now() / 1000) {
        return send(response, 400, { error: 'Курс на эту дату недоступен.' });
      }
      return send(response, 200, await solUsdDay(day));
    }
    if (pathname === '/api/wallet') {
      const address = params.get('address');
      const before = params.get('before');
      if (!isAddress(address) || (before && !isAddress(before, 64))) {
        return send(response, 400, { error: 'Проверьте публичный адрес Solana и повторите запрос.' });
      }
      return send(response, 200, await walletHistory(address, before));
    }
    if (pathname === '/api/market' || pathname === '/api/market/seconds') {
      const signature = params.get('signature');
      const address = params.get('address');
      if (!isAddress(signature, 64) || !isAddress(address)) {
        return send(response, 400, { error: 'Обновите историю и снова откройте сделку.' });
      }
      if (pathname.endsWith('/seconds')) {
        const start = Number(params.get('start'));
        const end = Number(params.get('end'));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end <= start || end - start > 600) {
          return send(response, 400, { error: 'Выберите период графика до десяти минут.' });
        }
        return send(response, 200, await marketSeconds(signature, address, start, end));
      }
      return send(response, 200, await marketContext(signature, address));
    }
    if (pathname === '/api/pools') {
      const pool = params.get('pool');
      if (!isAddress(pool)) return send(response, 400, { error: 'Проверьте адрес пула.' });
      return send(response, 200, await poolInfo(pool));
    }
    return send(response, 404, { error: 'Откройте главную страницу.' });
  } catch (error) {
    return send(response, error.status === 429 ? 429 : 502, {
      error: error.code === 'SUPPLY_UNAVAILABLE' ? 'Общий выпуск токена временно недоступен. Повторите запрос.' : error.status === 429
        ? 'Источник данных ограничил запросы. Подождите минуту и повторите.'
        : 'История временно недоступна. Повторите запрос через несколько секунд.',
    });
  }
});

const port = Number(process.env.PORT || 8787);
server.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`Solana Wallet Journal · http://localhost:${port}`);
});
