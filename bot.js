'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// StableScan Bot — Binance stable crypto trend-following bot
// Pairs   : BTCUSDT · ETHUSDT · SOLUSDT
// Strategy: 50 EMA trend filter + swing structure pullback entries
// Mode    : Paper by default — set PAPER_MODE=false to go live
// ══════════════════════════════════════════════════════════════════════════════

const https = require('https');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');

// ── Environment ───────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN   || '';
const CHAT_ID        = process.env.CHAT_ID          || '';
const FIREBASE_CREDS = process.env.FIREBASE_CREDENTIALS || '{}';
const PAPER_MODE_ENV = process.env.PAPER_MODE !== 'false';   // default: true
const POSITION_SIZE  = parseFloat(process.env.POSITION_SIZE || '100'); // USDT

// ── Trading config ────────────────────────────────────────────────────────────
const PAIRS         = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const MAX_POSITIONS = 3;
const SCAN_MS       = 15 * 60 * 1000;   // scan every 15 min
const MONITOR_MS    =      60 * 1000;   // monitor open positions every 1 min
const EMA_PERIOD    = 50;
const RSI_PERIOD    = 14;
const CANDLE_LIMIT  = 100;              // last 100 × 1h candles from Binance

// Per-pair SL and display config
const PAIR_CFG = {
  BTCUSDT: { slPct: 0.03, trailFloor: 0.01, dec: 2, label: 'BTC/USDT' },
  ETHUSDT: { slPct: 0.03, trailFloor: 0.01, dec: 2, label: 'ETH/USDT' },
  SOLUSDT: { slPct: 0.05, trailFloor: 0.015, dec: 4, label: 'SOL/USDT' },
};

// ── Firebase ──────────────────────────────────────────────────────────────────
let db;
try {
  initializeApp({ credential: cert(JSON.parse(FIREBASE_CREDS)) });
  db = getFirestore();
  console.log('[FIREBASE] Connected');
} catch(e) {
  console.error('[FIREBASE] Init failed:', e.message);
  process.exit(1);
}

const COL_POS    = 'b2_positions';   // open positions
const COL_TRADES = 'b2_trades';      // closed trade history

// ── State ─────────────────────────────────────────────────────────────────────
let paperMode  = PAPER_MODE_ENV;
let positions  = [];    // active positions (also persisted in Firestore)
let tradeCount = 0;
let lastTgId   = 0;

// ── Utility: HTTP GET ─────────────────────────────────────────────────────────
function httpGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'StableScan/1.0' },
      timeout: 10000,
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── Telegram ──────────────────────────────────────────────────────────────────
function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) return Promise.resolve();
  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown',
    disable_web_page_preview: true });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d)); });
    req.on('error', resolve);
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body); req.end();
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fp  = (p, sym) => p != null ? p.toFixed(PAIR_CFG[sym]?.dec ?? 4) : '—';
const pct = p => (p >= 0 ? '+' : '') + (p * 100).toFixed(2) + '%';
const dur = ms => {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m/60)}h ${m%60}m`;
};

// ── Binance market data (no auth needed) ──────────────────────────────────────
async function fetchCandles(symbol, interval = '1h', limit = CANDLE_LIMIT) {
  const r = await httpGet('api.binance.com',
    `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (r.status !== 200) throw new Error(`Binance klines ${r.status}`);
  // [openTime, open, high, low, close, volume, ...]
  return JSON.parse(r.body).map(c => ({
    ts: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], vol: +c[5],
  }));
}

async function fetchPrice(symbol) {
  const r = await httpGet('api.binance.com',
    `/api/v3/ticker/price?symbol=${symbol}`);
  if (r.status !== 200) throw new Error(`Binance price ${r.status}`);
  return parseFloat(JSON.parse(r.body).price);
}

// ── Technical indicators ──────────────────────────────────────────────────────
function computeEMA(candles, period) {
  if (candles.length < period) return null;
  const k   = 2 / (period + 1);
  let   ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  for (let i = period; i < candles.length; i++)
    ema = candles[i].close * k + ema * (1 - k);
  return ema;
}

