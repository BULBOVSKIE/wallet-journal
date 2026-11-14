const $ = selector => document.querySelector(selector);
const list = $('#history-list');
const input = $('#wallet-input');
const state = { home: '', address: '', before: null, items: [], pending: false };
const date = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' });
const positionDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'medium' });
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 });
const ratio = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 1 });
const pnlFormat = new Intl.NumberFormat('ru-RU', { style: 'percent', maximumFractionDigits: 2, signDisplay: 'exceptZero' });
const duration = typeof Intl.DurationFormat === 'function' ? new Intl.DurationFormat('ru', { style: 'short' }) : null;
const compact = address => `${address.slice(0, 5)}…${address.slice(-4)}`;
const rates = new Map();
const pendingDays = new Map();
const hourOf = time => Math.floor(time / 3600) * 3600;
const usd = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
const signedUsd = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'USD', signDisplay: 'exceptZero' });
const capLabel = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 2 });
const cap = value => `$${capLabel.format(value)}`;
const amount = (value, quote, time, dollarValue) => {
  if (value == null) return '—';
  if (quote !== 'SOL') return `${number.format(value)} ${quote}`;
  const rate = time == null ? null : rates.get(hourOf(time));
  const dollars = dollarValue ?? (rate ? value * rate : null);
  return `${number.format(value)} SOL / ${dollars == null ? '— USD' : `≈ ${usd.format(dollars)}`}`;
};
const signed = (value, quote, time, dollarValue) => `${value > 0 ? '+' : ''}${amount(value, quote, time, dollarValue)}`;
const dollarRate = trade => trade.quote === 'SOL' && trade.time != null ? rates.get(hourOf(trade.time))
  : ['USDC', 'USDT'].includes(trade.quote) ? 1 : undefined;
const executionPriceUsd = trade => trade.price > 0 ? trade.price * dollarRate(trade) : NaN;
const executionPrice = new Intl.NumberFormat('ru-RU', { maximumSignificantDigits: 5 });
const time = seconds => duration?.format({ hours: Math.floor(seconds / 3600), minutes: Math.floor(seconds / 60) % 60, seconds: seconds % 60 }) || `${number.format(seconds)} с`;
const explorer = 'https://explorer.solana.com';
const poolNames = new Map();
const markets = new Map();
const chartObservers = new Map();
const motion = matchMedia('(prefers-reduced-motion: no-preference)');
let view;
let routeVersion = 0;
let applyRates = () => {};
let bossRun;
const quoteClock = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', timeStyle: 'medium' });
const quoteCurrency = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'USD' });
let quotePending = false;
let lastQuote;

async function refreshSolQuote() {
  if (quotePending || view !== 'landing' || document.hidden) return;
  quotePending = true;
  const status = $('#sol-quote-status');
  try {
    lastQuote = await api('/api/sol-quote', {});
    $('#sol-quote-price').textContent = quoteCurrency.format(lastQuote.price);
    status.textContent = `Coinbase · Сделка в ${quoteClock.format(lastQuote.time)} МСК`;
  } catch {
    status.textContent = lastQuote ? `Последняя цена · ${quoteClock.format(lastQuote.time)} МСК` : 'Цена временно недоступна';
  } finally {
    quotePending = false;
  }
}
let journalReveal;
const revealedPositions = new Set();

function watchJournalElements(elements) {
  if (!motion.matches || !('IntersectionObserver' in window)) return;
  journalReveal ??= new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).map(entry => entry.target)
      .sort((left, right) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    visible.forEach((node, index) => {
      journalReveal?.unobserve(node);
      node.classList.remove('journal-pending');
      if (!node.isConnected) return;
      if (node.dataset.position) revealedPositions.add(node.dataset.position);
      if (!motion.matches || node.matches(':focus-within')) return;
      node.animate([
        { opacity: 0, transform: 'translateY(15px) scale(.985)' },
        { opacity: 1, transform: 'translateY(-2px) scale(1)', offset: .78 },
        { opacity: 1, transform: 'none' },
      ], { duration: 320, delay: Math.min(index, 5) * 75, easing: 'ease-out', fill: 'backwards' });
    });
  }, { threshold: .1 });
  for (const node of elements) {
    node.classList.add('journal-pending');
    journalReveal.observe(node);
  }
}

function updateBossTotal(run) {
  const all = [...run.items.values()];
  const pairs = roundTrips(all);
  let total = 0;
  let priced = 0;
  let closed = 0;
  for (const item of all) {
    const pair = pairs.get(item.signature);
    if (!pair?.closed || item.signature !== pair.exit?.signature) continue;
    closed += 1;
    const dollars = positionDollars(pair);
    if (dollars == null) continue;
    total += dollars;
    priced += 1;
  }
  const value = $('#boss-total');
  value.textContent = priced ? signedUsd.format(total) : '—';
  value.className = priced ? total > 0 ? 'gain' : total < 0 ? 'loss' : '' : '';
  const missing = all.filter(item => item.kind === 'missing' || item.kind === 'unknown').length;
  const otherTrades = all.filter(item => item.kind === 'trade' && !pairs.get(item.signature)?.closed).length;
  const scope = run.complete ? (priced === closed && !missing && !otherTrades ? 'Вся история по адресу' : 'PnL по подтверждённым позициям')
    : run.error ? 'Частичная история' : 'Проверяем историю…';
  $('#boss-coverage').textContent = `${scope} · ${priced} из ${closed} закрытых позиций в расчёте${otherTrades ? ` · Обменов без пары: ${otherTrades}` : ''}${missing ? ` · Операций не разобрано: ${missing}` : ''}`;
  $('#boss-retry').hidden = !run.error;
}

