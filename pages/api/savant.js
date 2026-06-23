// pages/api/savant.js
// Fetches ALL Baseball Savant feeds ONCE per slate and returns them as a single
// bundle. The frontend calls this one time, then passes the bundle into each
// per-game /api/gamedata call — so we hit Savant once per run instead of four
// times per game (which was causing cold-start timeouts across the slate).

const { fetchAllSavant } = require("../../lib/savantfeeds");

let CACHE = { ts: 0, data: null };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // 10-minute in-memory cache (per warm instance). Even if cold, this endpoint
  // is called ONCE per run, so the cost is one set of fetches, not per-game.
  if (CACHE.data && Date.now() - CACHE.ts < 10 * 60 * 1000) {
    return res.status(200).json({ ...CACHE.data, cached: true });
  }

  try {
    const bundle = await fetchAllSavant();
    CACHE = { ts: Date.now(), data: bundle };
    return res.status(200).json({ ...bundle, cached: false });
  } catch (e) {
    // Fail-safe: empty bundle so the app degrades gracefully.
    return res.status(200).json({
      savant: {}, splits: { R:{}, L:{} },
      arsenals: { pitcher:{}, batter:{} }, pitcherContact: {},
      error: e.message
    });
  }
}