function computeRSI(candles, period = RSI_PERIOD) {
  if (candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  const start = candles.length - period;
  for (let i = start; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d > 0) gains += d; else losses -= d;
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

// Swing point detection — ported from Bot 1 (MemeScan Tracker)
// lookback=3 gives cleaner signals on 1h candles than lookback=2
function detectSwingPoints(candles, lookback = 3) {
  const lows = [], highs = [];
  const end  = candles.length - lookback;
  for (let i = lookback; i < end; i++) {
    let isLow = true, isHigh = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].low  <= candles[i].low)  isLow  = false;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (!isLow && !isHigh) break;
    }
    if (isLow)  lows.push( { price: candles[i].low,  idx: i, ts: candles[i].ts });
    if (isHigh) highs.push({ price: candles[i].high, idx: i, ts: candles[i].ts });
  }
  return { lows, highs };
}

// ══════════════════════════════════════════════════════════════════════════════
// ENTRY SIGNAL — Strategy B+C
//
// Gate 1: Price above 50 EMA  (macro uptrend confirmed)
// Gate 2: Higher highs + higher lows  (swing structure intact)
// Gate 3: Price in lower 75% of last swing range  (pullback, not at peak)
// Gate 4: RSI not overbought  (< 70)
// ══════════════════════════════════════════════════════════════════════════════
async function scanPair(symbol) {
  const candles = await fetchCandles(symbol, '1h', CANDLE_LIMIT);
  if (candles.length < EMA_PERIOD + 10) return null;

  const price = candles[candles.length - 1].close;
  const ema50 = computeEMA(candles, EMA_PERIOD);
  const rsi   = computeRSI(candles, RSI_PERIOD);
  const { lows, highs } = detectSwingPoints(candles, 3);

  // Gate 1: trend
  if (!ema50 || price < ema50) {
    console.log(`[SCAN] ${symbol} — below 50 EMA ($${fp(price,symbol)} < $${fp(ema50,symbol)})`);
    return null;
  }

  // Gate 2: swing structure
  if (highs.length < 2 || lows.length < 2) {
    console.log(`[SCAN] ${symbol} — not enough swing points (${highs.length}H ${lows.length}L)`);
    return null;
  }
  const lastHigh = highs[highs.length - 1].price;
  const prevHigh = highs[highs.length - 2].price;
  const lastLow  = lows[lows.length  - 1].price;
  const prevLow  = lows[lows.length  - 2].price;

  if (lastHigh <= prevHigh) {
    console.log(`[SCAN] ${symbol} — lower high ($${fp(lastHigh,symbol)} ≤ $${fp(prevHigh,symbol)})`);
    return null;
  }
  if (lastLow <= prevLow) {
    console.log(`[SCAN] ${symbol} — lower low ($${fp(lastLow,symbol)} ≤ $${fp(prevLow,symbol)})`);
    return null;
  }

  // Gate 3: pullback — not chasing the top
  const swingRange = lastHigh - lastLow;
  const rangePos   = swingRange > 0 ? (price - lastLow) / swingRange : 1;
  if (rangePos > 0.75) {
    console.log(`[SCAN] ${symbol} — price at ${(rangePos*100).toFixed(0)}% of range, too high — wait`);
    return null;
  }
  if (price < lastLow * 1.002) {
    console.log(`[SCAN] ${symbol} — price at/below last swing low — structure broken`);
    return null;
  }

  // Gate 4: RSI
  if (rsi !== null && rsi > 70) {
    console.log(`[SCAN] ${symbol} — RSI ${rsi.toFixed(1)} overbought`);
    return null;
  }

  console.log(`[SIGNAL] ✅ ${symbol} price=$${fp(price,symbol)} ema50=$${fp(ema50,symbol)} RSI=${rsi?.toFixed(1)} range=${(rangePos*100).toFixed(0)}% HH=✅ HL=✅`);
  return { symbol, price, ema50, rsi, lastHigh, lastLow, prevHigh, prevLow, rangePos };
}

