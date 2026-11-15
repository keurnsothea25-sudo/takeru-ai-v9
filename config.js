const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const CONFIG_FILE = path.join(DATA_DIR, 'runtime-config-v12.json');

const DEFAULT_CONFIG = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  renderExternalUrl: process.env.RENDER_EXTERNAL_URL || '',
  autoScanSeconds: 15,
  autoTrainIntervalMs: 2 * 60 * 60 * 1000,
  minSignalConfidence: 70.0, // Auto-drop ទាំង 5m និង 15m ពេល Confidence >= 70%
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '8569884229:AAFvXpiRt1TErXTfOa4ju2WIQuStUeJpvjI',
    chatId: process.env.TELEGRAM_CHAT_ID || '-1004290149125',
    enabled: true
  },
  supabase: {
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
    minSignalConfidence: Number(saved.minSignalConfidence ?? DEFAULT_CONFIG.minSignalConfidence),
    telegram: {
      ...DEFAULT_CONFIG.telegram,
      ...(saved.telegram || {}),
      botToken: process.env.TELEGRAM_BOT_TOKEN || saved?.telegram?.botToken || DEFAULT_CONFIG.telegram.botToken,
      chatId: process.env.TELEGRAM_CHAT_ID || saved?.telegram?.chatId || DEFAULT_CONFIG.telegram.chatId
    },
    supabase: {
      ...DEFAULT_CONFIG.supabase,
      ...(saved.supabase || {}),
      databaseUrl: process.env.DATABASE_URL || saved?.supabase?.databaseUrl || ''
    }
  };
}

function updateConfig(partial = {}) {
  const current = getConfig();
  const next = {
    ...current,
    minSignalConfidence: Number(partial.minSignalConfidence ?? current.minSignalConfidence ?? 70.0),
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
