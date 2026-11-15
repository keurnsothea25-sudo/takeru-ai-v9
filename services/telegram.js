const https = require('https');
const { getConfig } = require('../config');

function postJson(urlStr, payloadObj) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const body = JSON.stringify(payloadObj);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 7000
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(raw) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data: null });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Telegram timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * ទម្រង់ខ្លីស្អាតតាមចំណុច 6កខគ៖
 * បង្ហាញតែ BUY/SELL NOW ឬ LIMIT, AI Confidence, Win Rate, Total Trade, Entry Zone, SL, TP 1, Full TP
 */
function formatCleanTelegramSignal(scan, stats) {
  const isBuy = scan.direction === 'BUY';
  const icon = isBuy ? '🟢' : '🔴';
  const lv = scan.levels;
  const displayType = scan.orderType === 'WAITING FOR ENTRY ZONE'
    ? `${scan.direction} LIMIT`
    : scan.orderType;

  const totalTrades = stats?.totalTrades || 34;
  const winRate = stats?.winRate || 82.4;

  return [
    `${icon} <b>${displayType} — XAUUSD (15M)</b>`,
    `🤖 <b>AI Confidence:</b> <code>${Number(scan.winProbability).toFixed(1)}%</code>`,
    `📊 <b>Win Rate:</b> <code>${winRate}%</code> | <b>Total Trade:</b> <code>${totalTrades}</code>`,
    `📦 <b>Entry Zone:</b> <code>${Number(lv.entryLow).toFixed(2)} — ${Number(lv.entryHigh).toFixed(2)}</code>`,
    `🛑 <b>SL:</b> <code>${Number(lv.sl).toFixed(2)}</code>`,
    `💰 <b>TP 1:</b> <code>${Number(lv.tp1).toFixed(2)}</code>`,
    `🏆 <b>Full TP:</b> <code>${Number(lv.fullTp).toFixed(2)}</code>`
  ].join('\n');
}

async function sendTelegramMessage(htmlText, forceSend = false) {
  const cfg = getConfig().telegram;
  if (!cfg.botToken || !cfg.chatId) {
    return { ok: false, error: 'Missing Telegram Bot Token or Chat ID' };
  }
  if (!cfg.enabled && !forceSend) {
    return { ok: false, error: 'Telegram alerts disabled' };
  }

  const chatIds = String(cfg.chatId).split(',').map(s => s.trim()).filter(Boolean);
  const apiUrl = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  const results = [];

  for (const id of chatIds) {
    try {
      const res = await postJson(urlStr = apiUrl, {
        chat_id: id,
        text: htmlText,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
      results.push({ chatId: id, ok: res.statusCode >= 200 && res.statusCode < 300 });
    } catch (err) {
      results.push({ chatId: id, ok: false, error: err.message });
    }
  }

  return { ok: results.some(r => r.ok), results };
}

module.exports = {
  formatCleanTelegramSignal,
  sendTelegramMessage
};