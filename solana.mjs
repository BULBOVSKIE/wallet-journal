const endpoint = process.env.SOLANA_RPC_URL || 'https://api.mainnet.solana.com';
const gecko = 'https://api.geckoterminal.com/api/v2/networks/solana';
const pageSize = process.env.SOLANA_RPC_URL ? 24 : 8;
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const pump = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const pumpSwap = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const jupiter = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const venues = new Map([[pump, 'Pump.fun'], [pumpSwap, 'PumpSwap'], [jupiter, 'Jupiter']]);
const quotes = new Map([[SOL, 'SOL'], [USDC, 'USDC'], [USDT, 'USDT']]);
const ammEvents = new Map([['67f4521f2cf57777', 'buy'], ['3e2f370aa503dc2a', 'sell']]);
const curveEvent = 'bddb7fd34ee661ee';
const retryPause = () => new Promise(resolve => setTimeout(resolve, 10_500));
let nextPublicBatch = 0;
let publicQueue = Promise.resolve();

function decodeBase58(value) {
  let number = 0n;
  for (const char of value) number = number * 58n + BigInt(alphabet.indexOf(char));
  const output = [];
  while (number > 0n) {
    output.push(Number(number & 255n));
    number >>= 8n;
  }
  for (const char of value) {
    if (char !== '1') break;
    output.push(0);
  }
  return Buffer.from(output.reverse());
}

function encodeBase58(bytes) {
  let number = BigInt(`0x${bytes.toString('hex') || '0'}`);
  let result = '';
  while (number > 0n) {
    result = alphabet[Number(number % 58n)] + result;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte) break;
    result = `1${result}`;
  }
  return result;
}

export function isAddress(value, size = 32) {
  return typeof value === 'string' && value.length >= size && value.length <= Math.ceil(size * 1.38)
    && [...value].every(char => alphabet.includes(char)) && decodeBase58(value).length === size;
}

function memoize(loader, ttl) {
  const cache = new Map();
  return (key) => {
    const current = cache.get(key);
    if (current && current.expires > Date.now()) return current.result;
    const record = { expires: Date.now() + ttl, result: loader(key) };
    cache.set(key, record);
    if (cache.size > 600) cache.delete(cache.keys().next().value);
    record.result.catch(() => {
      if (cache.get(key) === record) cache.delete(key);
    });
    return record.result;
  };
}

async function json(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(18000) });
  if (!response.ok) throw Object.assign(new Error('Upstream request failed'), { status: response.status });
  return response.json();
}

