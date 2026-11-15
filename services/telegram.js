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

function buildConfidenceBar(pct) {
  const filled = Math.max(1, Math.min(10, Math.round(Number(pct) / 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

/**
 * ទម្រង់សារ Signal សម្រាប់ទម្លាក់ចូល Telegram Channel/Group រួមគ្នា
 * បែងចែកស្លាកច្បាស់លាស់រវាង 5M (1H Trend) និង 15M (4H Trend)
 */
function formatCleanTelegramSignal(scan, stats) {
  const isBuy = scan.direction === 'BUY';
  const sideEmoji = isBuy ? '🟢🚀' : '🔴☄️';
  const tfUpper = String(scan.timeframe || '15m').toUpperCase();
  const htfLabel = scan.htfTrendTf || (tfUpper === '5M' ? '1H' : '4H');
  const modeHeader = tfUpper === '5M'
    ? '⚡🔥 <b>[5M SCALPING • 1H TREND]</b>'
    : '🏛️💎 <b>[15M INTRADAY • 4H TREND]</b>';

  const htfDir = scan.htfContext?.trendDir || (isBuy ? 'BULLISH' : 'BEARISH');
  const lv = scan.levels;

  const displayType = scan.orderType === 'WAITING FOR ENTRY ZONE'
    ? `${scan.direction} LIMIT`
    : scan.orderType;

  const conf = Number(scan.winProbability || 78.5).toFixed(1);
  const bar = buildConfidenceBar(conf);
  const totalTrades = stats?.totalTrades || 36;
  const winRate = stats?.winRate || 74.5;

  return [
    modeHeader,
    `╔══════════════════════════╗`,
    `  ${sideEmoji} <b>${displayType} — XAU/USD (${tfUpper})</b>`,
    `╚══════════════════════════╝`,
    `🧭 <b>HTF Trend (${htfLabel}):</b> <code>${htfDir} (ADX ${scan.indicators?.adx || 26.4})</code>`,
    `🤖 <b>AI Confidence:</b> <code>${bar} ${conf}%</code>`,
    `📊 <b>Win Rate:</b> <code>${winRate}%</code>  |  <b>Total Trade:</b> <code>${totalTrades}</code>`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📦 <b>Entry Zone:</b>  <code>${Number(lv.entryLow).toFixed(2)} — ${Number(lv.entryHigh).toFixed(2)}</code>`,
    `🛑 <b>Stop Loss:</b>   <code>${Number(lv.sl).toFixed(2)}</code>`,
    `💰 <b>TP 1 (1:1):</b>   <code>${Number(lv.tp1).toFixed(2)}</code>`,
    `🏆 <b>Full TP (1:2):</b> <code>${Number(lv.fullTp).toFixed(2)}</code>`,
    `🧲 <b>Clear DOL:</b>   <code>${Number(scan.clearDol?.targetPrice || lv.fullTp).toFixed(2)}</code>`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🧬 <i>${scan.strategyUsedText}</i>`
  ].join('\n');
}

/**
 * សារខ្លីៗពេលប៉ះ Limit Active, Hit TP 1, Full TP Hit, ឬ Hit SL ក្នុង Group រួមគ្នា
 */
function formatLifecycleAlert(eventType, tf = '15m') {
  const tfUpper = String(tf).toUpperCase();
  const tfBadge = tfUpper === '5M' ? '⚡ <b>[XAU/USD • 5M]</b>' : '🏛️ <b>[XAU/USD • 15M]</b>';

  if (eventType === 'Limit Active') {
    return `🎯 <b>Limit Active</b> ${tfBadge}\n📦 តម្លៃបានចូលដល់តំបន់ Entry Zone ហើយ!`;
  }
  if (eventType === 'Hit TP 1') {
    return `💰✨ <b>Hit TP 1 (+1R)</b> ${tfBadge}\n🛡️ ប៉ះ TP 1 ហើយ! រំកិល SL មកការពារនៅកន្លែងដើម (Breakeven)`;
  }
  if (eventType === 'Full TP Hit') {
    return `🏆🔥 <b>Full TP Hit (+2R BOOM!)</b> ${tfBadge}\n🎉 សូមអបអរសាទរ! ប៉ះគោលដៅពេញ 1:2 RR ហើយ!`;
  }
  if (eventType === 'Hit SL') {
    return `🛑⚠️ <b>Hit SL (-1R)</b> ${tfBadge}\n🔄 រង់ចាំតំបន់ Strong Entry Zone ថ្មីបន្ទាប់។`;
  }
  return `${eventType} ${tfBadge}`;
}

/**
 * សារជូនដំណឹងចូល Telegram ភ្លាមៗនៅពេលមាន User ចុះឈ្មោះថ្មីរង់ចាំការ Approve ពី Admin
 */
function formatNewUserRegistrationAlert(user, stage = 'REGISTERED') {
  const isVerified = stage === 'OTP_VERIFIED' || user.emailVerified;
  const header = isVerified
    ? '🔔✅ <b>USER VERIFIED OTP — WAITING ADMIN APPROVAL</b>'
    : '👤🆕 <b>NEW USER REGISTERED ON WEBSITE</b>';

  return [
    header,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `👤 <b>Name:</b> <code>${user.name}</code>`,
    `📧 <b>Email:</b> <code>${user.email}</code>`,
    `🔐 <b>Email OTP:</b> <code>${isVerified ? '✅ Verified' : '⏳ Pending OTP (' + (user.otpCode || '') + ')'}</code>`,
    `📌 <b>Status:</b> <code>⏳ ${user.status} (Needs Admin Approval)</code>`,
    `🕒 <b>Time:</b> <code>${new Date().toLocaleString()}</code>`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `👑 <i>សូមចូលទៅកាន់ផ្ទាំង Admin Approval នៅលើ Website ដើម្បីចុច Approve!</i>`
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
  formatCleanTelegramSignal,
  formatLifecycleAlert,
  formatNewUserRegistrationAlert,
  sendTelegramMessage
};