async function scanBossHistory(address, version, resume = false) {
  const run = resume ? bossRun : { items: new Map(), before: null, complete: false, error: false };
  bossRun = run;
  run.error = false;
  const current = () => version === routeVersion && bossRun === run;
  updateBossTotal(run);
  try {
    do {
      const page = await api('/api/wallet', { address, ...(run.before ? { before: run.before } : {}) });
      if (!current()) return;
      for (const item of page.items) run.items.set(item.signature, item);
      if (page.before && page.before === run.before) throw new Error('History pagination stopped');
      run.before = page.before;
      await loadRates(page.items);
      if (!current()) return;
      run.complete = !run.before;
      updateBossTotal(run);
    } while (run.before);
  } catch {
    if (!current()) return;
    run.error = true;
    updateBossTotal(run);
  }
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function link(label, href) {
  const anchor = element('a', label);
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

async function api(path, params) {
  const response = await fetch(`${path}?${new URLSearchParams(params)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

function aggregateFills(fills, anchor) {
  if (!anchor) return null;
  const quantity = fills.reduce((sum, trade) => sum + trade.quantity, 0);
  const sameQuote = fills.every(trade => trade.quoteMint === anchor.quoteMint && trade.amount != null);
  const amount = sameQuote ? fills.reduce((sum, trade) => sum + trade.amount, 0) : null;
  const fee = fills.reduce((sum, trade) => sum + trade.fee, 0);
  return { ...anchor, quantity, amount, fee, price: amount == null ? null : amount / quantity,
    pool: fills.every(trade => trade.pool === anchor.pool) ? anchor.pool : null };
}

function buildPosition(group, closed) {
  const { operations, buys, sells, partial } = group;
  const entry = aggregateFills(buys, buys[0]);
  const exit = aggregateFills(sells, sells.at(-1));
  const singleQuote = entry && exit && operations.every(trade => trade.quoteMint === entry.quoteMint);
  const result = closed && !partial && singleQuote && entry.amount != null && exit.amount != null ? exit.amount - entry.amount : null;
  const net = result != null && exit.quote === 'SOL' ? result - entry.fee - exit.fee : null;
  const cost = entry?.amount == null ? null : entry.amount + (net != null ? entry.fee : 0);
  const pnl = cost > 0 && result != null ? (net ?? result) / cost : null;
  const seconds = entry?.time != null && exit?.time != null ? exit.time - entry.time : null;
  return { ...group, entry, exit, closed, singleQuote, result, net, pnl, seconds, last: operations.at(-1) };
}

function positionDollars(position) {
  if (!position?.closed || position.partial || !position.buys.length || !position.sells.length) return null;
  let total = 0;
  for (const trade of position.operations) {
    const rate = dollarRate(trade);
    const feeRate = rates.get(hourOf(trade.time));
    if (!rate || trade.amount == null || (trade.fee && !feeRate)) return null;
    total += (trade.side === 'buy' ? -1 : 1) * trade.amount * rate - trade.fee * (feeRate || 0);
  }
  return total;
}

function aggregateAmount(fills, aggregate, fees = false) {
  const quote = fees ? 'SOL' : aggregate.quote;
  const total = fees ? aggregate.fee : aggregate.amount;
  if (total == null) return 'См. суммы отдельных операций';
  let dollars = 0;
  for (const fill of fills) {
    const rate = fees ? rates.get(hourOf(fill.time)) : dollarRate(fill);
    if (!rate) return amount(total, quote, null);
    dollars += (fees ? fill.fee : fill.amount) * rate;
  }
  return amount(total, quote, null, dollars);
}

function roundTrips(items) {
  const pending = new Map();
  const positions = new Map();
  const finish = (group, closed) => {
    const position = buildPosition(group, closed);
    for (const trade of group.operations) positions.set(trade.signature, position);
  };
  // Items arrive newest first. A token starts a new position after the previous one reaches zero.
  for (const item of items.toReversed()) {
    if (item.kind === 'missing') {
      for (const group of pending.values()) group.partial = true;
    }
    for (const { mint } of item.movements || []) {
      const group = pending.get(mint);
      if (group) group.partial = true;
    }
    if (item.kind !== 'trade') continue;
    const { mint } = item;
    const before = item.balanceBefore == null ? null : BigInt(item.balanceBefore);
    const after = item.balanceAfter == null ? null : BigInt(item.balanceAfter);
    let group = pending.get(mint);
    if (group && before === 0n) {
      group.partial = true;
      finish(group, false);
      group = null;
    }
    if (!group) {
      group = { operations: [], buys: [], sells: [], balance: 0, rawBalance: 0n, partial: item.side === 'sell' || before > 0n };
      pending.set(mint, group);
    }
    if (before != null && group.after != null && before !== group.after) group.partial = true;
    group.after = after;
    group.operations.push(item);
    (item.side === 'buy' ? group.buys : group.sells).push(item);
    group.balance += (item.side === 'buy' ? 1 : -1) * item.quantity;
    if (group.rawBalance != null && item.quantityRaw != null) group.rawBalance += (item.side === 'buy' ? 1n : -1n) * BigInt(item.quantityRaw);
    else group.rawBalance = null;
    if (after == null && group.balance < -1e-9) group.partial = true;
    if (item.side === 'sell' && (after === 0n || after == null && Math.abs(group.balance) < 1e-9)) {
      if (group.rawBalance != null && group.rawBalance !== 0n) group.partial = true;
      finish(group, true);
      pending.delete(mint);
    }
  }
  for (const group of pending.values()) finish(group, false);
  return positions;
}

function tactic(title, text) {
  const card = element('article');
  card.append(element('h3', title), element('p', text));
  return card;
}

function renderPatterns(trades, pairs) {
  const cards = [];
  const closed = trades.filter(trade => {
    const position = pairs.get(trade.signature);
    return position?.closed && !position.partial && position.seconds != null && position.exit?.signature === trade.signature;
  });
  if (closed.length >= 2) {
    const holds = closed.map(trade => pairs.get(trade.signature).seconds).sort((a, b) => a - b);
    const mid = Math.floor(holds.length / 2);
    const median = holds.length % 2 ? holds[mid] : Math.round((holds[mid - 1] + holds[mid]) / 2);
    const fast = holds.filter(seconds => seconds < 300).length;
    cards.push(tactic(fast > holds.length / 2 ? 'Короткие удержания' : 'Удержание позиций',
      `${fast} из ${holds.length} сопоставленных позиций закрыты менее чем за 5 минут. Медиана ${time(median)}.`));
  }

  const buys = trades.toReversed().filter(trade => trade.side === 'buy');
  const previous = new Map();
  let lower = 0;
  let comparable = 0;
  for (const buy of buys) {
    const key = `${buy.mint}:${buy.quoteMint}`;
    const last = previous.get(key);
    if (last?.price && buy.price) {
      comparable += 1;
      if (buy.price <= last.price * .95) lower += 1;
    }
    previous.set(key, buy);
  }
  if (comparable >= 2) cards.push(tactic('Цена повторных входов',
    `${lower} из ${comparable} повторных покупок прошли по цене на 5% или больше ниже предыдущего входа в тот же токен.`));

  const marketBuys = buys.filter(buy => markets.get(buy.signature)?.entry);
  const nearLow = marketBuys.filter(buy => markets.get(buy.signature).entry.position <= .2).length;
  if (marketBuys.length) cards.push(tactic('Покупки у локального минимума',
    `${nearLow} из ${marketBuys.length} проверенных входов попали в нижние 20% диапазона за 30 минут до входа.`));

  const creators = buys.filter(buy => buy.creator);
  const ownLaunches = creators.filter(buy => buy.creator === state.address);
  if (ownLaunches.length) cards.push(tactic('Покупки своих токенов',
    `${ownLaunches.length} из ${creators.length} покупок с известным создателем относятся к токенам этого кошелька.`));

  if (!cards.length) cards.push(tactic('Мало данных для выводов',
    'Загрузите более ранние операции или откройте сделки со свечами пула.'));
  $('#patterns').replaceChildren(...cards);
}

function facts(entries) {
  const dl = element('dl', null, 'facts');
  for (const [key, value] of entries) {
    if (value == null) continue;
    const item = element('div');
    item.append(element('dt', key), element('dd', value));
    dl.append(item);
  }
  return dl;
}

function annotation(label, text) {
  const p = element('p');
  p.append(element('strong', label), document.createTextNode(` ${text}`));
  return p;
}

function positionReview(trade, pair, market, secondData) {
  const notes = [];
  const add = (label, text) => notes.push(annotation(label, text));
  if (!pair.closed || pair.partial) {
    add('Что видно.', `В этой позиции ${pair.buys.length} покупок и ${pair.sells.length} продаж. ${pair.partial ? 'История неполная.' : 'Полный выход пока не найден.'}`);
    if (pair.partial) add('Что проверить.', 'Загрузите более ранние операции или обновите журнал, чтобы восстановить историю позиции.');
    return notes;
  }
  const { entry, exit, result, net, pnl, seconds } = pair;
  if (!pair.singleQuote) {
    add('Что видно.', `Позиция закрыта. Валюты обменов различаются.${seconds != null ? ` Позиция удерживалась ${time(seconds)}.` : ''}`);
    return notes;
  }
  if (!entry.amount || exit.amount == null || pnl == null) {
    add('Что видно.', `Вход и выход сопоставлены. Позиция удерживалась ${time(seconds)}. Для сравнения цен нужны суммы обеих операций.`);
    return notes;
  }
  const gross = result / entry.amount;
  const delta = pnlFormat.format(gross);
  if (pnl > 0) {
    add('Что сработало.', `Выход принёс ${delta} к сумме входа до сетевых комиссий. PnL позиции ${pnlFormat.format(pnl)}${net != null ? ' после сетевых комиссий' : ' до пересчёта сетевых комиссий'}.`);
  } else if (result < 0) {
    add('Где возник убыток.', `Сумма выхода была на ${ratio.format(Math.abs(gross))} ниже суммы входа до сетевых комиссий. Позиция удерживалась ${time(seconds)}.`);
  } else if (net < 0) {
    add('Где возник убыток.', `До комиссий результат составил ${delta}. Сетевые комиссии перевели позицию в минус.`);
  } else {
    add('Что получилось.', 'Позиция закрылась в ноль в валюте сделки.');
  }
  if (net != null) {
    const fees = entry.fee + exit.fee;
    if (fees > 0) add('Сетевые комиссии.', `За вход и выход — ${number.format(fees)} SOL. Это ${ratio.format(fees / entry.amount)} от суммы входа${result > 0 ? ` и ${ratio.format(fees / result)} от результата до сетевых комиссий` : ''}.`);
  }

  const samePool = market && !market.reference && entry.pool === market.pool && exit.pool === market.pool;
  const entryPrice = executionPriceUsd(entry);
  const exitPrice = executionPriceUsd(exit);
  if (samePool && entryPrice > 0 && exitPrice > 0) {
    const before = market.candles.filter(([stamp]) => stamp >= entry.time - 1800 && stamp + 60 <= entry.time);
    if (before.length >= 3 && pair.buys.length === 1) {
      const low = Math.min(...before.map(candle => candle[3]));
      const high = Math.max(...before.map(candle => candle[2]));
      if (high > low) {
        const position = (entryPrice - low) / (high - low);
        const location = position < 0 ? 'ниже диапазона' : position > 1 ? 'выше диапазона'
          : position <= .2 ? 'у нижней границы диапазона' : position >= .8 ? 'у верхней границы диапазона' : 'внутри диапазона';
        add('Точка входа.', `Оценка входа — ${location} за 30 минут до сделки (${before.length} закрытых свечей).`);
      }
    }
    const detailed = secondData && secondData.start <= entry.time && secondData.end >= exit.time;
    const interval = detailed ? 1 : 60;
    const held = (detailed ? secondData.candles : market.candles).filter(([stamp]) => stamp >= entry.time && stamp + interval <= exit.time);
    if (held.length) {
      const best = Math.max(...held.map(candle => candle[2]));
      const worst = Math.min(...held.map(candle => candle[3]));
      add('Пока позиция была открыта.', `По ${held.length} ${detailed ? 'секундным' : 'минутным'} свечам цена относительно средней покупки менялась от ${pnlFormat.format(worst / entryPrice - 1)} до ${pnlFormat.format(best / entryPrice - 1)}. Средняя цена продажи — ${pnlFormat.format(exitPrice / entryPrice - 1)} относительно покупки в USD.`);
    }
  }
  if (!market) add('Контекст рынка.', 'Откройте капитализацию, чтобы подгрузить свечи и уточнить оценку входа и выхода.');
  else if (market.reference || !samePool) add('Контекст рынка.', 'Свечи показаны для ориентира. Чтобы сравнить исполнение с диапазоном пула, нужен подтверждённый общий пул входа и выхода.');
  else if (!entryPrice || !exitPrice) add('Контекст рынка.', 'Для сравнения со свечами нужна долларовая цена обеих операций.');
  else if (seconds < 120 && !secondData) add('Контекст рынка.', 'Приблизьте график для оценки движения между входом и выходом по секундным свечам.');

  if (pnl < 0) add('Что проверить.', `Сверьте выход через ${time(seconds)} с условием выхода, которое было у вас перед покупкой. ${result < 0 ? 'Если планировали покупать на просадке, проверьте место входа в диапазоне.' : 'Сравните ожидаемую прибыль с комиссиями за обе операции.'}`);
  else if (pnl > 0) add('Что проверить.', 'Сверьте цену выхода с целью, которую ставили перед входом. Цена после закрытия сама по себе не показывает качество решения.');
  return notes;
}

function marketCheck(data, trade) {
  if (data.state !== 'available') return data;
  const minute = Math.floor(trade.time / 60) * 60;
  const before = data.candles.filter(candle => candle[0] < minute);
  const low = Math.min(...before.map(candle => candle[3]));
  const high = Math.max(...before.map(candle => candle[2]));
  const entry = trade.side === 'buy' && before.length >= 3 && high > low && data.price > 0
    ? { low, high, position: (data.price - low) / (high - low), count: before.length } : null;
  return { ...data, entry };
}

const chartClock = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const preciseChartClock = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function chartWindow(data, zoom, center) {
  const { candles, markers } = data;
  const first = Math.min(candles[0][0], ...markers.map(marker => marker.time - 8));
  const last = Math.max(candles.at(-1)[0] + 60, ...markers.map(marker => marker.time + 8));
  const firstMarker = markers[0]?.time ?? (first + last) / 2;
  const lastMarker = markers.at(-1)?.time ?? firstMarker;
  const middle = center ?? (firstMarker + lastMarker) / 2;
  const windowSize = Math.min(last - first, Math.max(20, (last - first) / zoom, lastMarker - firstMarker + 12));
  const start = Math.max(first, Math.min(last - windowSize, middle - windowSize / 2));
  return { start, end: start + windowSize, first, last };
}

function drawChart(canvas, data, progress, { start, end }, finerCandles) {
  const { markers } = data;
  const candles = finerCandles || data.candles;
  const interval = finerCandles ? 1 : 60;
  const context = canvas.getContext('2d');
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  const dpr = devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  context.scale(dpr, dpr);
  const styles = getComputedStyle(canvas);
  const color = name => styles.getPropertyValue(name).trim();
  const accent = color('--chart');
  const down = color('--bad');
  const clock = end - start <= 240 ? preciseChartClock : chartClock;
  const visibleCandles = candles.filter(([stamp]) => stamp < end && stamp + interval > start);
  const visibleMarkers = markers.filter(marker => marker.time >= start && marker.time <= end);
  const levels = visibleMarkers.flatMap(marker => marker.level == null ? [] : [marker.level]);
  const low = Math.min(...visibleCandles.map(c => c[3]), ...levels);
  const high = Math.max(...visibleCandles.map(c => c[2]), ...levels);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return;
  const span = (high - low || high || 1) / 3;
  const magnitude = 10 ** Math.floor(Math.log10(span));
  const step = [1, 2, 2.5, 5, 10].find(unit => unit * magnitude >= span) * magnitude;
  const padding = (high - low || step) * .04;
  const min = Math.max(0, Math.floor((low - padding) / step) * step);
  const max = Math.max(min + step, Math.ceil((high + padding) / step) * step);
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, i) => max - step * i);
  context.font = '11px Cascadia Mono, monospace';
  const left = 13;
  const right = width - Math.max(...ticks.map(tick => context.measureText(cap(tick)).width)) - 22;
  const top = 19;
  const bottom = height - 33;
  const x = stamp => left + (right - left) * (stamp - start) / (end - start);
  const y = level => bottom - (bottom - top) * (level - min) / (max - min);
  context.strokeStyle = color('--line');
  context.fillStyle = color('--muted');
  context.textBaseline = 'middle';
  for (const tick of ticks) {
    context.beginPath();
    context.moveTo(left, y(tick));
    context.lineTo(right, y(tick));
    context.stroke();
    context.fillText(cap(tick), right + 8, y(tick));
  }
  for (const [stamp, align] of [[start, 'left'], [(start + end) / 2, 'center'], [end, 'right']]) {
    if (align === 'center' && right - left < 145) continue;
    context.textAlign = align;
    context.fillText(clock.format(stamp * 1000), x(stamp), height - 15);
  }
  context.save();
  context.beginPath();
  context.rect(left, top - 5, (right - left) * progress, bottom - top + 10);
  context.clip();
  const candleWidth = Math.max(1, Math.min(12, (x(start + interval) - left) * .65));
  context.lineWidth = 1;
  for (const [stamp, open, candleHigh, candleLow, close] of visibleCandles) {
    const center = x((Math.max(stamp, start) + Math.min(stamp + interval, end)) / 2);
    context.strokeStyle = context.fillStyle = close >= open ? accent : down;
    context.beginPath();
    context.moveTo(center, y(candleHigh));
    context.lineTo(center, y(candleLow));
    context.stroke();
    context.fillRect(center - candleWidth / 2, y(Math.max(open, close)), candleWidth, Math.max(1.5, Math.abs(y(open) - y(close))));
  }
  context.restore();
  for (const { side, time: stamp, level } of visibleMarkers) {
    const markerColor = color(side === 'buy' ? '--chart-entry' : '--chart-exit');
    const ordinate = level == null ? bottom + (side === 'buy' ? 5 : 10) : y(level);
    context.globalAlpha = progress;
    context.strokeStyle = markerColor;
    context.lineWidth = 1.5;
    if (level != null) {
      context.setLineDash([5, 5]);
      context.lineDashOffset = side === 'buy' ? 0 : 5;
      context.beginPath();
      context.moveTo(left, ordinate);
      context.lineTo(right, ordinate);
      context.stroke();
      context.setLineDash([]);
    }
    context.beginPath();
    context.arc(x(stamp), ordinate, level == null ? 3.5 : 5, 0, 2 * Math.PI);
    context.fillStyle = level == null ? color('--bg') : markerColor;
    context.fill();
    if (level != null) context.strokeStyle = color('--bg');
    context.stroke();
  }
  context.globalAlpha = 1;
  return right - left;
}

function showMarket(container, data, trade, pair, updateReview) {
  container.replaceChildren();
  if (data.state !== 'available') {
    container.append(element('p', 'Данных пула для расчёта капитализации пока нет. Детали исполнения можно проверить в транзакции.'));
    return;
  }
  if (!data.supply) {
    container.append(element('p', 'Не удалось получить общий выпуск токена. Повторите запрос позже.'));
    return;
  }
  const markers = (pair?.operations || [trade]).filter(item => item.time != null).map(item => {
    const usdPrice = executionPriceUsd(item);
    const level = Number.isFinite(usdPrice) && usdPrice > 0 ? usdPrice * data.supply : null;
    return { side: item.side, time: item.time, level };
  });
  const toCap = candles => candles.map(([stamp, ...values]) => [stamp, ...values.slice(0, 4).map(value => value * data.supply)]);
  const chartData = { markers,
    candles: toCap(data.candles) };
  const canvas = element('canvas');
  canvas.setAttribute('role', 'img');
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Home');
  const markerTimes = markers.map(item => `${item.side === 'buy' ? 'Вход по цене исполнения' : 'Выход по цене исполнения'} ${positionDate.format(item.time * 1000)} МСК`).join('. ');
  const candleLabel = interval => canvas.setAttribute('aria-label', `${interval} свечи общей капитализации ${data.name} в долларах. ${markerTimes}`);
  candleLabel('Минутные');
  const title = element('h3', 'Общая капитализация');
  const tools = element('div', null, 'chart-tools');
  const zoomIn = element('button', '+', 'quiet');
  const zoomOut = element('button', '−', 'quiet');
  const reset = element('button', 'Сбросить', 'quiet');
  const toTrade = element('button', 'К сделке', 'quiet');
  zoomIn.setAttribute('aria-label', 'Приблизить график');
  zoomOut.setAttribute('aria-label', 'Отдалить график');
  reset.setAttribute('aria-label', 'Сбросить масштаб графика');
  tools.append(zoomIn, zoomOut, toTrade, reset);
  const resolution = element('p', 'Свечи · 1 мин');
  resolution.className = 'chart-resolution';
  resolution.setAttribute('role', 'status');
  container.append(title, tools, canvas, resolution);
  let progress = motion.matches ? 0 : 1;
  let zoom = 1;
  let center = null;
  let drag;
  let plotWidth;
  const address = state.address;
  let fineRequest;
  let fineResult;
  const viewport = () => chartWindow(chartData, zoom, center);
  const covered = (window, range) => range && window.start >= range.start && window.end <= range.end;
  const redraw = () => {
    const window = viewport();
    const close = zoom > 1 && window.end - window.start <= 240;
    const result = covered(window, fineResult) ? fineResult : null;
    const fine = close && result?.candles?.some(([stamp]) => stamp < window.end && stamp + 1 > window.start)
      ? result.candles : null;
    candleLabel(fine ? 'Секундные' : 'Минутные');
    const status = fine ? `Свечи · 1 сек${fineResult.source === 'dmnd' ? ' · приблизительно в USD' : ''}` : 'Свечи · 1 мин';
    let extra = '';
    if (close && !fine) {
      const messages = { requires_access: 'Для секундных свечей добавьте DMND_API_KEY в .env и перезапустите сервер',
        invalid_key: 'dmnd.dev отклонил ключ. Проверьте Secret API Key в .env и перезапустите сервер.',
        conversion_unavailable: 'Секундные свечи есть, курс в USD за этот период недоступен',
        error: 'Ошибка загрузки секундных свечей. Измените масштаб для повтора.' };
      const message = result ? messages[result.state] || 'Секундных свечей за этот период нет'
        : drag ? 'Отпустите график для загрузки секундных свечей' : 'Загружаем секундные свечи…';
      extra = ` · ${message}`;
    }
    if (resolution.textContent !== status + extra) resolution.textContent = status + extra;
    plotWidth = drawChart(canvas, chartData, progress, window, fine) || plotWidth;
    canvas.classList.toggle('can-pan', window.end - window.start < window.last - window.first);
    toTrade.disabled = center == null;
  };
  const updateViewport = (retry = false) => {
    const window = viewport();
    if (zoom > 1 && window.end - window.start <= 240 && !covered(window, fineRequest)
      && (!covered(window, fineResult) || retry && fineResult.state === 'error')) {
      const start = Math.max(1, Math.floor(window.start) - 1);
      const end = Math.ceil(window.end) + 1;
      const request = { start, end };
      fineRequest = request;
      api('/api/market/seconds', { signature: trade.signature, address, start, end }).then(result => {
        if (fineRequest !== request) return;
        fineResult = { ...request, ...result, candles: result.candles && toCap(result.candles) };
        if (canvas.isConnected && result.candles && pair?.entry && pair?.exit && start <= pair.entry.time && end >= pair.exit.time) {
          updateReview({ start, end, candles: result.candles });
        }
      }).catch(() => {
        if (fineRequest === request) fineResult = { ...request, state: 'error' };
      }).finally(() => {
        if (fineRequest !== request) return;
        fineRequest = null;
        if (canvas.isConnected) redraw();
      });
    }
    redraw();
  };
  const setZoom = value => {
    zoom = Math.min(128, Math.max(1, value));
    if (zoom === 1) center = null;
    zoomIn.disabled = zoom >= 128;
    zoomOut.disabled = reset.disabled = zoom === 1;
    updateViewport(true);
  };
  zoomOut.disabled = reset.disabled = true;
  zoomIn.addEventListener('click', () => setZoom(zoom * 2));
  zoomOut.addEventListener('click', () => setZoom(zoom / 2));
  reset.addEventListener('click', () => setZoom(1));
  const focusTrade = () => { center = null; updateViewport(true); };
  toTrade.addEventListener('click', focusTrade);
  const panTo = (window, target) => {
    const half = (window.end - window.start) / 2;
    center = Math.max(window.first + half, Math.min(window.last - half, target));
  };
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || !canvas.classList.contains('can-pan') || !plotWidth) return;
    drag = { id: event.pointerId, x: event.clientX, window: viewport(), pixels: plotWidth };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('panning');
  });
  canvas.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId || drag.x === event.clientX && center == null) return;
    const { window, x, pixels } = drag;
    const seconds = (event.clientX - x) / pixels * (window.end - window.start);
    panTo(window, (window.start + window.end) / 2 - seconds);
    redraw();
  });
  const endPan = event => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    canvas.classList.remove('panning');
    updateViewport(true);
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, endPan);
  canvas.addEventListener('keydown', event => {
    if (event.key === 'Home') { event.preventDefault(); focusTrade(); return; }
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || !canvas.classList.contains('can-pan')) return;
    event.preventDefault();
    const window = viewport();
    const step = (window.end - window.start) / 5;
    panTo(window, (window.start + window.end) / 2 + (event.key === 'ArrowLeft' ? -step : step));
    updateViewport(true);
  });
  const observer = new ResizeObserver(redraw);
  chartObservers.set(canvas, observer);
  observer.observe(canvas);
  if (progress === 0) {
    const started = performance.now();
    const frame = now => {
      if (!canvas.isConnected) return;
      const elapsed = Math.min(1, (now - started) / 380);
      progress = 1 - (1 - elapsed) ** 2;
      redraw();
      if (elapsed < 1 && motion.matches) requestAnimationFrame(frame);
      else { progress = 1; redraw(); }
    };
    requestAnimationFrame(frame);
  }
  const legend = element('ul', null, 'chart-legend');
  for (const { side, time: stamp, level } of markers) {
    const item = element('li', null, side === 'buy' ? 'entry' : 'exit');
    const label = `${side === 'buy' ? 'Вход по сделке' : 'Выход по сделке'} · ${positionDate.format(stamp * 1000)} МСК`;
    item.append(element('span', null, level == null ? 'chart-time-dot' : 'chart-dash'), document.createTextNode(`${label} · ${level == null ? 'только время' : `≈ ${cap(level)}`}`));
    legend.append(item);
  }
  container.append(legend);
  const context = element('p', null, 'chart-context');
  context.append(element('strong', `Свечи · ${data.name}.`), document.createTextNode(
    ' Точки показывают итоговую цену обмена кошелька. В маршруте через несколько токенов она может отличаться от цены отдельного пула. Капитализация оценена по текущему выпуску.'));
  if (data.reference) context.append(document.createTextNode(' Пул выбран для ориентира.'));
  container.append(context);
  if (data.entry) {
    const { position, low, high, count } = data.entry;
    const details = `Диапазон до входа ${cap(low * data.supply)}–${cap(high * data.supply)} по ${count} минутным свечам.`;
    if (position <= .2) container.append(annotation('Вход у минимума.', details));
    else if (position >= .8) container.append(annotation('Вход у верхней границы.', `${details} Если план был покупать на лоях, этот вход стоит проверить.`));
    else container.append(annotation('Вход внутри диапазона.', details));
  } else if (trade.side === 'buy' && !data.reference) {
    container.append(element('p', 'Для оценки входа нужны цена исполнения и хотя бы три закрытые минутные свечи до сделки.'));
  }
  container.append(link('Открыть пул в GeckoTerminal ↗', `https://www.geckoterminal.com/solana/pools/${data.pool}`));
}

function addMarket(body, trade, pair, updateReview) {
  const section = element('div', null, 'market');
  const status = element('p');
  status.setAttribute('role', 'status');
  const button = element('button', 'Показать капитализацию', 'quiet');
  section.append(button, status);
  body.append(section);
  if (markets.has(trade.signature)) {
    showMarket(section, markets.get(trade.signature), trade, pair, updateReview);
    return;
  }
  const address = state.address;
  button.addEventListener('click', async () => {
    status.textContent = 'Загружаем данные для капитализации…';
    button.disabled = true;
    try {
      const [market] = await Promise.all([
        api('/api/market', { signature: trade.signature, address }),
        loadRates(pair?.operations || [trade]),
      ]);
      const data = marketCheck(market, trade);
      if (state.address !== address || !section.isConnected) return;
      if (data.state === 'available' && !data.supply) {
        status.textContent = 'Общий выпуск токена временно недоступен. Повторите запрос.';
        button.disabled = false;
        return;
      }
      if (data.state !== 'available') {
        status.textContent = 'Свечи за время сделки не найдены. Можно повторить запрос.';
        button.disabled = false;
        return;
      }
      markets.set(trade.signature, data);
      updateReview();
      if (data.name && !data.reference) section.closest('.trade').querySelector('.token strong').textContent = data.name;
      showMarket(section, data, trade, pair, updateReview);
      const trades = state.items.filter(item => item.kind === 'trade');
      renderPatterns(trades, roundTrips(state.items));
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
}

function executionDetails(trade, market) {
  if (!trade) return 'Не найдено в загруженной истории';
  const stamp = trade.time == null ? 'Время недоступно' : positionDate.format(trade.time * 1000);
  const price = executionPriceUsd(trade);
  const nativePrice = trade.price > 0 && trade.quote ? `${executionPrice.format(trade.price)} ${trade.quote} за токен` : '';
  const usdPrice = Number.isFinite(price) && price > 0 ? `≈ $${executionPrice.format(price)} за токен` : '';
  const level = usdPrice && market?.supply ? `капитализация ≈ ${cap(price * market.supply)}` : '';
  return [stamp, nativePrice || usdPrice || 'Цена исполнения недоступна', level].filter(Boolean).join(' · ');
}

function row(trade, pair) {
  const details = $('#trade-template').content.firstElementChild.cloneNode(true);
  const direction = details.querySelector('.direction');
  const sell = trade.side === 'sell';
  const pnl = pair?.pnl;
  direction.textContent = pair ? pnl > 0 ? '↗' : pnl < 0 ? '↘' : '→' : sell ? '↗' : '↙';
  direction.setAttribute('aria-hidden', 'true');
  direction.classList.toggle('sell', !pair && sell);
  if (pair) direction.classList.add(pnl > 0 ? 'gain' : pnl < 0 ? 'loss' : 'neutral');
  const title = details.querySelector('.token strong');
  const knownPool = poolNames.get(trade.pool);
  const knownMarket = markets.get(trade.signature);
  title.textContent = (!knownMarket?.reference && knownMarket?.name) || (knownPool?.base === trade.mint ? knownPool.name : compact(trade.mint));
  const positionStatus = pair.partial ? 'Неполная история' : pair.closed ? 'Закрытая позиция' : 'Открытая позиция';
  details.querySelector('.token small').textContent = `${positionStatus} · Покупки: ${pair.buys.length} · Продажи: ${pair.sells.length}`;
  if (pair?.pnl != null) details.querySelector('.token').append(element('span', `PnL ${pnlFormat.format(pair.pnl)}`,
    `position-pnl${pair.pnl < 0 ? ' loss' : ''}`));
  const stamp = details.querySelector('time');
  if (trade.time != null) {
    stamp.dateTime = new Date(trade.time * 1000).toISOString();
    stamp.textContent = date.format(trade.time * 1000);
    stamp.title = 'Московское время';
  }
  const total = details.querySelector('.amount');
  const updateTotal = () => { total.textContent = pair.closed && pair.seconds != null ? time(pair.seconds) : amount(trade.amount, trade.quote, trade.time); };
  updateTotal();
  const body = details.querySelector('.trade-body');
  let updateDetails;
  details.addEventListener('toggle', () => {
    if (!details.open || body.childNodes.length) return;
    const metrics = element('div');
    const outcome = element('div');
    const execution = element('div', null, 'position-execution');
    const review = element('section', null, 'position-review');
    let secondData;
    const updateReview = candles => {
      if (candles) secondData = candles;
      const market = markets.get(trade.signature);
      execution.replaceChildren(facts([
        [pair.buys.length > 1 ? 'Первый вход · средняя цена' : 'Точка входа · МСК', executionDetails(pair.entry, market)],
        [pair.sells.length > 1 ? 'Последняя продажа · средняя цена' : 'Точка выхода · МСК', executionDetails(pair.exit, market)],
      ]));
      review.replaceChildren(element('h3', 'Разбор позиции'), ...positionReview(trade, pair, market, secondData));
    };
    updateDetails = () => {
    metrics.replaceChildren(facts([
      ['Сумма покупок', pair.entry ? aggregateAmount(pair.buys, pair.entry) : null],
      ['Сумма продаж', pair.exit ? aggregateAmount(pair.sells, pair.exit) : null],
      [pair?.net != null ? 'PnL после сетевых комиссий' : 'PnL позиции', pair?.pnl != null ? pnlFormat.format(pair.pnl) : 'Недостаточно данных'],
      ['Куплено токенов', pair.entry ? number.format(pair.entry.quantity) : null],
      ['Продано токенов', pair.exit ? number.format(pair.exit.quantity) : null],
      ['Комиссии за покупки', pair.entry ? aggregateAmount(pair.buys, pair.entry, true) : null],
      ['Комиссии за продажи', pair.exit ? aggregateAmount(pair.sells, pair.exit, true) : null],
    ]));
    if (pair.closed && !pair.partial) {
      const result = pair.net ?? pair.result;
      const dollars = positionDollars(pair);
      const money = result != null ? `${signed(result, trade.quote, null, dollars)} ${pair.net != null ? 'с учётом сетевых комиссий' : 'до сетевых комиссий'}.`
        : dollars != null ? `${signedUsd.format(dollars)} после сетевых комиссий.` : 'Для расчёта результата нужны суммы и курсы обменов.';
      outcome.replaceChildren(annotation('Результат позиции.', `${pair.seconds == null ? '' : `Между входом и выходом ${time(pair.seconds)}. `}${money}`));
    } else {
      outcome.replaceChildren(annotation('Результат позиции.', pair.partial ? 'Для расчёта нужна полная история позиции.' : 'Позиция ещё открыта.'));
    }
    updateReview();
    };
    updateDetails();
    body.append(execution, review, metrics, outcome);
    const links = element('div', null, 'trade-links');
    links.append(link('Открыть токен ↗', `${explorer}/address/${trade.mint}`));
    if (trade.creator) links.append(link(`Создатель ${compact(trade.creator)} ↗`, `${explorer}/address/${trade.creator}`));
    const operations = element('details', null, 'position-fills');
    operations.append(element('summary', `Операции позиции (${pair.operations.length})`));
    const fills = element('ul');
    for (const fill of pair.operations) {
      const item = element('li');
      const side = fill.side === 'buy' ? 'Покупка' : 'Продажа';
      item.append(link(`${side} · ${executionDetails(fill)} ↗`, `${explorer}/tx/${fill.signature}`));
      fills.append(item);
    }
    operations.append(fills);
    body.append(operations, links);
    addMarket(body, trade, pair, updateReview);
  });
  return { details, update: () => { updateTotal(); updateDetails?.(); } };
}

function loadRates(trades) {
  const days = new Set(trades.filter(trade => trade.time != null).map(trade => Math.floor(trade.time / 86400) * 86400));
  return Promise.all([...days].map(day => {
    if (pendingDays.has(day)) return pendingDays.get(day);
    const request = api('/api/sol-usd', { day }).then(data => {
      for (const [hour, rate] of Object.entries(data)) rates.set(Number(hour), rate);
      applyRates();
    }).catch(() => pendingDays.delete(day));
    pendingDays.set(day, request);
    return request;
  }));
}

function loadNames(trades, rows) {
  const groups = new Map();
  trades.slice(0, 10).forEach((trade, index) => {
    if (!trade.pool || poolNames.has(trade.pool)) return;
    if (!groups.has(trade.pool)) groups.set(trade.pool, []);
    groups.get(trade.pool).push({ detail: rows[index], mint: trade.mint });
  });
  for (const [pool, items] of [...groups].slice(0, 3)) {
    api('/api/pools', { pool }).then(result => {
      poolNames.set(pool, result);
      for (const { detail, mint } of items) {
        if (result.base === mint) detail.querySelector('.token strong').textContent = result.name;
      }
    }).catch(() => {});
  }
}

function render(animate = false) {
  for (const observer of chartObservers.values()) observer.disconnect();
  chartObservers.clear();
  const trades = state.items.filter(item => item.kind === 'trade');
  const unread = state.items.filter(item => item.kind === 'missing').length;
  const missing = state.items.filter(item => ['missing', 'unknown'].includes(item.kind)).length;
  const failed = state.items.filter(item => item.kind === 'failed').length;
  const pairs = roundTrips(state.items);
  const positions = trades.filter(trade => pairs.get(trade.signature)?.last.signature === trade.signature);
  const renderedRows = positions.map(trade => row(trade, pairs.get(trade.signature)));
  const rows = renderedRows.map(({ details }) => details);
  for (const node of list.children) journalReveal?.unobserve(node);
  if (view === 'legend') rows.forEach((node, index) => { node.dataset.position = positions[index].signature; });
  applyRates = () => renderedRows.forEach(({ update }) => update());
  $('#trade-count').textContent = `${positions.length}`;
  $('#coverage').textContent = `Операций в выборке: ${state.items.length} · Распознано сделок: ${trades.length}${missing ? ` · Требуют разбора: ${missing}` : ''}${failed ? ` · Не прошли: ${failed}` : ''}${unread ? ' · Обновите, чтобы запросить пропуски' : ''}`;
  list.replaceChildren(...(rows.length ? rows : [element('p', state.before
    ? 'В этой части истории нет распознанных сделок. Загрузите более ранние операции.'
    : 'Распознанных сделок нет. Проверьте другой публичный адрес Solana.', 'empty')]));
  $('#more').hidden = !state.before;
  if (view === 'legend') watchJournalElements(rows.filter(node => !revealedPositions.has(node.dataset.position)));
  else if (animate && motion.matches) rows.slice(0, 8).forEach((row, index) => {
    row.animate([{ opacity: .65 }, { opacity: 1 }], { delay: index * 12, duration: 135, fill: 'backwards' });
  });
  renderPatterns(trades, pairs);
  loadNames(positions, rows);
  loadRates(trades);
}

async function load(address, append = false, animate = false) {
  if (state.pending) return;
  const version = routeVersion;
  state.pending = true;
  $('#refresh').disabled = true;
  $('#more').disabled = true;
  const submit = $('#lookup button');
  submit.disabled = true;
  const prior = $('#coverage').textContent;
  $('#results').hidden = false;
  $('#coverage').textContent = append ? 'Загружаем более ранние операции…' : 'Загружаем историю кошелька…';
  $('#input-error').textContent = '';
  input.removeAttribute('aria-invalid');
  try {
    const data = await api('/api/wallet', { address, ...(append ? { before: state.before } : {}) });
    if (version !== routeVersion) return;
    if (state.address !== address) markets.clear();
    state.address = address;
    state.items = append ? [...new Map([...state.items, ...data.items].map(item => [item.signature, item])).values()] : data.items;
    state.before = data.before;
    const addressLink = $('#wallet-link');
    addressLink.href = `${explorer}/address/${address}`;
    addressLink.textContent = `${address} ↗`;
    addressLink.hidden = false;
    render(animate);
  } catch (error) {
    if (version !== routeVersion) return;
    $('#coverage').textContent = state.address ? prior : error.message;
    if (view === 'lookup' && !state.address) $('#results').hidden = true;
    $('#input-error').textContent = error.message;
    if (error.message.startsWith('Проверьте публичный')) input.setAttribute('aria-invalid', 'true');
  } finally {
    if (version !== routeVersion) return;
    state.pending = false;
    $('#refresh').disabled = !state.home;
    $('#more').disabled = false;
    submit.disabled = false;
  }
}

$('#lookup').addEventListener('submit', event => {
  event.preventDefault();
  load(input.value.trim(), false, true);
});
document.addEventListener('click', event => {
  const control = event.target.closest('button:enabled, a[href], summary');
  if (!control || event.defaultPrevented) return;
  control.animate([{ opacity: .8 }, { opacity: 1 }], { duration: 125, easing: 'ease-out' });
}, { capture: true });
$('#refresh').addEventListener('click', () => load(state.address || (view === 'legend' ? state.home : input.value.trim())));
$('#more').addEventListener('click', () => load(state.address, true));
$('#boss-retry').addEventListener('click', () => {
  if (view === 'legend' && bossRun?.error) void scanBossHistory(state.home, routeVersion, true);
});

let bossTransition = false;

$('#boss-entry').addEventListener('click', async event => {
  if (!motion.matches || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  if (bossTransition) return;
  const button = event.currentTarget;
  const version = routeVersion;
  bossTransition = true;
  try {
    const shake = document.body.animate([
      { transform: 'translate(0, 0)' },
      { transform: 'translate(-2px, 1px)' },
      { transform: 'translate(3px, -1px)' },
      { transform: 'translate(-4px, 1px)' },
      { transform: 'translate(4px, -2px)' },
      { transform: 'translate(-2px, 1px)' },
      { transform: 'translate(0, 0)' },
    ], { duration: 225, easing: 'linear' });
    await shake.finished;
    if (view !== 'landing' || routeVersion !== version) return;
    const enter = () => {
      if (view === 'landing' && routeVersion === version) location.hash = 'legend';
    };
    if (motion.matches) await playBossBurst(button, enter);
    else enter();
  } finally {
    bossTransition = false;
  }
});

async function playBossBurst(button, onMidpoint) {
  const rect = button.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const reach = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const burst = element('div', null, 'boss-burst');
  burst.setAttribute('aria-hidden', 'true');
  document.body.append(burst);
  const core = element('i', null, 'burst-core');
  burst.append(core);
  const flash = core.animate([
    { transform: `translate(${x}px,${y}px) translate(-50%,-50%) scale(.12)`, opacity: 0.8 },
    { transform: `translate(${x}px,${y}px) translate(-50%,-50%) scale(${reach / 24})`, opacity: 0.04 },
  ], { duration: 290, easing: 'cubic-bezier(.18,.8,.3,1)', fill: 'both' });
  for (let index = 0; index < 3; index += 1) {
    const wave = element('i', null, 'burst-wave');
    burst.append(wave);
    const origin = `translate(${x}px,${y}px) translate(-50%,-50%)`;
    wave.animate([{ transform: `${origin} scale(.4)`, opacity: .85 },
      { transform: `${origin} scale(${reach / 15})`, opacity: 0 }],
    { duration: 460, delay: index * 38, easing: 'cubic-bezier(.12,.65,.3,1)', fill: 'both' });
  }
  for (let index = 0; index < 48; index += 1) {
    const shard = element('i', null, 'burst-shard');
    burst.append(shard);
    const angle = index / 48 * Math.PI * 2;
    const distance = reach * (.28 + (index % 11) / 14);
    const size = .55 + (index % 5) * .24;
    const cx = x + Math.cos(angle) * distance;
    const cy = y + Math.sin(angle) * distance;
    shard.animate([{ transform: `translate(${x}px,${y}px) rotate(${angle}rad) scale(${size})`, opacity: 1 },
      { transform: `translate(${cx}px,${cy}px) rotate(${angle + .65}rad) scale(${size * .8})`, opacity: 0 }],
    { duration: 420 + index % 7 * 23, delay: index % 4 * 11, easing: 'cubic-bezier(.14,.62,.31,1)', fill: 'both' });
  }
  try {
    const finished = Promise.allSettled(burst.getAnimations({ subtree: true }).map(animation => animation.finished));
    await flash.finished;
    onMidpoint();
    await finished;
  } finally {
    burst.remove();
  }
}

async function route(focus = true) {
  const next = ['#legend', '#lookup'].includes(location.hash) ? location.hash.slice(1) : 'landing';
  if (view === next) return;
  const version = ++routeVersion;
  view = next;
  journalReveal?.disconnect();
  journalReveal = null;
  revealedPositions.clear();
  for (const node of document.querySelectorAll('.journal-pending')) node.classList.remove('journal-pending');
  bossRun = null;
  Object.assign(state, { address: '', before: null, items: [], pending: false });
  markets.clear();
  for (const observer of chartObservers.values()) observer.disconnect();
  chartObservers.clear();
  applyRates = () => {};
  list.replaceChildren();
  $('#patterns').replaceChildren();
  $('#trade-count').textContent = '';
  $('#landing').hidden = next !== 'landing';
  $('#workspace').hidden = next === 'landing';
  $('#workspace').dataset.view = next;
  $('#boss-pnl').hidden = next !== 'legend';
  $('#results').hidden = next !== 'legend';
  $('#coverage').textContent = next === 'legend' ? 'Загружаем историю кошелька…' : '';
  $('#lookup').hidden = next !== 'lookup';
  $('#wallet-link').hidden = true;
  $('#more').hidden = true;
  $('#lookup button').disabled = false;
  $('#input-error').textContent = '';
  input.removeAttribute('aria-invalid');
  if (next === 'landing') {
    if (focus) $('#landing-title').focus();
    void refreshSolQuote();
    return;
  }
  $('#title').textContent = next === 'legend' ? 'Карман босса' : 'Проверить кошелёк';
  $('#view-label').textContent = next === 'legend' ? 'Личный журнал' : 'Анализ Solana';
  if (focus) {
    if (next === 'legend') $('#workspace').focus({ preventScroll: true });
    else input.focus();
  }
  if (next !== 'legend') return;
  $('#boss-total').textContent = '—';
  $('#boss-total').className = '';
  $('#boss-coverage').textContent = 'Проверяем историю…';
  $('#boss-retry').hidden = true;
  watchJournalElements([$('.intro-copy'), $('#boss-pnl'), $('.toolbar'), $('.history .section-head'), $('.analysis')]);
  try {
    if (!state.home) state.home = (await api('/api/config', {})).homeWallet;
    if (version !== routeVersion) return;
    const addressLink = $('#wallet-link');
    addressLink.href = `${explorer}/address/${state.home}`;
    addressLink.textContent = `${state.home} ↗`;
    addressLink.hidden = false;
    await load(state.home, false, true);
    if (version === routeVersion) void scanBossHistory(state.home, version);
  } catch {
    if (version === routeVersion) $('#coverage').textContent = 'Не удалось открыть журнал. Обновите страницу.';
  }
}

window.addEventListener('hashchange', () => {
  if (location.hash === '#legend' && bossTransition) {
    void route();
    return;
  }
  const backwards = !['#legend', '#lookup'].includes(location.hash);
  const main = $('main');
  const offset = backwards ? '-16px' : '16px';
  document.documentElement.style.setProperty('--view-offset', offset);
  if (motion.matches && document.startViewTransition) {
    document.startViewTransition(() => { void route(); });
  } else {
    void route();
    if (motion.matches) main.animate([{ opacity: .45, transform: `translateX(${offset})` }, { opacity: 1, transform: 'none' }],
      { duration: 220, easing: 'ease-out' });
  }
});
route(false);
setInterval(refreshSolQuote, 30_000);
document.addEventListener('visibilitychange', refreshSolQuote);

setInterval(async () => {
  const isReading = () => list.querySelector('details[open]') || list.contains(document.activeElement);
  if (document.hidden || view !== 'legend' || !state.home || state.address !== state.home || state.pending) return;
  const address = state.address;
  const items = state.items;
  try {
    const latest = await api('/api/wallet', { address });
    if (state.address !== address || state.items !== items || state.pending || isReading()) return;
    const previous = new Map(items.map(item => [item.signature, item.kind]));
    if (latest.items.some(item => !previous.has(item.signature) || previous.get(item.signature) === 'missing' && item.kind !== 'missing')) {
      const overlap = latest.items.some(item => previous.has(item.signature));
      const latestIds = new Set(latest.items.map(item => item.signature));
      state.items = overlap ? [...latest.items, ...items.filter(item => !latestIds.has(item.signature))] : latest.items;
      if (!overlap) state.before = latest.before;
      render();
    }
  } catch {
    // The manual refresh button exposes transport failures without interrupting the journal.
  }
}, 45_000);
