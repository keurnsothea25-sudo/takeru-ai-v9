const fs = require('fs');
const path = require('path');
const { DATA_DIR, getConfig } = require('../config');

let Pool = null;
try {
  Pool = require('pg').Pool;
} catch (e) {
  Pool = null;
}

const DB_FILE = path.join(DATA_DIR, 'persistent-state-v10.json');

let pgPool = null;
let pgConnected = false;
let memoryStore = null;

function defaultStore() {
  return {
    ai_model: {
      modelName: 'REAL_15M_BACKTEST_ENSEMBLE_V10',
      weights: {
        strategyBacktestWinRate: 2.50,
        entryZoneProximity: 2.65,
        zoneReactionStrength: 2.20,
        volatilityRrFit: 1.95,
        correlationAlignment: 1.85,
        newsSentimentAlign: 1.60,
        volumeMomentum: 1.75,
        sessionLiquidity: 1.55
      },
      bias: -1.35,
      sampleCount: 0,
      accuracy: 85.0,
      lastTrainedAt: null,
      nextTrainAt: null
    },
    backtested_strategies: [],
    auto_selected_strategies: [],
    trade_lock_state: {
      status: 'IDLE', // IDLE | LIMIT_PENDING | ACTIVE_IN_TRADE
      lockedTrade: null,
      lastClosedTrade: null,
      lastTelegramSignature: null,
      stats: {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        tp1Hits: 0,
        fullTpHits: 0,
        winRate: 0.0
      },
      updatedAt: new Date().toISOString()
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
    memoryStore = Object.assign(defaultStore(), raw);
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
         VALUES ('takeru_v10_state', $1::jsonb, NOW())
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

      const res = await pgPool.query(`SELECT payload FROM kv_mega_state WHERE key_name = 'takeru_v10_state'`);
      if (res.rows.length > 0 && res.rows[0].payload) {
        memoryStore = Object.assign(defaultStore(), res.rows[0].payload);
        fs.writeFileSync(DB_FILE, JSON.stringify(memoryStore, null, 2), 'utf8');
        console.log('[Supabase Cloud] Restored AI Model, Backtest Stats & Active Trades.');
      } else {
        await saveStore();
      }
      pgConnected = true;
    } catch (err) {
      pgConnected = false;
      console.warn('[Database] Using local JSON store:', err.message);
    }
  }
  return {
    pgConnected,
    dbType: pgConnected ? 'Supabase PostgreSQL Cloud' : 'Local Persistent JSON'
  };
}

module.exports = {
  initDatabaseEngine,
  loadStore,
  saveStore,
  getDbHealth: () => ({
    connected: true,
    pgConnected,
    dbType: pgConnected ? 'Supabase PostgreSQL' : 'Local JSON Store'
  })
};