function requestRpc(body) {
  return json(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function requestBatch(body) {
  if (process.env.SOLANA_RPC_URL) return requestRpc(body);
  const result = publicQueue.then(async () => {
    const wait = nextPublicBatch - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    nextPublicBatch = Date.now() + 10_500;
    return requestRpc(body);
  });
  publicQueue = result.catch(() => {});
  return result;
}

async function rpc(method, params) {
  const response = await requestRpc({ jsonrpc: '2.0', id: 1, method, params });
  if (response.error) throw new Error(response.error.message);
  return response.result;
}

function transactionRequest(signature, id) {
  return { jsonrpc: '2.0', id, method: 'getTransaction', params: [signature, {
    encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1,
  }] };
}

const historyTransactions = new Map();
const getTransaction = memoize(async signature => {
  if (historyTransactions.has(signature)) return historyTransactions.get(signature);
  const response = await requestRpc(transactionRequest(signature, 1));
  if (response.error) throw new Error(response.error.message);
  return response.result;
}, 60_000);

async function transactions(signatures) {
  if (!signatures.length) return [];
  let requests = signatures.filter(({ signature }) => !historyTransactions.has(signature))
    .map(({ signature }, index) => transactionRequest(signature, index));
  for (let attempt = 0; requests.length && attempt < 2; attempt += 1) {
    try {
      const batch = await requestBatch(requests);
      if (!Array.isArray(batch)) throw new Error('RPC batch unavailable');
      const results = new Map(batch.map(item => [item.id, item]));
      requests = requests.filter(request => {
        const answer = results.get(request.id);
        if (answer?.result) {
          historyTransactions.set(request.params[0], answer.result);
          if (historyTransactions.size > 500) historyTransactions.delete(historyTransactions.keys().next().value);
        }
        return !answer || answer?.error?.code === 429 || /rate limit/i.test(answer?.error?.message || '');
      });
    } catch (error) {
      if (error.status !== 429 || attempt) throw error;
    }
    if (requests.length && !attempt && process.env.SOLANA_RPC_URL) await retryPause();
  }
  return signatures.map(({ signature }) => historyTransactions.get(signature) || null);
}

function tokenChanges(meta, address) {
  const changes = new Map();
  for (const [balances, sign] of [[meta.preTokenBalances, -1n], [meta.postTokenBalances, 1n]]) {
    for (const item of balances || []) {
      if (item.owner !== address) continue;
      const { amount, decimals } = item.uiTokenAmount;
      const change = changes.get(item.mint) || { raw: 0n, before: 0n, after: 0n, decimals };
      const balance = BigInt(amount);
      change.raw += sign * balance;
      change[sign < 0n ? 'before' : 'after'] += balance;
      changes.set(item.mint, change);
    }
  }
  return changes;
}

function events(instructions, logs) {
  const blobs = [];
  for (const instruction of instructions) {
    if (![pump, pumpSwap].includes(instruction.programId) || instruction.accounts?.length !== 1 || !instruction.data) continue;
    const bytes = decodeBase58(instruction.data);
    if (bytes.subarray(0, 8).toString('hex') === 'e445a52e51cb9a1d') blobs.push(bytes.subarray(8));
  }
  if (!blobs.length) {
    for (const log of logs || []) {
      if (log.startsWith('Program data: ')) blobs.push(Buffer.from(log.slice(14), 'base64'));
    }
  }
  return blobs;
}

function tradeEvent(blobs, address, mint, side, quantity, market) {
  for (const bytes of blobs) {
    const disc = bytes.subarray(0, 8).toString('hex');
    if (bytes.length >= 344 && ammEvents.get(disc) === side
      && encodeBase58(bytes.subarray(152, 184)) === address && bytes.readBigUInt64LE(16) === quantity) {
      const pool = encodeBase58(bytes.subarray(120, 152));
      if (market && market.pool !== pool) continue;
      return { pool: isAddress(pool) ? pool : null, creator: encodeBase58(bytes.subarray(312, 344)), amount: bytes.readBigUInt64LE(112) };
    }
    if (bytes.length >= 209 && disc === curveEvent && encodeBase58(bytes.subarray(8, 40)) === mint
      && encodeBase58(bytes.subarray(57, 89)) === address && Boolean(bytes[56]) === (side === 'buy')
      && bytes.readBigUInt64LE(48) === quantity) {
      let amount = null;
      // The native curve event records the trade amount before protocol and creator fees.
      if (market?.quoteMint === SOL && bytes.length >= 225) {
        const gross = bytes.readBigUInt64LE(40);
        const fees = bytes.readBigUInt64LE(169) + bytes.readBigUInt64LE(217);
        amount = side === 'buy' ? gross + fees : gross > fees ? gross - fees : null;
      }
      return { pool: market?.pool, creator: encodeBase58(bytes.subarray(177, 209)), amount };
    }
  }
  return null;
}

function marketAccounts(instructions, address, mint) {
  for (const instruction of instructions) {
    const a = instruction.accounts || [];
    if (instruction.programId === pumpSwap && a[1] === address && a[3] === mint) {
      return { pool: a[0], quoteMint: a[4] };
    }
    if (instruction.programId !== pump) continue;
    if (a[6] === address && a[2] === mint) return { pool: a[3], quoteMint: SOL };
    if (a[13] === address && a[1] === mint) return { pool: a[10], quoteMint: a[2] };
    if (a[8] === address && a[1] === mint) return { pool: a[5], quoteMint: a[2] };
  }
  return null;
}

function wrappedChange(tx, address, instructions, keys, changes) {
  const nativeAccounts = new Set();
  for (const balance of [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]) {
    if (balance.owner === address && balance.mint === SOL) nativeAccounts.add(keys[balance.accountIndex]);
  }
  for (const { parsed } of instructions) {
    const info = parsed?.info;
    if (info?.mint === SOL && info.owner === address && parsed.type.startsWith('initializeAccount')) {
      nativeAccounts.add(info.account);
    }
  }
  let raw = 0n;
  for (const { program, parsed } of instructions) {
    if (program !== 'spl-token' || !['transfer', 'transferChecked'].includes(parsed?.type)) continue;
    const { destination, source, tokenAmount, amount } = parsed.info;
    const direction = Number(nativeAccounts.has(destination)) - Number(nativeAccounts.has(source));
    if (direction) raw += BigInt(direction) * BigInt(tokenAmount?.amount || amount);
  }
  return raw || changes.get(SOL)?.raw || 0n;
}

export function parseTransaction(tx, address, signature = tx?.transaction?.signatures?.[0]) {
  if (!tx?.meta || !tx.transaction?.message || !signature) return null;
  const { meta, transaction: { message } } = tx;
  const keys = message.accountKeys.map(key => key.pubkey || key);
  const native = keys.indexOf(address);
  const fee = keys[0] === address ? meta.fee / 1e9 : 0;
  const solChange = native >= 0 ? (meta.postBalances[native] - meta.preBalances[native]) / 1e9 : 0;
  const base = { signature, time: tx.blockTime, fee, solChange };
  if (meta.err) return { ...base, kind: 'failed' };
  const instructions = [...message.instructions, ...(meta.innerInstructions || []).flatMap(group => group.instructions)];
  const venue = message.instructions.find(ix => venues.has(ix.programId)) || instructions.find(ix => venues.has(ix.programId));
  const changes = tokenChanges(meta, address);
  const assets = [...changes].filter(([mint, value]) => value.raw && !quotes.has(mint));
  const movements = assets.map(([mint, value]) => ({ mint, amount: Number(value.raw) / 10 ** value.decimals }));
  if (!venue || assets.length !== 1) return { ...base, kind: venue ? 'unknown' : 'other', movements };

  const [mint, token] = assets[0];
  const side = token.raw > 0n ? 'buy' : 'sell';
  const rawQuantity = token.raw > 0n ? token.raw : -token.raw;
  const quantity = Number(rawQuantity) / 10 ** token.decimals;
  const market = marketAccounts(instructions, address, mint);
  const event = tradeEvent(events(instructions, meta.logMessages), address, mint, side, rawQuantity, market);
  const stable = [USDC, USDT].filter(candidate => changes.get(candidate)?.raw);
  const rawSol = wrappedChange(tx, address, instructions, keys, changes);
  const opposite = change => change !== 0n && (change > 0n) === (side === 'sell');
  const preferredQuote = venue.programId === jupiter
    ? (stable.length === 1 && !opposite(rawSol) ? stable[0] : SOL)
    : (market?.quoteMint || (stable.length === 1 ? stable[0] : SOL));
  const stableChange = changes.get(preferredQuote);
  let amount = null;
  if (stable.length <= 1 && quotes.has(preferredQuote)) {
    if (preferredQuote === SOL && opposite(rawSol)) amount = Math.abs(Number(rawSol)) / 1e9;
    else if (preferredQuote === SOL && event?.amount != null) amount = Number(event.amount) / 1e9;
    else if (stableChange && opposite(stableChange.raw)) amount = Math.abs(Number(stableChange.raw)) / 10 ** stableChange.decimals;
  }
  if (amount == null && !market && stable.length === 0 && !rawSol) return { ...base, kind: 'unknown', movements };
  return { ...base, kind: 'trade', mint, side, quantity, amount, price: amount == null ? null : amount / quantity,
    balanceBefore: token.before.toString(), balanceAfter: token.after.toString(), quantityRaw: rawQuantity.toString(),
    quote: quotes.get(preferredQuote) || null, quoteMint: preferredQuote, venue: venues.get(venue.programId),
    pool: event?.pool || market?.pool || null, creator: event?.creator && isAddress(event.creator) ? event.creator : null };
}

const getHistory = memoize(async key => {
  const [address, before] = key.split(':');
  const records = await rpc('getSignaturesForAddress', [address, {
    limit: pageSize, commitment: 'finalized', ...(before ? { before } : {}),
  }]);
  const details = await transactions(records);
  const items = records.map((record, index) => parseTransaction(details[index], address, record.signature)
    || { signature: record.signature, time: record.blockTime, kind: 'missing' });
  return { address, items, before: records.length === pageSize ? records.at(-1).signature : null };
}, 25_000);

export const walletHistory = (address, before) => getHistory(`${address}:${before || ''}`);

export const poolInfo = memoize(async pool => {
  const { data } = await json(`${gecko}/pools/${pool}?include=base_token,quote_token`);
  return { address: pool, name: data.attributes.name, base: data.relationships.base_token.data.id.replace('solana_', '') };
}, 15 * 60_000);

const loadSolQuote = memoize(async () => {
  const ticker = await json('https://api.exchange.coinbase.com/products/SOL-USD/ticker');
  const price = Number(ticker.price);
  const time = Date.parse(ticker.time);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(time)) throw new Error('SOL/USD quote unavailable');
  return { price, time };
}, 15_000);

export const solUsdQuote = () => loadSolQuote('SOL-USD');

export const solUsdDay = memoize(async day => {
  const start = new Date(day * 1000).toISOString();
  const end = new Date((day + 86400) * 1000).toISOString();
  const candles = await json(`https://api.exchange.coinbase.com/products/SOL-USD/candles?${new URLSearchParams({ start, end, granularity: '3600' })}`);
  return Object.fromEntries(candles.filter(([hour, , , open]) => hour >= day && hour < day + 86400 && open > 0)
    .map(([hour, , , open]) => [hour, open]));
}, 5 * 60_000);

const tokenSupply = memoize(async mint => {
  const { value } = await rpc('getTokenSupply', [mint, { commitment: 'finalized' }]);
  const supply = Number(value.amount) / 10 ** value.decimals;
  return Number.isFinite(supply) && supply > 0 ? supply : null;
}, 120_000);

const poolsByToken = memoize(async mint => {
  const { data } = await json(`${gecko}/tokens/${mint}/pools`);
  return data;
}, 120_000);

const marketCandles = memoize(async key => {
  const [pool, mint, end] = key.split(':');
  const url = `${gecko}/pools/${pool}/ohlcv/minute?aggregate=1&before_timestamp=${end}&limit=65&currency=usd&token=${mint}`;
  try {
    const { data } = await json(url);
    return data.attributes.ohlcv_list;
  } catch (error) {
    if (error.status !== 429) throw error;
    await new Promise(resolve => setTimeout(resolve, 2500));
    const { data } = await json(url);
    return data.attributes.ohlcv_list;
  }
}, 120_000);

function containsToken(pool, mint) {
  const { base_token, quote_token } = pool.relationships;
  return [base_token.data.id, quote_token.data.id].includes(`solana_${mint}`);
}

async function poolHistory(trade) {
  const minute = Math.floor(trade.time / 60) * 60;
  const end = Math.min(Math.floor(Date.now() / 60000) * 60, minute + 31 * 60);
  const load = async (pool, reference) => {
    if (!containsToken(pool, trade.mint)) return null;
    const candles = (await marketCandles(`${pool.attributes.address}:${trade.mint}:${end}`))
      .filter(candle => candle[0] >= minute - 1800 && candle[0] <= minute + 1800)
      .sort((a, b) => a[0] - b[0]);
    if (!candles.length || (reference && !candles.some(candle => Math.abs(candle[0] - minute) <= 300))) return null;
    return { pool: pool.attributes.address, name: pool.attributes.name, candles, reference,
      baseMint: pool.relationships.base_token.data.id.replace(/^solana_/, ''),
      quoteMint: pool.relationships.quote_token.data.id.replace(/^solana_/, '') };
  };
  if (trade.pool) {
    try {
      const { data } = await json(`${gecko}/pools/${trade.pool}`);
      const exact = await load(data, false);
      if (exact) return exact;
    } catch (error) {
      if (![400, 404].includes(error.status)) throw error;
    }
  }
  const candidates = (await poolsByToken(trade.mint)).filter(pool => pool.attributes.address !== trade.pool
    && Date.parse(pool.attributes.pool_created_at) <= trade.time * 1000).slice(0, 3);
  for (const pool of candidates) {
    try {
      const reference = await load(pool, true);
      if (reference) return reference;
    } catch (error) {
      if (![400, 404].includes(error.status)) throw error;
    }
  }
  return null;
}

const loadMarket = memoize(async key => {
  const [signature, address] = key.split(':');
  const trade = parseTransaction(await getTransaction(signature), address, signature);
  if (trade?.kind !== 'trade' || !trade.time) return { state: 'unavailable' };
  let history;
  try {
    history = await poolHistory(trade);
  } catch (error) {
    if (!process.env.DMND_API_KEY || error.status !== 429) throw error;
  }
  if (!history && process.env.DMND_API_KEY) history = await dmndPoolHistory(trade);
  if (!history) return { state: 'unavailable' };
  const [hourly, supply] = await Promise.all([
    trade.quote === 'SOL' && trade.price != null
      ? solUsdDay(Math.floor(trade.time / 86400) * 86400).catch(() => ({})) : {},
    tokenSupply(trade.mint).catch(() => null),
  ]);
  const rate = hourly[Math.floor(trade.time / 3600) * 3600];
  if (!supply) throw Object.assign(new Error('Token supply unavailable'), { code: 'SUPPLY_UNAVAILABLE' });
  return { state: 'available', ...history,
    time: trade.time, mint: trade.mint, quote: 'USD', price: rate && !history.reference ? trade.price * rate : null, supply };
}, 120_000);

export const marketContext = (signature, address) => loadMarket(`${signature}:${address}`);

function dmnd(path, params) {
  return json(`https://api.dmnd.dev/api/v1${path}?${new URLSearchParams({ ...params, api_key: process.env.DMND_API_KEY })}`);
}

const iso = stamp => new Date(stamp * 1000).toISOString();
const dmndMinutes = memoize(async key => {
  const [mint, start, end] = key.split(':');
  const { data } = await dmnd(`/tokens/${mint}/ohlcv`, { resolution: '1m', from: iso(start), to: iso(end) });
  return data;
}, 120_000);

async function dmndPoolHistory(trade) {
  const minute = Math.floor(trade.time / 60) * 60;
  const end = Math.min(Math.floor(Date.now() / 60000) * 60, minute + 1860);
  const data = await dmndMinutes(`${trade.mint}:${minute - 1800}:${end}`);
  const complete = data.filter(row => ['open_usd', 'high_usd', 'low_usd', 'close_usd'].every(field => Number(row[field]) > 0));
  const nearest = complete.reduce((best, row) => {
    const distance = item => Math.abs(Date.parse(item.bucket) / 1000 - minute);
    return !best || distance(row) < distance(best) ? row : best;
  }, null);
  if (!nearest || Math.abs(Date.parse(nearest.bucket) / 1000 - minute) > 300) return null;
  const rows = complete.filter(row => row.pool_address === nearest.pool_address && row.quote_mint === nearest.quote_mint);
  return { pool: nearest.pool_address, name: `${trade.mint.slice(0, 5)}…${trade.mint.slice(-4)}`, reference: nearest.pool_address !== trade.pool,
    baseMint: trade.mint, quoteMint: nearest.quote_mint,
    candles: rows.map(row => [Date.parse(row.bucket) / 1000, ...['open_usd', 'high_usd', 'low_usd', 'close_usd'].map(field => Number(row[field]))]) };
}

const dmndCandles = memoize(async key => {
  const [pool, start, end] = key.split(':');
  const { data } = await dmnd(`/ohlcv/${pool}`, { resolution: '1s', from: iso(start), to: iso(end) });
  return data.map(({ bucket, open, high, low, close }) => [Date.parse(bucket) / 1000,
    Number(open), Number(high), Number(low), Number(close)])
    .filter(([stamp, ...prices]) => stamp >= Number(start) && stamp < Number(end)
      && prices.every(price => Number.isFinite(price) && price > 0))
    .sort((a, b) => a[0] - b[0]);
}, 120_000);

async function loadDmndSeconds(market, start, end) {
  const raw = await dmndCandles(`${market.pool}:${start}:${end}`);
  if (!raw.length) return { state: 'unavailable' };
  const inverted = market.mint === market.quoteMint;
  const pricingMint = inverted ? market.baseMint : market.quoteMint;
  let rateAt;
  if (pricingMint === SOL) {
    const startDay = Math.floor(start / 86400) * 86400;
    const endDay = Math.floor((end - 1) / 86400) * 86400;
    const daily = await Promise.all([...new Set([startDay, endDay])].map(solUsdDay));
    const hourly = Object.assign({}, ...daily);
    rateAt = stamp => hourly[Math.floor(stamp / 3600) * 3600];
  } else {
    // The free pool endpoint returns native quote prices. Use observed USD prices of the other pool token.
    const historyEnd = Math.min(Math.floor(Date.now() / 60000) * 60, Math.floor(market.time / 60) * 60 + 31 * 60);
    const minuteStart = Math.floor(start / 60) * 60;
    const minuteEnd = Math.min(Math.floor(Date.now() / 60000) * 60, Math.ceil(end / 60) * 60);
    const rows = minuteEnd > minuteStart ? await dmndMinutes(`${pricingMint}:${minuteStart}:${minuteEnd}`).catch(() => []) : [];
    const rates = new Map(rows.filter(row => Number(row.open_usd) > 0).map(row => [Date.parse(row.bucket) / 1000, Number(row.open_usd)]));
    if (raw.some(([stamp]) => !rates.has(Math.floor(stamp / 60) * 60))) {
      const minuteCandles = await marketCandles(`${market.pool}:${pricingMint}:${Math.max(historyEnd, Math.ceil(end / 60) * 60)}`).catch(() => []);
      for (const [stamp, open] of minuteCandles) if (!rates.has(stamp)) rates.set(stamp, open);
    }
    rateAt = stamp => rates.get(Math.floor(stamp / 60) * 60);
  }
  const candles = raw.flatMap(([stamp, open, high, low, close]) => {
    const rate = rateAt(stamp);
    if (!Number.isFinite(rate) || rate <= 0) return [];
    const prices = inverted ? [1 / open, 1 / low, 1 / high, 1 / close] : [open, high, low, close];
    return [[stamp, ...prices.map(price => price * rate)]];
  });
  return candles.length ? { state: 'available', candles, source: 'dmnd' } : { state: 'conversion_unavailable' };
}

const secondCandles = memoize(async key => {
  const [pool, mint, start, end] = key.split(':');
  const params = new URLSearchParams({ aggregate: '1', before_timestamp: Number(end) - 1, limit: end - start,
    currency: 'usd', token: mint });
  try {
    const { data } = await json(`https://pro-api.coingecko.com/api/v3/onchain/networks/solana/pools/${pool}/ohlcv/second?${params}`, {
      headers: { 'x-cg-pro-api-key': process.env.COINGECKO_PRO_API_KEY },
    });
    const candles = data.attributes.ohlcv_list.filter(([stamp, ...ohlc]) => stamp >= Number(start) && stamp < Number(end)
      && ohlc.length >= 4 && ohlc.slice(0, 4).every(value => Number.isFinite(value) && value > 0)).sort((a, b) => a[0] - b[0]);
    return candles.length ? { state: 'available', candles } : { state: 'unavailable' };
  } catch (error) {
    if ([401, 403].includes(error.status)) return { state: 'requires_access' };
    if ([400, 404, 422].includes(error.status)) return { state: 'unavailable' };
    throw error;
  }
}, 120_000);

export async function marketSeconds(signature, address, start, end) {
  if (!process.env.DMND_API_KEY && !process.env.COINGECKO_PRO_API_KEY) return { state: 'requires_access' };
  const market = await marketContext(signature, address);
  if (market.state !== 'available' || start < market.time - 1860 || end > market.time + 1860) {
    return { state: 'unavailable' };
  }
  if (process.env.DMND_API_KEY) {
    try {
      return await loadDmndSeconds(market, start, end);
    } catch (error) {
      if ([401, 403].includes(error.status)) return { state: 'invalid_key' };
      if ([400, 404, 422].includes(error.status)) return { state: 'unavailable' };
      throw error;
    }
  }
  return secondCandles(`${market.pool}:${market.mint}:${start}:${end}`);
}
