const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const CONFIG_FILE = path.join(DATA_DIR, 'runtime-config.json');

const DEFAULT_CONFIG = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  renderExternalUrl: process.env.RENDER_EXTERNAL_URL || '',
  autoScanSeconds: 15,                     // ស្កេនរៀងរាល់ 15 វិនាទីម្ដង
  autoTrainIntervalMs: 2 * 60 * 60 * 1000, // Auto-Backtest & Train រៀងរាល់ 2 ម៉ោង
  minSignalConfidence: 75.0,               // ទម្លាក់ Signal ពេល Confidence >= 75% និងមាន Entry Zone ល្អ
  maxSlDollars: 6.0,
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '8569884229:AAFvXpiRt1TErXTfOa4ju2WIQuStUeJpvjI',
    chatId: process.env.TELEGRAM_CHAT_ID || '-1004290149125',
    enabled: true
  },
  supabase: {
    url: process.env.SUPABASE_URL || '',
    databaseUrl: process.env.DATABASE_URL || ''
  }
};

function getConfig() {
  let saved = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      saved = {};
    }
  }
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    telegram: {
      ...DEFAULT_CONFIG.telegram,
      ...(saved.telegram || {}),
      botToken: process.env.TELEGRAM_BOT_TOKEN || saved?.telegram?.botToken || DEFAULT_CONFIG.telegram.botToken,
      chatId: process.env.TELEGRAM_CHAT_ID || saved?.telegram?.chatId || DEFAULT_CONFIG.telegram.chatId
    },
    supabase: {
      ...DEFAULT_CONFIG.supabase,
      ...(saved.supabase || {}),
      url: process.env.SUPABASE_URL || saved?.supabase?.url || '',
      databaseUrl: process.env.DATABASE_URL || saved?.supabase?.databaseUrl || ''
    }
  };
}

function updateConfig(partial = {}) {
  const current = getConfig();
  const next = {
    ...current,
    minSignalConfidence: Number(partial.minSignalConfidence || current.minSignalConfidence || 75),
    telegram: {
      ...current.telegram,
      ...(partial.telegram || {})
    },
    supabase: {
      ...current.supabase,
      ...(partial.supabase || {})
    }
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = {
  DATA_DIR,
  getConfig,
  updateConfig
};