// ══════════════════════════════════════════════════════════════════════════════
// ENTER POSITION
// ══════════════════════════════════════════════════════════════════════════════
async function enterPosition(signal) {
  const { symbol, price, lastHigh, lastLow } = signal;
  const cfg    = PAIR_CFG[symbol];
  const slPrc  = price * (1 - cfg.slPct);
  const size   = POSITION_SIZE;
  const qty    = size / price;

  const pos = {
    symbol,
    pair:        cfg.label,
    entryPrice:  price,
    currentSL:   slPrc,
    peakPrice:   price,
    size,
    qty,
    slPct:       cfg.slPct,
    trailFloor:  cfg.trailFloor,
    lastHigh,
    lastLow,
    entryTime:   Date.now(),
    paperMode,
    pnl:         0,
    lhTightened: false,
    lhPrevPeak:  null,
  };

  try {
    const ref = db.collection(COL_POS).doc();
    await ref.set(pos);
    pos.id = ref.id;
  } catch(e) {
    console.error('[ENTER] Firestore error:', e.message);
    return null;
  }

  positions.push(pos);
  tradeCount++;

  const mode = paperMode ? '📄 PAPER' : '💰 LIVE';
  await sendTelegram(
    `📈 *ENTRY — ${cfg.label}* ${mode}\n\n` +
    `Price:  $${fp(price, symbol)}\n` +
    `Size:   $${size.toFixed(2)}  (${qty.toFixed(6)} ${symbol.replace('USDT','')})\n` +
    `SL:     $${fp(slPrc, symbol)}  (−${(cfg.slPct*100).toFixed(1)}%)\n` +
    `Range:  $${fp(lastLow,symbol)} – $${fp(lastHigh,symbol)}\n` +
    `50 EMA: $${fp(signal.ema50, symbol)}`
  );
  console.log(`[ENTER] ${symbol} @ $${fp(price,symbol)} SL=$${fp(slPrc,symbol)} $${size} ${paperMode?'PAPER':'LIVE'}`);
  return pos;
}

