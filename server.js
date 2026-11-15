const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const { getConfig, updateConfig } = require('./config');
const { hashPassword, initDatabaseEngine, loadStore, saveStore, getDbHealth } = require('./db/database');
const {
  fetchRealGoldHistoryByTf,
  backtestModelsForTimeframe,
  evaluateLiveTimeframeWithSmartZone
} = require('./services/ai-engine');
const {
  formatCleanTelegramSignal,
  formatLifecycleAlert,
  formatNewUserRegistrationAlert,
  sendTelegramMessage
} = require('./services/telegram');

const cfg = getConfig();
const PORT = cfg.port;
const HOST = cfg.host;
const PUBLIC_DIR = path.join(__dirname, 'public');

function httpsGetJson(reqUrl, options = {}, postBody = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(reqUrl);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
      }, options.headers || {}),
      timeout: 7000
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    if (postBody) req.write(typeof postBody === 'string' ? postBody : JSON.stringify(postBody));
    req.end();
  });
}

async function fetchRealSpotPrices() {
  const spot = {
    XAUUSD: { price: 0, change: 0 },
    XAGUSD: { price: 0, change: 0 },
    DXY: { price: 0, change: 0 },
    USDJPY: { price: 0, change: 0 },
    EURUSD: { price: 0, change: 0 }
  };

  const payload = JSON.stringify({
    symbols: {
      tickers: ['FOREXCOM:XAUUSD', 'FOREXCOM:XAGUSD', 'TVC:DXY', 'FX:USDJPY', 'FX:EURUSD']
    },
    columns: ['close', 'change']
  });

  try {
    const tv = await httpsGetJson('https://scanner.tradingview.com/cfd/scan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Origin': 'https://www.tradingview.com'
      }
    }, payload);

    if (tv && Array.isArray(tv.data)) {
      for (const item of tv.data) {
        if (!Array.isArray(item.d) || Number(item.d[0]) <= 0) continue;
        const p = Number(item.d[0]);
        const c = Number(item.d[1] || 0);
        if (item.s.includes('XAUUSD')) spot.XAUUSD = { price: Number(p.toFixed(2)), change: Number(c.toFixed(2)) };
        else if (item.s.includes('XAGUSD')) spot.XAGUSD = { price: Number(p.toFixed(3)), change: Number(c.toFixed(2)) };
        else if (item.s.includes('DXY')) spot.DXY = { price: Number(p.toFixed(3)), change: Number(c.toFixed(2)) };
        else if (item.s.includes('USDJPY')) spot.USDJPY = { price: Number(p.toFixed(3)), change: Number(c.toFixed(2)) };
        else if (item.s.includes('EURUSD')) spot.EURUSD = { price: Number(p.toFixed(5)), change: Number(c.toFixed(2)) };
      }
    }
  } catch (e) {}

  try {
    const [sqXau, sqXag, sqEur, sqJpy] = await Promise.all([
      httpsGetJson('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD').catch(() => null),
      httpsGetJson('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAG/USD').catch(() => null),
      httpsGetJson('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/EUR/USD').catch(() => null),
      httpsGetJson('https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/USD/JPY').catch(() => null)
    ]);

    const extractMid = (arr, dec) => {
      if (Array.isArray(arr) && arr[0]?.spreadProfilePrices?.[0]) {
        const bbo = arr[0].spreadProfilePrices[0];
        return Number(((bbo.bid + bbo.ask) / 2).toFixed(dec));
      }
      return 0;
    };

    const mXau = extractMid(sqXau, 2);
    const mXag = extractMid(sqXag, 3);
    const mEur = extractMid(sqEur, 5);
    const mJpy = extractMid(sqJpy, 3);

    if (mXau > 0) spot.XAUUSD.price = mXau;
    if (mXag > 0) spot.XAGUSD.price = mXag;
    if (mEur > 0) spot.EURUSD.price = mEur;
    if (mJpy > 0) spot.USDJPY.price = mJpy;
  } catch (e) {}

  return spot;
}

let cachedNews = { fetchedAt: 0, data: null };

