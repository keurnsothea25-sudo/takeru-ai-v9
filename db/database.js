const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, getConfig } = require('../config');

let Pool = null;
try {
  Pool = require('pg').Pool;
} catch (e) {
  Pool = null;
}

const DB_FILE = path.join(DATA_DIR, 'persistent-state-v12.json');

let pgPool = null;
let pgConnected = false;
let memoryStore = null;

function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw) + '_takeru_salt').digest('hex');
}

function createEmptyTfLock() {
  return {
    status: 'IDLE', // IDLE | LIMIT_PENDING | ACTIVE_IN_TRADE
    lockedTrade: null,
    lastTelegramSignature: null,
    stats: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      tp1Hits: 0,
      fullTpHits: 0,
      winRate: 0.0
    }
  };
}

function defaultStore() {
  return {
    users: [
      {
        id: 'USR-ADMIN-01',
        name: 'Takeru Master Admin',
        email: 'keurnsothea25@gmail.com',
        passwordHash: hashPassword('Thea2402'),
        role: 'ADMIN',
        emailVerified: true,
        status: 'APPROVED',
        createdAt: new Date().toISOString()
      }
    ],
    sessions: {},
    ai_models: {
      '5m': {
        modelName: 'REAL_5M_1HTREND_V12',
        weights: {
          strategyBacktestWinRate: 2.55,
          entryZoneProximity: 2.65,
          zoneReactionStrength: 2.25,
          volatilityRrFit: 1.95,
          correlationAlignment: 1.85,
          newsSentimentAlign: 1.60,
          volumeMomentum: 1.80,
          sessionLiquidity: 1.65
        },
        bias: -1.35,
        sampleCount: 0,
        accuracy: 84.5,
        lastTrainedAt: null
      },
      '15m': {
        modelName: 'REAL_15M_4HTREND_V12',
        weights: {
          strategyBacktestWinRate: 2.55,
          entryZoneProximity: 2.65,
          zoneReactionStrength: 2.25,
          volatilityRrFit: 1.95,
          correlationAlignment: 1.85,
          newsSentimentAlign: 1.60,
          volumeMomentum: 1.80,
          sessionLiquidity: 1.65
        },
        bias: -1.35,
        sampleCount: 0,
        accuracy: 86.0,
        lastTrainedAt: null
      }
    },
    backtested_strategies: {
      '5m': [],
      '15m': []
    },
    auto_selected_strategies: {
      '5m': [],
      '15m': []
    },
    trade_locks: {
      '5m': createEmptyTfLock(),
      '15m': createEmptyTfLock()
    },
    signal_history: []
  };
}

function loadStore() {
  if (memoryStore) return memoryStore;
  if (!fs.existsSync(DB_FILE)) {
    memoryStore = defaultStore();
    fs.writeFileSync(DB_FILE, JSON.stringify(memoryStore, null, 2), 'utf8');
    return memoryStore;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const def = defaultStore();
    memoryStore = {
      ...def,
      ...raw,
      users: Array.isArray(raw.users) && raw.users.length > 0 ? raw.users : def.users,
      sessions: raw.sessions || {},
      ai_models: { ...def.ai_models, ...(raw.ai_models || {}) },
      backtested_strategies: { ...def.backtested_strategies, ...(raw.backtested_strategies || {}) },
      auto_selected_strategies: { ...def.auto_selected_strategies, ...(raw.auto_selected_strategies || {}) },
      trade_locks: {
        '5m': raw.trade_locks?.['5m'] || createEmptyTfLock(),
        '15m': raw.trade_locks?.['15m'] || createEmptyTfLock()
      },
      signal_history: Array.isArray(raw.signal_history) ? raw.signal_history : []
    };
    return memoryStore;
  } catch (e) {
    memoryStore = defaultStore();
    return memoryStore;
  }
}

async function saveStore() {
  const store = loadStore();
  fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2), 'utf8');
  if (pgConnected && pgPool) {
    try {
      await pgPool.query(
        `INSERT INTO kv_mega_state (key_name, payload, updated_at)
         VALUES ('takeru_v12_state', $1::jsonb, NOW())
         ON CONFLICT (key_name) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
        [JSON.stringify(store)]
      );
    } catch (e) {}
  }
  return store;
}

async function initDatabaseEngine() {
  loadStore();
  const cfg = getConfig();
  const dbUrl = cfg.supabase.databaseUrl || process.env.DATABASE_URL || '';

  if (Pool && dbUrl) {
    try {
      pgPool = new Pool({
        connectionString: dbUrl,
        ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
      });
      await pgPool.query('SELECT 1');
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS kv_mega_state (
          key_name VARCHAR(64) PRIMARY KEY,
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      const res = await pgPool.query(`SELECT payload FROM kv_mega_state WHERE key_name = 'takeru_v12_state'`);
      if (res.rows.length > 0 && res.rows[0].payload) {
        const def = defaultStore();
        memoryStore = { ...def, ...res.rows[0].payload };
        fs.writeFileSync(DB_FILE, JSON.stringify(memoryStore, null, 2), 'utf8');
      } else {
        await saveStore();
      }
      pgConnected = true;
    } catch (err) {
      pgConnected = false;
    }
  }
  return {
    pgConnected,
    dbType: pgConnected ? 'Supabase PostgreSQL Cloud' : 'Local Persistent JSON'
  };
}

module.exports = {
  hashPassword,
  initDatabaseEngine,
  loadStore,
  saveStore,
  getDbHealth: () => ({
    connected: true,
    pgConnected,
    dbType: pgConnected ? 'Supabase PostgreSQL' : 'Local JSON Store'
  })
};