// ══════════════════════════════════════════════════════════════════════════════
// CLOSE POSITION
// ══════════════════════════════════════════════════════════════════════════════
async function closePosition(pos, exitPrice, reason) {
  const pnl     = (exitPrice - pos.entryPrice) * pos.qty;
  const pnlPct  = (exitPrice - pos.entryPrice) / pos.entryPrice;
  const holdMs  = Date.now() - pos.entryTime;

  positions = positions.filter(p => p.id !== pos.id);

  const record = {
    symbol: pos.symbol, pair: pos.pair,
    entryPrice: pos.entryPrice, exitPrice,
    pnl, pnlPct, size: pos.size,
    entryTime: pos.entryTime, exitTime: Date.now(),
    holdMinutes: Math.round(holdMs / 60000),
    reason, paperMode: pos.paperMode,
  };

  try {
    await db.collection(COL_TRADES).add(record);
    if (pos.id) await db.collection(COL_POS).doc(pos.id).delete();
  } catch(e) { console.error('[CLOSE] Firestore error:', e.message); }

  const emoji  = pnl >= 0 ? '✅' : '🔴';
  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  const mode   = pos.paperMode ? '📄' : '💰';
  await sendTelegram(
    `${emoji} *${reason} — ${pos.pair}* ${mode}\n\n` +
    `Entry: $${fp(pos.entryPrice,pos.symbol)} → Exit: $${fp(exitPrice,pos.symbol)}\n` +
    `P&L:   *${pnlStr}* (${pct(pnlPct)})\n` +
    `Hold:  ${dur(holdMs)}`
  );
  console.log(`[CLOSE] ${pos.symbol} ${reason} @ $${fp(exitPrice,pos.symbol)} PnL=${pnlStr} hold=${dur(holdMs)}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// MONITOR OPEN POSITIONS — runs every 1 minute
// ══════════════════════════════════════════════════════════════════════════════
async function monitorPositions() {
  if (positions.length === 0) return;

  for (const pos of [...positions]) {
    let price;
    try { price = await fetchPrice(pos.symbol); }
    catch(e) { console.error(`[MON] ${pos.symbol}:`, e.message); continue; }

    const updates = {};
    pos.pnl = (price - pos.entryPrice) * pos.qty;

    // Update all-time-high for this position
    if (price > (pos.peakPrice || pos.entryPrice)) {
      pos.peakPrice    = price;
      updates.peakPrice = price;
    }

    // ── SL HIT ──────────────────────────────────────────────────────────────
    if (price <= pos.currentSL) {
      await closePosition(pos, price, 'SL HIT');
      continue;
    }

    // ── LOWER-HIGH TIGHTENING (same logic as Bot 1) ──────────────────────────
    try {
      const candles = await fetchCandles(pos.symbol, '1h', 50);
      const { highs } = detectSwingPoints(candles, 3);

      // Release tight SL if price broke above prev peak
      if (pos.lhTightened && pos.lhPrevPeak && price > pos.lhPrevPeak) {
        updates.lhTightened = false; updates.lhPrevPeak = null;
        pos.lhTightened     = false; pos.lhPrevPeak     = null;
        sendTelegram(
          `📈 *RECOVERY — ${pos.pair}*\nPrice above prev peak → normal trail resumed`
        ).catch(() => {});
      }

      // Detect new lower high → tighten
      if (!pos.lhTightened && highs.length >= 2) {
        const lastH = highs[highs.length - 1].price;
        const prevH = highs[highs.length - 2].price;
        if (lastH < prevH) {
          const tightSL = price * (1 - pos.trailFloor);
          if (tightSL > pos.currentSL) {
            updates.currentSL   = tightSL;
            updates.lhTightened = true;
            updates.lhPrevPeak  = prevH;
            pos.currentSL       = tightSL;
            pos.lhTightened     = true;
            pos.lhPrevPeak      = prevH;
            sendTelegram(
              `⚠️ *LOWER-HIGH — ${pos.pair}*\n` +
              `Swing: $${fp(lastH,pos.symbol)} < prev $${fp(prevH,pos.symbol)}\n` +
              `SL tightened → $${fp(tightSL,pos.symbol)} (−${(pos.trailFloor*100).toFixed(1)}%)\n` +
              `Will release when price > $${fp(prevH,pos.symbol)}`
            ).catch(() => {});
          }
        }
      }
    } catch(e) { /* candle fetch non-critical */ }

    // ── TRAILING SL (ratchet, only moves up) ────────────────────────────────
    if (!pos.lhTightened) {
      const gainPct  = (pos.peakPrice - pos.entryPrice) / pos.entryPrice;
      // Every +10% ATH gain, trail tightens by 0.5% (floors at trailFloor)
      const steps    = Math.floor(gainPct * 100 / 10);
      const trailPct = Math.max(pos.trailFloor, pos.slPct - steps * 0.005);
      const newSL    = pos.peakPrice * (1 - trailPct);
      if (newSL > pos.currentSL * 1.002) {
        updates.currentSL = newSL;
        pos.currentSL     = newSL;
      }
    }

    updates.pnl = pos.pnl;
    if (pos.id) {
      try { await db.collection(COL_POS).doc(pos.id).update(updates); }
      catch(e) { console.error('[MON] update error:', e.message); }
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SCAN LOOP — runs every 15 minutes
// ══════════════════════════════════════════════════════════════════════════════
async function runScanLoop() {
  console.log(`[SCAN] Starting — positions: ${positions.length}/${MAX_POSITIONS}`);
  for (const symbol of PAIRS) {
    if (positions.find(p => p.symbol === symbol)) continue;  // already in
    if (positions.length >= MAX_POSITIONS) break;
    try {
      const signal = await scanPair(symbol);
      if (signal) await enterPosition(signal);
    } catch(e) {
      console.error(`[SCAN] ${symbol} error:`, e.message);
    }
    await new Promise(r => setTimeout(r, 1500)); // small delay between pairs
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// REPORT
// ══════════════════════════════════════════════════════════════════════════════
async function generateReport() {
  const snap   = await db.collection(COL_TRADES).get();
  const trades = snap.docs.map(d => d.data());

  if (trades.length === 0) {
    await sendTelegram(`📊 *StableScan Report*\n\nNo closed trades yet.\nSend /b2status for open positions.`);
    return;
  }

  const wins    = trades.filter(t => t.pnl > 0);
  const losses  = trades.filter(t => t.pnl <= 0);
  const gross   = wins.reduce((s, t) => s + t.pnl, 0);
  const loss    = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const net     = gross - loss;
  const winRate = ((wins.length / trades.length) * 100).toFixed(1);
  const avgHold = trades.length
    ? Math.round(trades.reduce((s,t) => s + (t.holdMinutes||0), 0) / trades.length) : 0;

  const pairLines = PAIRS.map(sym => {
    const pt   = trades.filter(t => t.symbol === sym);
    if (!pt.length) return null;
    const pNet = pt.reduce((s,t)=>s+t.pnl, 0);
    const pW   = pt.filter(t=>t.pnl>0).length;
    return `  ${PAIR_CFG[sym].label}: ${pW}W/${pt.length-pW}L  P&L: ${pNet>=0?'+':''}$${pNet.toFixed(2)}`;
  }).filter(Boolean).join('\n');

  await sendTelegram(
    `📊 *STABLESCAN REPORT* (${trades.length} trades)\n\n` +
    `Win rate:  *${winRate}%*  (${wins.length}W / ${losses.length}L)\n` +
    `Gross profit: *+$${gross.toFixed(2)}*\n` +
    `Gross loss:   *-$${loss.toFixed(2)}*\n` +
    `─────────────────\n` +
    `Net P&L:  *${net>=0?'+':''}$${net.toFixed(2)}*\n` +
    `Avg hold: ${avgHold} min\n\n` +
    `*By pair:*\n${pairLines}\n\n` +
    `Mode: ${trades.some(t=>!t.paperMode) ? '💰 includes live trades' : '📄 paper only'}`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TELEGRAM COMMAND HANDLER
// ══════════════════════════════════════════════════════════════════════════════
async function handleCommand(text) {
  const cmd = text.trim().toLowerCase();

  // ── /b2help ──────────────────────────────────────────────────────────────
  if (cmd === '/b2help') {
    return sendTelegram(
      `🤖 *StableScan Bot — Commands*\n\n` +
      `/b2status   — open positions + unrealised P&L\n` +
      `/b2report   — full closed-trade P&L report\n` +
      `/b2scan     — trigger manual scan now\n` +
      `/b2paper on — switch to paper (safe) mode\n` +
      `/b2paper off — switch to LIVE mode ⚠️\n` +
      `/b2help     — this menu\n\n` +
      `Mode:      ${paperMode ? '📄 Paper' : '💰 Live'}\n` +
      `Pairs:     BTC · ETH · SOL\n` +
      `Positions: ${positions.length}/${MAX_POSITIONS}\n` +
      `Strategy:  50 EMA + Swing pullback`
    );
  }

  // ── /b2status ─────────────────────────────────────────────────────────────
  if (cmd === '/b2status') {
    if (positions.length === 0)
      return sendTelegram(`📊 *StableScan Status*\n\nNo open positions.\nNext scan: every 15 min.`);

    const lines = await Promise.all(positions.map(async pos => {
      let cur = pos.entryPrice;
      try { cur = await fetchPrice(pos.symbol); } catch(e) {}
      const pnl = (cur - pos.entryPrice) * pos.qty;
      const pp  = (cur - pos.entryPrice) / pos.entryPrice;
      return (
        `*${pos.pair}*\n` +
        `  Price: $${fp(cur,pos.symbol)}  (${pct(pp)})\n` +
        `  P&L:   ${pnl>=0?'+':''}$${pnl.toFixed(2)}\n` +
        `  SL:    $${fp(pos.currentSL,pos.symbol)}` +
        (pos.lhTightened ? '  ⚠️ _tightened_' : '') + '\n' +
        `  Hold:  ${dur(Date.now()-pos.entryTime)}`
      );
    }));
    return sendTelegram(`📊 *Open Positions (${positions.length})*\n\n${lines.join('\n\n')}`);
  }

  // ── /b2report ─────────────────────────────────────────────────────────────
  if (cmd === '/b2report') return generateReport();

  // ── /b2scan ───────────────────────────────────────────────────────────────
  if (cmd === '/b2scan') {
    await sendTelegram(`🔍 Manual scan triggered for BTC · ETH · SOL...`);
    return runScanLoop();
  }

  // ── /b2paper ──────────────────────────────────────────────────────────────
  if (cmd === '/b2paper on') {
    paperMode = true;
    return sendTelegram(`📄 *Paper mode ON*\nNo real Binance orders will be placed.`);
  }
  if (cmd === '/b2paper off') {
    paperMode = false;
    return sendTelegram(
      `💰 *LIVE MODE ON* ⚠️\nReal Binance orders will be placed.\n` +
      `Make sure BINANCE_API_KEY and BINANCE_API_SECRET are set.\n` +
      `Send /b2paper on to revert.`
    );
  }
}

// ── Telegram long-poll ────────────────────────────────────────────────────────
async function pollTelegram() {
  if (!TELEGRAM_TOKEN) return;
  try {
    const r    = await httpGet('api.telegram.org',
      `/bot${TELEGRAM_TOKEN}/getUpdates?offset=${lastTgId+1}&timeout=20&limit=5`);
    const data = JSON.parse(r.body);
    if (!data.ok) return;
    for (const u of data.result || []) {
      lastTgId = u.update_id;
      const msg    = u.message?.text || '';
      const chatId = u.message?.chat?.id?.toString();
      if (chatId !== CHAT_ID) continue;
      if (!msg.startsWith('/b2')) continue;
      await handleCommand(msg).catch(e =>
        console.error('[TG] command error:', e.message));
    }
  } catch(e) { console.error('[TG] poll error:', e.message); }
}

// ── Load persisted positions on startup ───────────────────────────────────────
async function loadPositions() {
  try {
    const snap = await db.collection(COL_POS).get();
    positions  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log(`[STARTUP] ${positions.length} open position(s) loaded`);
  } catch(e) {
    console.error('[STARTUP] Could not load positions:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('🤖 StableScan Bot starting...');
  console.log(`Mode: ${paperMode?'PAPER':'LIVE'} | Pairs: ${PAIRS.join(',')} | Size: $${POSITION_SIZE}`);

  await loadPositions();

  await sendTelegram(
    `🤖 *StableScan Bot Online*\n\n` +
    `Mode:     ${paperMode ? '📄 Paper (safe)' : '💰 Live'}\n` +
    `Pairs:    BTC · ETH · SOL\n` +
    `Size:     $${POSITION_SIZE} per trade\n` +
    `Strategy: 50 EMA + Swing Structure Pullback\n` +
    `Scan:     every 15 min\n\n` +
    `Send /b2help for commands.`
  );

  // Initial scan on startup
  await runScanLoop();

  // Scheduled loops
  setInterval(runScanLoop,      SCAN_MS);
  setInterval(monitorPositions, MONITOR_MS);

  // Telegram polling loop (3-second cycle)
  const tgLoop = async () => {
    await pollTelegram();
    setTimeout(tgLoop, 3000);
  };
  tgLoop();

  console.log('[MAIN] Running — scan every 15 min, monitor every 1 min');
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