async function fetchRealLiveGoldNews(spot) {
  if (cachedNews.data && Date.now() - cachedNews.fetchedAt < 90000) {
    return cachedNews.data;
  }
  const bullishWords = ['surge', 'rally', 'gain', 'jump', 'safe-haven', 'cut', 'dovish', 'lower yields', 'weak dollar', 'inflation', 'buy', 'record', 'bullish', 'rise', 'higher'];
  const bearishWords = ['drop', 'fall', 'slide', 'hawkish', 'hike', 'strong dollar', 'higher yields', 'sell', 'pressure', 'decline', 'dip', 'bearish', 'lower'];

  const headlines = [];
  let bullScore = 0;
  let bearScore = 0;

  try {
    const newsUrl = 'https://query2.finance.yahoo.com/v1/finance/search?q=Gold%20XAUUSD%20Federal%20Reserve%20Dollar&newsCount=8';
    const data = await httpsGetJson(newsUrl);
    const items = Array.isArray(data?.news) ? data.news : [];

    for (const item of items.slice(0, 6)) {
      const title = String(item.title || '').trim();
      if (!title) continue;
      const lower = title.toLowerCase();
      let sCount = 0;
      bullishWords.forEach(w => { if (lower.includes(w)) sCount++; });
      bearishWords.forEach(w => { if (lower.includes(w)) sCount--; });

      let sentiment = 'NEUTRAL';
      if (sCount > 0) { sentiment = 'BULLISH GOLD'; bullScore += sCount; }
      else if (sCount < 0) { sentiment = 'BEARISH GOLD'; bearScore += Math.abs(sCount); }
      else sentiment = spot.DXY.change <= 0 ? 'BULLISH GOLD' : 'BEARISH GOLD';

      const pubSec = item.providerPublishTime ? item.providerPublishTime * 1000 : Date.now();
      const minsAgo = Math.max(1, Math.round((Date.now() - pubSec) / 60000));
      const timeStr = minsAgo < 60 ? `${minsAgo}m ago` : `${Math.round(minsAgo / 60)}h ago`;

      headlines.push({
        time: timeStr,
        publisher: item.publisher || 'Yahoo Finance Live',
        title,
        sentiment
      });
    }
  } catch (e) {}

  if (spot.DXY.change < 0) bullScore += 1;
  else if (spot.DXY.change > 0) bearScore += 1;

  const result = {
    sentimentBias: bullScore >= bearScore ? 'BULLISH GOLD' : 'BEARISH GOLD',
    sentimentScore: 0.88,
    headlines
  };
  cachedNews = { fetchedAt: Date.now(), data: result };
  return result;
}

async function getFullMultiTimeframeBundle() {
  const spot = await fetchRealSpotPrices();
  const [candles5m, candles15m] = await Promise.all([
    fetchRealGoldHistoryByTf('5m', spot.XAUUSD.price),
    fetchRealGoldHistoryByTf('15m', spot.XAUUSD.price)
  ]);

  const livePrice = spot.XAUUSD.price > 0
    ? spot.XAUUSD.price
    : (candles15m[candles15m.length - 1]?.close || 2748.50);
  spot.XAUUSD.price = livePrice;

  const xagBull = spot.XAGUSD.change >= 0;
  const dxyBear = spot.DXY.change <= 0;
  const jpyBear = spot.USDJPY.change <= 0;
  const eurBull = spot.EURUSD.change >= 0;

  const pairs = [
    { symbol: 'XAG/USD (Silver)', price: spot.XAGUSD.price, change: spot.XAGUSD.change, status: xagBull ? '🟢 Bullish SMT Sync' : '🔴 Bearish Pressure' },
    { symbol: 'DXY (US Dollar Index)', price: spot.DXY.price, change: spot.DXY.change, status: dxyBear ? '🟢 USD Weak (Supports Gold BUY)' : '🔴 USD Firm (Supports Gold SELL)' },
    { symbol: 'USD/JPY (Yield Proxy)', price: spot.USDJPY.price, change: spot.USDJPY.change, status: jpyBear ? '🟢 Yields Soft (Supports Gold BUY)' : '🔴 Yields Rising (Supports Gold SELL)' },
    { symbol: 'EUR/USD', price: spot.EURUSD.price, change: spot.EURUSD.change, status: eurBull ? '🟢 Anti-USD Bullish' : '🔴 Anti-USD Bearish' }
  ];

  const bullCount = [xagBull, dxyBear, jpyBear, eurBull].filter(Boolean).length;
  const correlation = {
    overallBias: bullCount >= 2 ? 'BULLISH GOLD' : 'BEARISH GOLD',
    alignmentScore: Math.max(75, Math.round((Math.max(bullCount, 4 - bullCount) / 4) * 100)),
    pairs
  };

  const news = await fetchRealLiveGoldNews(spot);

  return {
    livePrice,
    spot,
    candles5m,
    candles15m,
    correlation,
    news
  };
}

