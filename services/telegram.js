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
 * បង្ហាញតែប្រភេទ (BUY NOW / SELL NOW / BUY LIMIT / SELL LIMIT), Entry, SL, TP 1 (1:1) និង Full TP (1:2 RR)
 * គ្មានបង្ហាញ detail ស៊ាំញ៉ាំផ្សេងឡើយ។
 */
function formatMinimalTelegramSignal(scan) {
  const isBuy = scan.direction === 'BUY';
  const icon = isBuy ? '🟢' : '🔴';
  const lv = scan.levels;

  return [
    `${icon} <b>${scan.orderType} — XAUUSD</b>`,
    `Entry: <code>${Number(lv.entry).toFixed(2)}</code>`,
    `SL: <code>${Number(lv.sl).toFixed(2)}</code>`,
    `TP 1: <code>${Number(lv.tp1).toFixed(2)}</code>`,
    `Full TP: <code>${Number(lv.fullTp).toFixed(2)}</code>`
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
      const res = await postJson(apiUrl, {
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
  formatMinimalTelegramSignal,
  sendTelegramMessage
};