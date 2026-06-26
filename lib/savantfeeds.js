// lib/savantfeeds.js
// Shared Baseball Savant feed fetchers + parsers. Used by /api/savant (which
// fetches all feeds ONCE per slate) so gamedata.js no longer re-fetches them
// per game. Each fetcher is fail-safe: on error it returns an empty map and the
// app degrades gracefully (pitcher grade falls back to HR/9 + FB%).

const PITCH_FAMILY = {
  FF:"FB", FA:"FB", SI:"FB", FC:"FB", FT:"FB",
  SL:"BRK", CU:"BRK", ST:"BRK", SV:"BRK", KC:"BRK", CS:"BRK", SC:"BRK",
  CH:"OFF", FS:"OFF", FO:"OFF"
};

async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
  } finally { clearTimeout(id); }
}

// Statcast exit-velocity/barrels board. hand = "" | "R" | "L"; type = batter|pitcher.
async function fetchStatcastBoard(hand = "", type = "batter") {
  const year = new Date().getFullYear();
  const players = {};
  try {
    const handParam = hand ? `&pitcher_hand=${hand}` : "";
    const url = `https://baseballsavant.mlb.com/leaderboard/statcast?type=${type}&year=${year}&position=&team=&min=q${handParam}&csv=true`;
    const r = await fetchWithTimeout(url, 8000);
    const text = await r.text();
    const lines = text.split("\n").filter(l => l.trim());
    if (lines.length > 1) {
      const H = lines[0].split(",").map(h => h.replace(/"/g, "").trim().toLowerCase());
      const iName = H.findIndex(h => h.includes("name")) >= 0 ? H.findIndex(h => h.includes("name")) : 0;
      const iBarrel = H.findIndex(h => (h.includes("barrel") && (h.includes("pa")||h.includes("rate"))) || h==="brl_percent");
      const iHard = H.findIndex(h => h.includes("hard"));
      const iEV = H.findIndex(h => h.includes("exit_velocity")||h.includes("hit_speed")||h.includes("launch_speed"));
      const iLA = H.findIndex(h => h.includes("launch_angle")||h.includes("avg_angle"));
      const iHR = H.findIndex(h => h==="hr"||h.includes("home_run")||h.includes("homerun"));
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].match(/("([^"]*)"|[^,]+)/g) || [];
        const c = cols.map(x => x.replace(/"/g, "").trim());
        let name = c[iName] || "";
        if (name.includes(",")) { const [last, first] = name.split(",").map(s=>s.trim()); name = `${first} ${last}`; }
        if (!name) continue;
        players[name.toLowerCase()] = {
          barrel_pct: iBarrel>=0 ? c[iBarrel] : null,
          hard_hit_pct: iHard>=0 ? c[iHard] : null,
          avg_ev: iEV>=0 ? c[iEV] : null,
          launch_angle: iLA>=0 ? c[iLA] : null,
          hr: iHR>=0 ? c[iHR] : null
        };
      }
    }
  } catch {}
  return players;
}

// Pitch-arsenal stats board (per pitch family). type = pitcher|batter.
async function fetchArsenal(type) {
  const year = new Date().getFullYear();
  const out = {};
  try {
    const url = `https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=${type}&pitchType=&year=${year}&team=&min=10&csv=true`;
    const r = await fetchWithTimeout(url, 8000);
    const text = await r.text();
    const lines = text.split("\n").filter(l => l.trim());
    if (lines.length < 2) return out;
    const H = lines[0].split(",").map(h => h.replace(/"/g,"").trim().toLowerCase());
    const col = (...names) => H.findIndex(h => names.some(n => h===n || h.includes(n)));
    const iName = col("last_name, first_name","player_name","name");
    const iPitch = col("pitch_type","pitch");
    const iUsage = col("pitch_usage","pitch_per","usage");
    const iRV = col("run_value_per_100","rv_per_100","run_value_per100");
    const iSlg = col("slg","slugging");
    const iWoba = col("woba");
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].match(/("([^"]*)"|[^,]+)/g) || [];
      const c = cols.map(x => x.replace(/"/g,"").trim());
      let name = c[iName] || "";
      if (name.includes(",")) { const [last, first] = name.split(",").map(s=>s.trim()); name = `${first} ${last}`; }
      if (!name) continue;
      const fam = PITCH_FAMILY[(c[iPitch]||"").toUpperCase()];
      if (!fam) continue;
      const key = name.toLowerCase();
      out[key] = out[key] || { FB:null, BRK:null, OFF:null };
      const usage = iUsage>=0 ? parseFloat(c[iUsage])||0 : 0;
      const rv = iRV>=0 ? parseFloat(c[iRV]) : null;
      const slg = iSlg>=0 ? parseFloat(c[iSlg]) : null;
      const woba = iWoba>=0 ? parseFloat(c[iWoba]) : null;
      const prev = out[key][fam];
      if (!prev) {
        out[key][fam] = { usage, rv, slg, woba, w: usage||1 };
      } else {
        const w = prev.w + (usage||1);
        out[key][fam] = {
          usage: prev.usage + usage,
          rv: rv!=null && prev.rv!=null ? (prev.rv*prev.w + rv*(usage||1))/w : (prev.rv ?? rv),
          slg: slg!=null && prev.slg!=null ? (prev.slg*prev.w + slg*(usage||1))/w : (prev.slg ?? slg),
          woba: woba!=null && prev.woba!=null ? (prev.woba*prev.w + woba*(usage||1))/w : (prev.woba ?? woba),
          w
        };
      }
    }
  } catch {}
  return out;
}

// Fetch ALL feeds once. Returns the bundle the rest of the app consumes.
async function fetchAllSavant() {
  const [savant, splitR, splitL, arsPitcher, arsBatter, pitcherContact] = await Promise.all([
    fetchStatcastBoard("", "batter"),
    fetchStatcastBoard("R", "batter"),
    fetchStatcastBoard("L", "batter"),
    fetchArsenal("pitcher"),
    fetchArsenal("batter"),
    fetchStatcastBoard("", "pitcher")
  ]);
  return {
    savant,
    splits: { R: splitR, L: splitL },
    arsenals: { pitcher: arsPitcher, batter: arsBatter },
    pitcherContact
  };
}

// Module-level cache so any function in the SAME serverless deployment can read
// the bundle without it being shipped over HTTP. gamedata calls this directly
// instead of receiving a multi-MB bundle in its request body (which blew past
// Vercel's ~4MB body limit and caused most games to fail).
let _BUNDLE_CACHE = { ts: 0, data: null, inflight: null };
async function getCachedSavant() {
  if (_BUNDLE_CACHE.data && Date.now() - _BUNDLE_CACHE.ts < 10 * 60 * 1000) {
    return _BUNDLE_CACHE.data;
  }
  // Coalesce concurrent callers (the 4-game batch) onto ONE fetch.
  if (_BUNDLE_CACHE.inflight) return _BUNDLE_CACHE.inflight;
  _BUNDLE_CACHE.inflight = (async () => {
    try {
      const bundle = await fetchAllSavant();
      _BUNDLE_CACHE = { ts: Date.now(), data: bundle, inflight: null };
      return bundle;
    } catch {
      _BUNDLE_CACHE.inflight = null;
      return { savant:{}, splits:{R:{},L:{}}, arsenals:{pitcher:{},batter:{}}, pitcherContact:{} };
    }
  })();
  return _BUNDLE_CACHE.inflight;
}

module.exports = { fetchAllSavant, getCachedSavant, fetchStatcastBoard, fetchArsenal, PITCH_FAMILY };