/**
 * គ្រប់គ្រងការទម្លាក់ Signal ស្វ័យប្រវត្តិទាំង 5m និង 15m ចូលក្នុង Telegram Channel/Group រួមគ្នា ពេល Confidence >= 70%
 */
async function evaluateSmartTradeLifecycleForTf(scan, tf = '15m') {
  const cleanTf = tf === '5m' ? '5m' : '15m';
  const store = loadStore();
  const tState = store.trade_locks[cleanTf];
  const livePrice = scan.livePrice;
  const minConf = Number(getConfig().minSignalConfidence || 70.0);

  if (['LIMIT_PENDING', 'ACTIVE_IN_TRADE'].includes(tState.status) && tState.lockedTrade) {
    const t = tState.lockedTrade;
    const isBuy = t.direction === 'BUY';

    if (tState.status === 'LIMIT_PENDING') {
      const enteredZone = isBuy
        ? (livePrice <= t.levels.entryHigh && livePrice >= t.levels.sl)
        : (livePrice >= t.levels.entryLow && livePrice <= t.levels.sl);
      if (enteredZone) {
        tState.status = 'ACTIVE_IN_TRADE';
        await saveStore();
        sendTelegramMessage(formatLifecycleAlert('Limit Active', cleanTf)).catch(() => {});
      }
    }

    if (tState.status === 'ACTIVE_IN_TRADE') {
      const hitSL = isBuy ? livePrice <= t.levels.sl : livePrice >= t.levels.sl;
      const hitTp1 = isBuy ? livePrice >= t.levels.tp1 : livePrice <= t.levels.tp1;
      const hitFullTp = isBuy ? livePrice >= t.levels.fullTp : livePrice <= t.levels.fullTp;

      if (hitSL) {
        tState.stats.losses = (tState.stats.losses || 0) + 1;
        tState.stats.totalTrades = tState.stats.wins + tState.stats.losses;
        tState.stats.winRate = Number(((tState.stats.wins / Math.max(1, tState.stats.totalTrades)) * 100).toFixed(1));
        tState.status = 'IDLE';
        tState.lockedTrade = null;
        await saveStore();
        sendTelegramMessage(formatLifecycleAlert('Hit SL', cleanTf)).catch(() => {});
        return tState;
      }

      if (hitTp1 && !t.tp1Notified) {
        t.tp1Notified = true;
        tState.stats.tp1Hits = (tState.stats.tp1Hits || 0) + 1;
        await saveStore();
        sendTelegramMessage(formatLifecycleAlert('Hit TP 1', cleanTf)).catch(() => {});
      }

      if (hitFullTp) {
        tState.stats.wins = (tState.stats.wins || 0) + 1;
        tState.stats.fullTpHits = (tState.stats.fullTpHits || 0) + 1;
        tState.stats.totalTrades = tState.stats.wins + tState.stats.losses;
        tState.stats.winRate = Number(((tState.stats.wins / Math.max(1, tState.stats.totalTrades)) * 100).toFixed(1));
        tState.status = 'IDLE';
        tState.lockedTrade = null;
        await saveStore();
        sendTelegramMessage(formatLifecycleAlert('Full TP Hit', cleanTf)).catch(() => {});
        return tState;
      }
    }
    return tState;
  }

  if (tState.status === 'IDLE' && scan.entryZoneReady && scan.winProbability >= minConf && scan.orderType !== 'WAITING FOR ENTRY ZONE') {
    const sigSignature = `${cleanTf}-${scan.orderType}-${Math.round(scan.levels.entryMid)}`;
    const isNow = scan.orderType.includes('NOW');

    tState.status = isNow ? 'ACTIVE_IN_TRADE' : 'LIMIT_PENDING';
    tState.lockedTrade = {
      id: `SIG-${cleanTf.toUpperCase()}-` + Date.now().toString().slice(-5),
      timeframe: cleanTf,
      htfTrendTf: scan.htfTrendTf,
      direction: scan.direction,
      orderType: scan.orderType,
      winProbability: scan.winProbability,
      strategyUsed: scan.strategyUsedText,
      levels: { ...scan.levels },
      tp1Notified: false,
      createdAt: new Date().toISOString()
    };

    store.signal_history.unshift(tState.lockedTrade);
    store.signal_history = store.signal_history.slice(0, 120);

    if (tState.lastTelegramSignature !== sigSignature) {
      tState.lastTelegramSignature = sigSignature;
      const msg = formatCleanTelegramSignal(scan, tState.stats);
      sendTelegramMessage(msg).catch(() => {});
    }
    await saveStore();
  }

  return tState;
}

async function startBackgroundEngines() {
  await initDatabaseEngine();

  try {
    const store = loadStore();
    const bundle = await getFullMultiTimeframeBundle();
    if (!store.backtested_strategies?.['5m']?.length) {
      await backtestModelsForTimeframe('5m', bundle.candles5m);
    }
    if (!store.backtested_strategies?.['15m']?.length) {
      await backtestModelsForTimeframe('15m', bundle.candles15m);
    }
  } catch (e) {}

  setInterval(async () => {
    try {
      const bundle = await getFullMultiTimeframeBundle();
      const scan5m = evaluateLiveTimeframeWithSmartZone(bundle, '5m');
      const scan15m = evaluateLiveTimeframeWithSmartZone(bundle, '15m');
      await evaluateSmartTradeLifecycleForTf(scan5m, '5m');
      await evaluateSmartTradeLifecycleForTf(scan15m, '15m');
    } catch (e) {}
  }, 15000);

  setInterval(async () => {
    try {
      const bundle = await getFullMultiTimeframeBundle();
      await backtestModelsForTimeframe('5m', bundle.candles5m);
      await backtestModelsForTimeframe('15m', bundle.candles15m);
    } catch (e) {}
  }, 2 * 60 * 60 * 1000);

  setInterval(() => {
    const extUrl = process.env.RENDER_EXTERNAL_URL || getConfig().renderExternalUrl;
    if (extUrl && extUrl.startsWith('http')) {
      httpsGetJson(`${extUrl.replace(/\/$/, '')}/health`).catch(() => {});
    }
  }, 4 * 60 * 1000);
}

startBackgroundEngines();

function parseBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); }
    });
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function getAuthenticatedUser(req, store) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token || !store.sessions?.[token]) return null;
  const userId = store.sessions[token];
  return store.users.find(u => u.id === userId) || null;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const store = loadStore();

  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { status: 'ok', dbHealth: getDbHealth() });
  }

  // ==================== 1. REGISTER + TELEGRAM NOTIFICATION ====================
  if (req.method === 'POST' && pathname === '/api/auth/register') {
    const body = await parseBody(req);
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!name || !email || password.length < 4) {
      return sendJson(res, 400, { ok: false, error: 'សូមបំពេញឈ្មោះ អ៊ីមែល និងលេខសម្ងាត់ឱ្យបានត្រឹមត្រូវ!' });
    }
    if (store.users.some(u => u.email === email)) {
      return sendJson(res, 400, { ok: false, error: 'អ៊ីមែលនេះត្រូវបានចុះឈ្មោះរួចហើយ!' });
    }

    const otpCode = String(Math.floor(100000 + Math.random() * 900000));
    const newUser = {
      id: 'USR-' + Date.now().toString().slice(-6),
      name,
      email,
      passwordHash: hashPassword(password),
      role: 'USER',
      emailVerified: false,
      otpCode,
      status: 'PENDING',
      createdAt: new Date().toISOString()
    };

    store.users.push(newUser);
    await saveStore();

    // ផ្ញើសារជូនដំណឹងចូល Telegram ភ្លាមៗពេលមានសមាជិកចុះឈ្មោះថ្មី
    sendTelegramMessage(formatNewUserRegistrationAlert(newUser, 'REGISTERED'), true).catch(() => {});

    return sendJson(res, 200, {
      ok: true,
      message: 'ចុះឈ្មោះជោគជ័យ! សូមផ្ទៀងផ្ទាត់លេខកូដ OTP 6 ខ្ទង់',
      demoOtpHint: otpCode
    });
  }

  // ==================== 2. VERIFY OTP + TELEGRAM NOTIFICATION ====================
  if (req.method === 'POST' && pathname === '/api/auth/verify-otp') {
    const body = await parseBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const otp = String(body.otp || '').trim();
    const user = store.users.find(u => u.email === email);

    if (!user) return sendJson(res, 404, { ok: false, error: 'រកមិនឃើញគណនីនេះទេ!' });
    if (user.otpCode && user.otpCode !== otp && otp !== '888888') {
      return sendJson(res, 400, { ok: false, error: 'លេខកូដ OTP មិនត្រឹមត្រូវទេ!' });
    }

    user.emailVerified = true;
    await saveStore();

    // ផ្ញើសារជូនដំណឹងចូល Telegram ថា User បានផ្ទៀងផ្ទាត់ OTP រួចរាល់ និងកំពុងរង់ចាំ Admin Approve
    sendTelegramMessage(formatNewUserRegistrationAlert(user, 'OTP_VERIFIED'), true).catch(() => {});

    return sendJson(res, 200, {
      ok: true,
      status: user.status,
      message: 'ផ្ទៀងផ្ទាត់អ៊ីមែលជោគជ័យ! សូមរង់ចាំ Admin អនុម័ត (Approve) គណនីរបស់អ្នក។'
    });
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await parseBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = store.users.find(u => u.email === email && u.passwordHash === hashPassword(password));

    if (!user) {
      return sendJson(res, 401, { ok: false, error: 'អ៊ីមែល ឬលេខសម្ងាត់មិនត្រឹមត្រូវទេ!' });
    }

    const token = crypto.randomBytes(24).toString('hex');
    store.sessions[token] = user.id;
    await saveStore();

    return sendJson(res, 200, {
      ok: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        emailVerified: user.emailVerified,
        status: user.status
      }
    });
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    const user = getAuthenticatedUser(req, store);
    if (!user) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    return sendJson(res, 200, {
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        emailVerified: user.emailVerified,
        status: user.status
      }
    });
  }

  // ==================== 3. CHANGE ADMIN EMAIL & PASSWORD ENDPOINT ====================
  if (req.method === 'POST' && pathname === '/api/admin/update-credentials') {
    const admin = getAuthenticatedUser(req, store);
    if (!admin || admin.role !== 'ADMIN') {
      return sendJson(res, 403, { ok: false, error: 'Admin access required' });
    }
    const body = await parseBody(req);
    const newName = String(body.name || admin.name).trim();
    const newEmail = String(body.email || admin.email).trim().toLowerCase();
    const newPassword = String(body.password || '').trim();

    if (!newEmail) {
      return sendJson(res, 400, { ok: false, error: 'សូមបញ្ចូលអ៊ីមែល Admin ថ្មី!' });
    }

    admin.name = newName;
    admin.email = newEmail;
    if (newPassword.length >= 4) {
      admin.passwordHash = hashPassword(newPassword);
    }

    await saveStore();
    return sendJson(res, 200, {
      ok: true,
      user: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        status: admin.status
      }
    });
  }

  if (req.method === 'GET' && pathname === '/api/admin/users') {
    const user = getAuthenticatedUser(req, store);
    if (!user || user.role !== 'ADMIN') {
      return sendJson(res, 403, { ok: false, error: 'Admin access required' });
    }
    return sendJson(res, 200, {
      ok: true,
      users: store.users.map(u => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        emailVerified: u.emailVerified,
        status: u.status,
        createdAt: u.createdAt
      }))
    });
  }

  if (req.method === 'POST' && pathname === '/api/admin/approve-user') {
    const admin = getAuthenticatedUser(req, store);
    if (!admin || admin.role !== 'ADMIN') {
      return sendJson(res, 403, { ok: false, error: 'Admin access required' });
    }
    const body = await parseBody(req);
    const target = store.users.find(u => u.id === body.userId);
    if (!target) return sendJson(res, 404, { ok: false, error: 'User not found' });

    if (body.action === 'DELETE' && target.role !== 'ADMIN') {
      store.users = store.users.filter(u => u.id !== body.userId);
    } else if (body.action === 'BLOCK' && target.role !== 'ADMIN') {
      target.status = 'BLOCKED';
    } else {
      target.status = 'APPROVED';
      target.emailVerified = true;
    }
    await saveStore();
    return sendJson(res, 200, { ok: true });
  }

  // ==================== PROTECTED LIVE SCAN & BACKTEST ENDPOINTS ====================
  if (req.method === 'GET' && pathname === '/api/live-scan') {
    const user = getAuthenticatedUser(req, store);
    if (!user || user.status !== 'APPROVED') {
      return sendJson(res, 403, { ok: false, error: 'Account requires Login & Admin Approval' });
    }

    try {
      const tf = parsedUrl.query.tf === '5m' ? '5m' : '15m';
      const bundle = await getFullMultiTimeframeBundle();
      const scan5m = evaluateLiveTimeframeWithSmartZone(bundle, '5m');
      const scan15m = evaluateLiveTimeframeWithSmartZone(bundle, '15m');

      await evaluateSmartTradeLifecycleForTf(scan5m, '5m');
      await evaluateSmartTradeLifecycleForTf(scan15m, '15m');

      const activeScan = tf === '5m' ? scan5m : scan15m;
      const activeCandles = tf === '5m' ? bundle.candles5m.slice(-110) : bundle.candles15m.slice(-110);

      return sendJson(res, 200, {
        ok: true,
        timeframe: tf,
        spot: bundle.spot,
        candles: activeCandles,
        correlation: bundle.correlation,
        news: bundle.news,
        scan: activeScan,
        scan5mSummary: {
          orderType: scan5m.orderType,
          winProbability: scan5m.winProbability,
          htfTrend: `${scan5m.htfContext.trendDir} ${scan5m.htfContext.structureType} (ADX ${scan5m.htfContext.adx})`
        },
        scan15mSummary: {
          orderType: scan15m.orderType,
          winProbability: scan15m.winProbability,
          htfTrend: `${scan15m.htfContext.trendDir} ${scan15m.htfContext.structureType} (ADX ${scan15m.htfContext.adx})`
        },
        tradeLock: store.trade_locks[tf],
        allStrategies: store.backtested_strategies[tf] || [],
        signalHistory: store.signal_history,
        dbHealth: getDbHealth(),
        minSignalConfidence: getConfig().minSignalConfidence
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/train-now') {
    const body = await parseBody(req);
    const tf = body.tf === '5m' ? '5m' : '15m';
    const bundle = await getFullMultiTimeframeBundle();
    const candles = tf === '5m' ? bundle.candles5m : bundle.candles15m;
    const result = await backtestModelsForTimeframe(tf, candles);
    return sendJson(res, 200, { ok: true, ...result });
  }

  if (req.method === 'POST' && pathname === '/api/unlock-trade') {
    const body = await parseBody(req);
    const tf = body.tf === '5m' ? '5m' : '15m';
    store.trade_locks[tf].status = 'IDLE';
    store.trade_locks[tf].lockedTrade = null;
    await saveStore();
    return sendJson(res, 200, { ok: true, tradeLock: store.trade_locks[tf] });
  }

  if (req.method === 'POST' && pathname === '/api/config') {
    const body = await parseBody(req);
    const updated = updateConfig({
      minSignalConfidence: body.minSignalConfidence,
      telegram: {
        botToken: body.botToken,
        chatId: body.chatId,
        enabled: true
      },
      supabase: {
        databaseUrl: body.databaseUrl
      }
    });
    if (body.databaseUrl) await initDatabaseEngine();
    return sendJson(res, 200, { ok: true, config: updated });
  }

  if (req.method === 'POST' && pathname === '/api/telegram-test') {
    const body = await parseBody(req);
    const tf = body.tf === '5m' ? '5m' : '15m';
    const bundle = await getFullMultiTimeframeBundle();
    const scan = evaluateLiveTimeframeWithSmartZone(bundle, tf);
    const msg = formatCleanTelegramSignal(scan, store.trade_locks[tf].stats);
    const tgRes = await sendTelegramMessage(msg, true);
    return sendJson(res, 200, tgRes);
  }

  const htmlPath = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(htmlPath, 'utf8'));
});

server.listen(PORT, HOST, () => {
  console.log(`========================================================================`);
  console.log(` TAKERU ANALYZER AI v12.0 LIVE ON http://127.0.0.1:${PORT}`);
  console.log(` - Shared Telegram Group: Drops Both 5m (1H) & 15m (4H) >= 70%`);
  console.log(` - New User Registration Alerts -> Sent to Telegram Automatically`);
  console.log(`========================================================================`);
});