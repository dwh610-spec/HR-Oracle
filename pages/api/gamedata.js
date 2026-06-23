// pages/api/gamedata.js
// v7: Savant logic INLINED (no internal API-to-API call, which was failing).
// recent 14-day form, day/night & handedness splits, elevation, power metrics

const BASE = "https://statsapi.mlb.com/api/v1";

export const config = { maxDuration: 30 };

// fetch with a per-call timeout. A single slow MLB endpoint should never hang
// the whole request long enough for the browser to drop it as "Load failed".
async function fetchT(url, ms = 9000, opts = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

const VENUE_ELEV = {
  "Coors Field": 5200, "Chase Field": 1059, "Truist Park": 1050,
  "Kauffman Stadium": 750, "Great American Ball Park": 550, "PNC Park": 730,
  "American Family Field": 635, "Busch Stadium": 466, "Target Field": 815,
  "Globe Life Field": 545, "Comerica Park": 600, "Guaranteed Rate Field": 595,
  "Rate Field": 595, "Wrigley Field": 600, "Angel Stadium": 160,
  "Dodger Stadium": 340, "Oracle Park": 10, "Petco Park": 60,
  "T-Mobile Park": 10, "Daikin Park": 50, "Minute Maid Park": 50,
  "Fenway Park": 20, "Yankee Stadium": 55, "Citi Field": 20,
  "Citizens Bank Park": 40, "Nationals Park": 25, "Camden Yards": 50,
  "Oriole Park at Camden Yards": 50, "Rogers Centre": 250, "Tropicana Field": 15,
  "loanDepot park": 10, "Progressive Field": 660, "Sutter Health Park": 30,
  "George M. Steinbrenner Field": 10, "Las Vegas Ballpark": 2030
};

const VENUE_COORDS = {
  "Fenway Park":[42.3467,-71.0972],"Yankee Stadium":[40.8296,-73.9262],
  "Citi Field":[40.7571,-73.8458],"Citizens Bank Park":[39.9061,-75.1665],
  "Wrigley Field":[41.9484,-87.6553],"Rate Field":[41.8300,-87.6338],
  "Guaranteed Rate Field":[41.8300,-87.6338],"Great American Ball Park":[39.0979,-84.5067],
  "Oracle Park":[37.7786,-122.3893],"Dodger Stadium":[34.0739,-118.2400],
  "Angel Stadium":[33.8003,-117.8827],"Petco Park":[32.7073,-117.1573],
  "T-Mobile Park":[47.5914,-122.3325],"Daikin Park":[29.7572,-95.3555],
  "Minute Maid Park":[29.7572,-95.3555],"Globe Life Field":[32.7473,-97.0842],
  "Truist Park":[33.8908,-84.4678],"loanDepot park":[25.7781,-80.2197],
  "Nationals Park":[38.8730,-77.0074],"PNC Park":[40.4469,-80.0057],
  "Busch Stadium":[38.6226,-90.1928],"American Family Field":[43.0280,-87.9712],
  "Target Field":[44.9817,-93.2781],"Kauffman Stadium":[39.0517,-94.4803],
  "Progressive Field":[41.4962,-81.6852],"Comerica Park":[42.3390,-83.0485],
  "Oriole Park at Camden Yards":[39.2838,-76.6217],"Camden Yards":[39.2838,-76.6217],
  "Rogers Centre":[43.6414,-79.3894],"Tropicana Field":[27.7682,-82.6534],
  "George M. Steinbrenner Field":[27.9786,-82.5069],"Sutter Health Park":[38.5804,-121.5005],
  "Chase Field":[33.4453,-112.0667],"Coors Field":[39.7559,-104.9942],
  "Las Vegas Ballpark":[36.1318,-115.1505]
};

// Compass bearing (degrees) from home plate toward center field for each park.
// Used with wind direction to decide whether wind helps or hurts home runs.
// Domes/retractable roofs (usually closed) are marked dome:true → wind ignored.
const VENUE_ORIENT = {
  "Fenway Park":{cf:45},"Yankee Stadium":{cf:25},"Citi Field":{cf:25},
  "Citizens Bank Park":{cf:0},"Wrigley Field":{cf:36},"Rate Field":{cf:5},
  "Guaranteed Rate Field":{cf:5},"Great American Ball Park":{cf:50},
  "Oracle Park":{cf:75},"Dodger Stadium":{cf:25},"Angel Stadium":{cf:40},
  "Petco Park":{cf:0},"T-Mobile Park":{cf:0,dome:true},"Daikin Park":{cf:0,dome:true},
  "Minute Maid Park":{cf:0,dome:true},"Globe Life Field":{cf:0,dome:true},
  "Truist Park":{cf:25},"loanDepot park":{cf:25,dome:true},"Nationals Park":{cf:30},
  "PNC Park":{cf:60},"Busch Stadium":{cf:30},"American Family Field":{cf:0,dome:true},
  "Target Field":{cf:15},"Kauffman Stadium":{cf:0},"Progressive Field":{cf:0},
  "Comerica Park":{cf:30},"Oriole Park at Camden Yards":{cf:0},"Camden Yards":{cf:0},
  "Rogers Centre":{cf:0,dome:true},"Tropicana Field":{cf:0,dome:true},
  "Chase Field":{cf:25,dome:true},"Coors Field":{cf:0}
};

// Given the park's CF bearing and the meteorological wind direction (the
// direction wind blows FROM), return a short human label the model understands.
function windEffect(venue, windFromDeg, windMph) {
  const key = venue && Object.keys(VENUE_ORIENT).find(k => venue.toLowerCase().includes(k.toLowerCase()));
  if (!key) return null;
  const o = VENUE_ORIENT[key];
  if (o.dome) return "indoor/roof (wind neutral)";
  if (windMph < 5) return "calm";
  // Wind blows TOWARD (fromDeg + 180). Compare to CF bearing.
  const towardDeg = (windFromDeg + 180) % 360;
  let diff = Math.abs(towardDeg - o.cf);
  if (diff > 180) diff = 360 - diff;
  if (diff <= 45) return `OUT to CF (+HR, ${windMph}mph)`;        // helps HR
  if (diff >= 135) return `IN from CF (-HR, ${windMph}mph)`;       // suppresses HR
  return `cross-wind (${windMph}mph)`;                            // neutral-ish
}

// Numeric version of the wind effect for the environment multiplier:
// returns a factor (1.0 = neutral). OUT boosts, IN suppresses, scaled by speed.
function windFactor(venue, windFromDeg, windMph) {
  const key = venue && Object.keys(VENUE_ORIENT).find(k => venue.toLowerCase().includes(k.toLowerCase()));
  if (!key) return 1.0;
  const o = VENUE_ORIENT[key];
  if (o.dome) return 1.0;
  if (windMph < 5) return 1.0;
  const towardDeg = (windFromDeg + 180) % 360;
  let diff = Math.abs(towardDeg - o.cf);
  if (diff > 180) diff = 360 - diff;
  // ~3% per 5mph out to CF, symmetric suppression blowing in. Cap at +/-18%.
  const mag = Math.min(0.18, (windMph / 5) * 0.03);
  if (diff <= 45) return 1 + mag;        // blowing out
  if (diff >= 135) return 1 - mag;       // blowing in
  return 1.0;                            // cross-wind ~neutral
}

// Per-park HR factor BY BATTER HANDEDNESS (relative to MLB avg = 1.00).
// Captures short porches / quirks that a single park number misses:
//   L = factor for left-handed batters, R = for right-handed batters.
// e.g. Yankee Stadium's short RF strongly helps LHB; Fenway's Monster helps RHB.
const PARK_HAND_HR = {
  "Yankee Stadium": { L:1.22, R:1.02 },
  "Fenway Park": { L:0.94, R:1.12 },
  "Coors Field": { L:1.18, R:1.18 },
  "Great American Ball Park": { L:1.16, R:1.14 },
  "Citizens Bank Park": { L:1.12, R:1.10 },
  "Camden Yards": { L:1.02, R:0.90 },
  "Oriole Park at Camden Yards": { L:1.02, R:0.90 },
  "Globe Life Field": { L:1.05, R:1.04 },
  "Wrigley Field": { L:1.04, R:1.05 },
  "Rate Field": { L:1.10, R:1.12 },
  "Guaranteed Rate Field": { L:1.10, R:1.12 },
  "Truist Park": { L:1.05, R:1.06 },
  "Dodger Stadium": { L:1.08, R:1.10 },
  "Chase Field": { L:1.04, R:1.05 },
  "American Family Field": { L:1.10, R:1.08 },
  "Minute Maid Park": { L:1.02, R:1.10 },
  "Daikin Park": { L:1.02, R:1.10 },
  "Nationals Park": { L:1.06, R:1.02 },
  "Citi Field": { L:0.96, R:0.98 },
  "Oracle Park": { L:0.78, R:0.95 },   // deep RF triples alley kills LHB HR
  "Petco Park": { L:0.94, R:0.96 },
  "T-Mobile Park": { L:0.92, R:0.94 },
  "Comerica Park": { L:0.96, R:0.92 },
  "Kauffman Stadium": { L:0.94, R:0.93 },
  "PNC Park": { L:0.90, R:1.00 },
  "Tropicana Field": { L:0.97, R:0.97 },
  "Progressive Field": { L:1.00, R:1.00 },
  "Target Field": { L:1.00, R:1.02 },
  "Busch Stadium": { L:0.96, R:0.95 },
  "Angel Stadium": { L:1.02, R:1.04 },
  "Rogers Centre": { L:1.05, R:1.06 },
  "loanDepot park": { L:0.92, R:0.94 }
};
function parkHandFactor(venue, bats) {
  const key = venue && Object.keys(PARK_HAND_HR).find(k => venue.toLowerCase().includes(k.toLowerCase()));
  if (!key) return 1.0;
  const f = PARK_HAND_HR[key];
  // Switch hitters (S): average the two.
  if (bats === "S") return (f.L + f.R) / 2;
  return bats === "L" ? f.L : f.R;
}

// Unified game-level HR environment multiplier (the "HRForce" idea): combine
// elevation, temperature, and wind into ONE number so the model gets a clean
// signal instead of having to mentally combine raw fields. 1.00 = average.
function hrEnvironment(elevation, tempF, windMult) {
  let f = 1.0;
  // Elevation: Coors (~5200ft) is famously ~+12-15%. Scale gently per 1000ft.
  if (elevation > 1000) f *= 1 + Math.min(0.15, (elevation - 1000) / 1000 * 0.035);
  // Temperature: warm air carries. ~+1.5% per 10°F above 70, -per 10 below.
  if (typeof tempF === "number" && !isNaN(tempF)) f *= 1 + ((tempF - 70) / 10) * 0.015;
  // Wind already a factor.
  f *= (windMult || 1.0);
  return Math.round(f * 1000) / 1000;
}


// ── Module-level Savant cache (persists across warm invocations) ────────
let SAVANT_CACHE = { ts: 0, data: null };

async function getSavant() {
  if (SAVANT_CACHE.data && Date.now() - SAVANT_CACHE.ts < 10 * 60 * 1000) {
    return SAVANT_CACHE.data;
  }
  const year = new Date().getFullYear();
  const players = await fetchStatcastBoard("");   // overall (no hand filter)
  SAVANT_CACHE = { ts: Date.now(), data: players };
  return players;
}

// Parse one Statcast exit-velocity/barrels leaderboard CSV. `hand` is "", "R",
// or "L" (filters to batted balls vs RHP / LHP via the pitcher_hand param).
// `type` is "batter" (default) or "pitcher" — for pitchers the metrics are the
// contact they ALLOW (barrel%-against, hard-hit%-against, EV-against).
async function fetchStatcastBoard(hand, type = "batter") {
  const year = new Date().getFullYear();
  const players = {};
  try {
    const handParam = hand ? `&pitcher_hand=${hand}` : "";
    const url = `https://baseballsavant.mlb.com/leaderboard/statcast?type=${type}&year=${year}&position=&team=&min=q${handParam}&csv=true`;
    const r = await fetchT(url, 7000, { headers: { "User-Agent": "Mozilla/5.0" } });
    const text = await r.text();
    const lines = text.split("\n").filter(l => l.trim());
    if (lines.length > 1) {
      const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim().toLowerCase());
      const iName = headers.findIndex(h => h.includes("name")) >= 0 ? headers.findIndex(h => h.includes("name")) : 0;
      const iBarrel = headers.findIndex(h => (h.includes("barrel") && (h.includes("pa")||h.includes("rate"))) || h==="brl_percent");
      const iHard = headers.findIndex(h => h.includes("hard"));
      const iEV = headers.findIndex(h => h.includes("exit_velocity")||h.includes("hit_speed")||h.includes("launch_speed"));
      const iLA = headers.findIndex(h => h.includes("launch_angle")||h.includes("avg_angle"));
      const iHR = headers.findIndex(h => h==="hr"||h.includes("home_run")||h.includes("homerun"));
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].match(/("([^"]*)"|[^,]+)/g) || [];
        const clean = cols.map(c => c.replace(/"/g, "").trim());
        let name = clean[iName] || "";
        if (name.includes(",")) { const [last, first] = name.split(",").map(s=>s.trim()); name = `${first} ${last}`; }
        if (!name) continue;
        players[name.toLowerCase()] = {
          barrel_pct: iBarrel>=0 ? clean[iBarrel] : null,
          hard_hit_pct: iHard>=0 ? clean[iHard] : null,
          avg_ev: iEV>=0 ? clean[iEV] : null,
          launch_angle: iLA>=0 ? clean[iLA] : null,
          hr: iHR>=0 ? clean[iHR] : null
        };
      }
    }
  } catch {
    // fail-safe: empty map
  }
  return players;
}

// Cache for pitcher contact-ALLOWED (barrel%/hard-hit%/EV against). This is the
// forward-looking HR signal — loud contact precedes HR/9 rising.
let PITCH_CONTACT_CACHE = { ts: 0, data: null };
async function getPitcherContact() {
  if (PITCH_CONTACT_CACHE.data && Date.now() - PITCH_CONTACT_CACHE.ts < 10 * 60 * 1000) {
    return PITCH_CONTACT_CACHE.data;
  }
  const data = await fetchStatcastBoard("", "pitcher");
  PITCH_CONTACT_CACHE = { ts: Date.now(), data };
  return data;
}

// Cache for the two handedness-split power boards (vs RHP / vs LHP).
let SPLIT_CACHE = { ts: 0, R: null, L: null };
async function getSavantSplits() {
  if (SPLIT_CACHE.R && Date.now() - SPLIT_CACHE.ts < 10 * 60 * 1000) {
    return { R: SPLIT_CACHE.R, L: SPLIT_CACHE.L };
  }
  const [vsR, vsL] = await Promise.all([fetchStatcastBoard("R"), fetchStatcastBoard("L")]);
  SPLIT_CACHE = { ts: Date.now(), R: vsR, L: vsL };
  return { R: vsR, L: vsL };
}

async function _legacyGetSavantUnused() {
  const year = new Date().getFullYear();
  const players = {};
  try {
    const url = `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${year}&position=&team=&min=q&csv=true`;
    const r = await fetchT(url, 7000, { headers: { "User-Agent": "Mozilla/5.0" } });
    const text = await r.text();
    const lines = text.split("\n").filter(l => l.trim());
    if (lines.length > 1) {
      const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim().toLowerCase());
      const iName = headers.findIndex(h => h.includes("name")) >= 0 ? headers.findIndex(h => h.includes("name")) : 0;
      const iBarrel = headers.findIndex(h => h.includes("barrel") && (h.includes("pa")||h.includes("rate")) || h==="brl_percent");
      const iHard = headers.findIndex(h => h.includes("hard"));
      const iEV = headers.findIndex(h => h.includes("exit_velocity")||h.includes("hit_speed")||h.includes("launch_speed"));
      const iLA = headers.findIndex(h => h.includes("launch_angle")||h.includes("avg_angle"));
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].match(/("([^"]*)"|[^,]+)/g) || [];
        const clean = cols.map(c => c.replace(/"/g, "").trim());
        let name = clean[iName] || "";
        if (name.includes(",")) { const [last, first] = name.split(",").map(s=>s.trim()); name = `${first} ${last}`; }
        if (!name) continue;
        players[name.toLowerCase()] = {
          barrel_pct: iBarrel>=0 ? clean[iBarrel] : null,
          hard_hit_pct: iHard>=0 ? clean[iHard] : null,
          avg_ev: iEV>=0 ? clean[iEV] : null,
          launch_angle: iLA>=0 ? clean[iLA] : null
        };
      }
    }
    SAVANT_CACHE = { ts: Date.now(), data: players };
  } catch {
    // fail-safe: empty map, app falls back to game-log power proxy
  }
  return players;
}

function daysAgoISO(n){ const d=new Date(); d.setDate(d.getDate()-n); return d.toISOString().split("T")[0]; }

// ── Pitch-type matchup data (Baseball Savant "pitch-arsenal-stats") ──────────
// Two leaderboards, one per side. Each has MULTIPLE rows per player (one per
// pitch type). We bucket the individual pitch types into three families that
// matter for HR matchups, so the prompt stays compact:
//   FB  = 4-seam, sinker, cutter, fastball       (FF, SI, FC, FA)
//   BRK = slider, curve, sweeper, slurve, knuckle-curve  (SL, CU, ST, SV, KC)
//   OFF = changeup, splitter, screwball          (CH, FS, SC)
// For PITCHERS we track usage% and run-value-per-100 by family (a high RV/100
// against = a hittable "meatball" pitch). For BATTERS we track run-value-per-100
// and slug by family (how much damage they do vs each family).
const PITCH_FAMILY = {
  FF:"FB", FA:"FB", SI:"FB", FC:"FB", FT:"FB",
  SL:"BRK", CU:"BRK", ST:"BRK", SV:"BRK", KC:"BRK", CS:"BRK", SC:"BRK",
  CH:"OFF", FS:"OFF", FO:"OFF"
};
let ARSENAL_CACHE = { ts:0, pitcher:null, batter:null };

async function getArsenals() {
  if (ARSENAL_CACHE.pitcher && Date.now()-ARSENAL_CACHE.ts < 10*60*1000) {
    return { pitcher: ARSENAL_CACHE.pitcher, batter: ARSENAL_CACHE.batter };
  }
  const year = new Date().getFullYear();
  const parse = async (type) => {
    const out = {}; // name -> { FB:{usage,rv,slg,n}, BRK:{...}, OFF:{...} }
    try {
      const url = `https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=${type}&pitchType=&year=${year}&team=&min=10&csv=true`;
      const r = await fetchT(url, 7000, { headers:{ "User-Agent":"Mozilla/5.0" } });
      const text = await r.text();
      const lines = text.split("\n").filter(l=>l.trim());
      if (lines.length < 2) return out;
      const H = lines[0].split(",").map(h=>h.replace(/"/g,"").trim().toLowerCase());
      const col = (...names) => H.findIndex(h => names.some(n=>h===n||h.includes(n)));
      const iName = col("last_name, first_name","player_name","name");
      const iPitch = col("pitch_type","pitch");
      const iUsage = col("pitch_usage","pitch_per","usage");
      const iRV = col("run_value_per_100","rv_per_100","run_value_per100");
      const iSlg = col("slg","slugging");
      const iWoba = col("woba");
      for (let i=1;i<lines.length;i++){
        const cols = lines[i].match(/("([^"]*)"|[^,]+)/g)||[];
        const c = cols.map(x=>x.replace(/"/g,"").trim());
        let name = c[iName]||"";
        if (name.includes(",")){ const [last,first]=name.split(",").map(s=>s.trim()); name=`${first} ${last}`; }
        if (!name) continue;
        const fam = PITCH_FAMILY[(c[iPitch]||"").toUpperCase()];
        if (!fam) continue;
        const key = name.toLowerCase();
        out[key] = out[key] || { FB:null, BRK:null, OFF:null };
        const usage = iUsage>=0 ? parseFloat(c[iUsage])||0 : 0;
        const rv = iRV>=0 ? parseFloat(c[iRV]) : null;
        const slg = iSlg>=0 ? parseFloat(c[iSlg]) : null;
        const woba = iWoba>=0 ? parseFloat(c[iWoba]) : null;
        // Merge multiple pitch types in the same family, weighting by usage.
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
  };
  const [pitcher, batter] = await Promise.all([parse("pitcher"), parse("batter")]);
  ARSENAL_CACHE = { ts: Date.now(), pitcher, batter };
  return { pitcher, batter };
}

// Build the batter-vs-this-pitcher matchup signal: for each pitch family the
// STARTER actually throws a lot, how much damage does THIS hitter do vs it, and
// is the pitch hittable (high RV-against)? Returns a compact string + a score.
function pitchMatchup(batterArsenal, pitcherArsenal) {
  if (!batterArsenal || !pitcherArsenal) return null;
  const fams = ["FB","BRK","OFF"];
  const parts = [];
  let edge = 0, seen = 0;
  for (const f of fams) {
    const pa = pitcherArsenal[f], ba = batterArsenal[f];
    if (!pa || !pa.usage || pa.usage < 12) continue; // only pitches he throws often
    seen++;
    const usagePct = Math.round(pa.usage);
    // Batter damage vs family (slug) and pitcher vulnerability (rv allowed/100).
    const bslg = ba && ba.slg!=null ? ba.slg.toFixed(3) : "?";
    const pRv = pa.rv!=null ? pa.rv.toFixed(1) : "?";
    parts.push(`${f}${usagePct}%(B.slg${bslg}/P.rv${pRv})`);
    // Edge heuristic: batter slugs well vs a pitch the pitcher throws a lot and
    // gets hit on. Higher = better HR matchup.
    if (ba && ba.slg!=null) {
      let e = (ba.slg - 0.400) * pa.usage/100 * 2;        // batter power vs family
      if (pa.rv!=null) e += Math.max(0, pa.rv) * pa.usage/100 * 0.15; // hittable pitch
      edge += e;
    }
  }
  if (!seen) return null;
  return { str: parts.join(" "), edge: Math.round(edge*100)/100 };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { game_pk, venue, away_sp_id, home_sp_id, away_team_id, home_team_id, game_time } = req.query;

  try {
    const results = {
      lineups: {}, pitcherStats: {}, weather: null, injured: [],
      lineupsPosted: false, projected: false, gameState: "", oppStaff: {},
      elevation: VENUE_ELEV[Object.keys(VENUE_ELEV).find(k => venue && venue.toLowerCase().includes(k.toLowerCase()))] || 20,
      isNightGame: false, savantUsed: false
    };

    const hour = parseInt((game_time||"").match(/(\d+):/)?.[1] || "19");
    const isPM = /PM/i.test(game_time||"");
    const h24 = isPM && hour !== 12 ? hour + 12 : hour;
    results.isNightGame = h24 >= 17;

    // Injuries
    const INJURY_CODES = ["D7","D10","D15","D60","DTD","IL","IL7","IL10","IL15","IL60","RM","BRV","PL","SU","RES","DEC","FME"];
    const injuredIds = new Set(); const injuredNames = [];
    async function loadInjuries(teamId) {
      if (!teamId) return;
      try {
        const r = await fetchT(`${BASE}/teams/${teamId}/roster/depthChart`, 9000);
        const d = await r.json();
        for (const e of d.roster || []) {
          const code = (e.status?.code||"").toUpperCase().trim();
          const desc = (e.status?.description||"").toLowerCase();
          if (INJURY_CODES.includes(code) || desc.includes("injured") || desc.includes("day-to-day") || desc.includes("disabled")) {
            injuredIds.add(e.person?.id);
            injuredNames.push(`${e.person?.fullName} (${e.status?.description||code})`);
          }
        }
      } catch {}
    }
    await Promise.all([loadInjuries(away_team_id), loadInjuries(home_team_id)]);
    results.injured = injuredNames;

    // Posted lineup
    let aPosted=0, hPosted=0;   // raw battingOrder length straight from MLB
    let gameState = "";          // abstract game state: Preview / Live / Final
    if (game_pk) {
      try {
        const r = await fetchT(`${BASE}/game/${game_pk}/boxscore`, 9000);
        const d = await r.json();
        for (const side of ["away","home"]) {
          const t = d.teams?.[side];
          const order = t?.battingOrder || [];
          const players = t?.players || {};
          const lineup = [];
          order.forEach((id, idx) => {
            const p = players[`ID${id}`];
            // Keep the posted batter even if flagged injured — if MLB lists them
            // in the batting order, they are playing. (Injury codes can be stale.)
            if (p) lineup.push({ id, name:p.person?.fullName||"?", position:p.position?.abbreviation||"", lineup_spot:idx+1, bats:p.person?.batSide?.code||"R" });
          });
          results.lineups[side] = lineup;
          if (side==="away") aPosted=order.length; else hPosted=order.length;
        }
      } catch {}
    }

    // Pull game status separately so in-progress/final games are always trusted.
    if (game_pk) {
      try {
        const sr = await fetchT(`${BASE}/game/${game_pk}/feed/live`, 9000);
        const sd = await sr.json();
        gameState = (sd.gameData?.status?.abstractGameState || "").toLowerCase();
      } catch {}
    }
    const gameStarted = gameState === "live" || gameState === "final";
    results.gameState = gameState;

    // A lineup is "posted" if MLB gave us a real batting order (>=8) on BOTH
    // sides, OR the game has already started (then whatever MLB has is real).
    results.lineupsPosted = (aPosted>=8 && hPosted>=8) || (gameStarted && aPosted>=1 && hPosted>=1);

    // Projected fallback
    if (!results.lineupsPosted) {
      results.projected = true;
      async function activeHitters(teamId) {
        if (!teamId) return [];
        try {
          const r = await fetchT(`${BASE}/teams/${teamId}/roster/active`, 9000);
          const d = await r.json();
          return (d.roster||[])
            .filter(e => !["P","SP","RP"].includes(e.position?.abbreviation||"") && !injuredIds.has(e.person?.id))
            .map(e => ({ id:e.person?.id, name:e.person?.fullName||"?", position:e.position?.abbreviation||"", bats:"R" }));
        } catch { return []; }
      }
      const [a,h] = await Promise.all([activeHitters(away_team_id), activeHitters(home_team_id)]);
      results.lineups.away = a.map((p,i)=>({...p,lineup_spot:i+1}));
      results.lineups.home = h.map((p,i)=>({...p,lineup_spot:i+1}));
    }

    // Savant + pitch arsenals. These are SUPPLEMENTAL — wrap each so a slow or
    // failed Savant CSV can never sink the core MLB data (lineups/stats) for the
    // game. Settle individually; any that miss just degrade gracefully to {}.
    const safe = (p) => p.then(v => v).catch(() => null);
    const [savant, arsenals, savantSplits, pitcherContact] = await Promise.all([
      safe(getSavant()), safe(getArsenals()), safe(getSavantSplits()), safe(getPitcherContact())
    ]).then(([sv, ar, sp, pc]) => [
      sv || {},
      ar || { pitcher:{}, batter:{} },
      sp || { R:{}, L:{} },
      pc || {}
    ]);
    if (savant && Object.keys(savant).length) results.savantUsed = true;
    if (arsenals.pitcher && Object.keys(arsenals.pitcher).length) results.arsenalUsed = true;

    // Resolve each starter's throwing hand AND name up front — batters need the
    // opposing SP's handedness (platoon split) and name (pitch-arsenal lookup).
    const spThrows = {}; // { away:"R"|"L", home:"R"|"L" }
    const spName = {};   // { away:"Name", home:"Name" }
    await Promise.all([["away", away_sp_id], ["home", home_sp_id]].map(async ([key, pid]) => {
      if (!pid || pid === "null") return;
      try {
        const r = await fetchT(`${BASE}/people/${pid}`, 9000);
        const d = await r.json();
        spThrows[key] = d.people?.[0]?.pitchHand?.code || "R";
        spName[key] = d.people?.[0]?.fullName || "";
      } catch { spThrows[key] = "R"; }
    }));
    // Away batters face the HOME starter and vice-versa.
    const oppHandForSide = { away: spThrows.home || "R", home: spThrows.away || "R" };
    const oppSPNameForSide = { away: spName.home || "", home: spName.away || "" };
    // The starter arsenal each side's hitters will face.
    const oppArsenalForSide = {
      away: arsenals.pitcher?.[(spName.home||"").toLowerCase()] || null,
      home: arsenals.pitcher?.[(spName.away||"").toLowerCase()] || null
    };
    // Expose the starters' own arsenals for the prompt (what they throw).
    results.pitcherArsenal = {
      away: arsenals.pitcher?.[(spName.away||"").toLowerCase()] || null,
      home: arsenals.pitcher?.[(spName.home||"").toLowerCase()] || null
    };

    // Per-player stats
    const sideOf = {};
    (results.lineups.away||[]).forEach(p => { sideOf[p.id] = "away"; });
    (results.lineups.home||[]).forEach(p => { sideOf[p.id] = "home"; });
    const allPlayers = [...(results.lineups.away||[]), ...(results.lineups.home||[])];
    const playerStats = {};
    await Promise.all(allPlayers.map(async (p) => {
      const out = {};
      try {
        const r = await fetchT(`${BASE}/people/${p.id}?hydrate=stats(group=hitting,type=season,season=2026)`, 9000);
        const d = await r.json();
        const person = d.people?.[0];
        if (person?.batSide?.code) p.bats = person.batSide.code;
        const s = person?.stats?.[0]?.splits?.[0]?.stat;
        if (s) {
          out.avg=s.avg||".000"; out.ops=s.ops||".000"; out.hr=s.homeRuns||0; out.slg=s.slg||".000";
          out.iso=(parseFloat(s.slg||0)-parseFloat(s.avg||0)).toFixed(3); out.ab=s.atBats||0;
          // Batted-ball profile: fly-ball rate is the strongest HR-enabling shape.
          // MLB exposes groundOuts/airOuts; FB-leaning hitters air the ball out.
          const go = s.groundOuts||0, ao = s.airOuts||0;
          if (go+ao > 0) out.fb_pct = Math.round(ao/(go+ao)*100); // % of balls in air
          out.gb_fb = go>0 ? (ao/go).toFixed(2) : null;            // air/ground ratio
        }
      } catch {}
      try {
        const start=daysAgoISO(14), end=daysAgoISO(0);
        const r = await fetchT(`${BASE}/people/${p.id}/stats?stats=byDateRange&group=hitting&startDate=${start}&endDate=${end}&season=2026`, 9000);
        const d = await r.json();
        const s = d.stats?.[0]?.splits?.[0]?.stat;
        if (s) { out.recent_hr=s.homeRuns||0; out.recent_avg=s.avg||".000"; out.recent_slg=s.slg||".000"; out.recent_ops=s.ops||".000"; out.recent_ab=s.atBats||0; out.recent_iso=(parseFloat(s.slg||0)-parseFloat(s.avg||0)).toFixed(3); }
      } catch {}
      // ONE splits call covering BOTH day/night AND platoon, to minimize the
      // number of API requests per player (avoids overloading the pipeline).
      try {
        const oppHand = oppHandForSide[sideOf[p.id]] || "R";
        const platSit = oppHand === "L" ? "vl" : "vr";   // vs LHP / vs RHP
        const dnSit = results.isNightGame ? "n" : "d";    // day / night
        const r = await fetchT(`${BASE}/people/${p.id}/stats?stats=statSplits&sitCodes=${dnSit},${platSit}&group=hitting&season=2026`, 9000);
        const d = await r.json();
        const splits = d.stats?.[0]?.splits || [];
        for (const sp of splits) {
          const code = (sp.split?.code || "").toLowerCase();
          const s = sp.stat || {};
          if (code === dnSit) {
            out.split_ops = s.ops||".000"; out.split_hr = s.homeRuns||0;
            out.split_label = results.isNightGame ? "night" : "day";
          } else if (code === platSit) {
            out.plat_hand = oppHand;
            out.plat_ops = s.ops||".000";
            out.plat_slg = s.slg||".000";
            out.plat_hr = s.homeRuns||0;
            out.plat_ab = s.atBats||0;
            out.plat_iso = (parseFloat(s.slg||0)-parseFloat(s.avg||0)).toFixed(3);
          }
        }
      } catch {}
      const sv = savant[(p.name||"").toLowerCase()];
      if (sv) { out.barrel_pct=sv.barrel_pct; out.hard_hit_pct=sv.hard_hit_pct; out.avg_ev=sv.avg_ev; out.launch_angle=sv.launch_angle; }

      // Handedness-split power: this hitter's barrel/EV/LA/HR vs the HAND of the
      // starter he faces (RHP or LHP) — sharper than overall season power.
      const faceHand = oppHandForSide[sideOf[p.id]] || "R";
      const splitBoard = faceHand === "L" ? savantSplits.L : savantSplits.R;
      const svs = splitBoard?.[(p.name||"").toLowerCase()];
      if (svs) {
        out.split_hand = faceHand;
        out.split_barrel = svs.barrel_pct;
        out.split_ev = svs.avg_ev;
        out.split_la = svs.launch_angle;
        out.split_hardhit = svs.hard_hit_pct;
        out.split_pow_hr = svs.hr;
      }

      // Pitch-type matchup vs the starter this batter faces: how this hitter
      // performs against the pitch families the starter throws most, and how
      // hittable those pitches have been.
      const myBatArsenal = arsenals.batter?.[(p.name||"").toLowerCase()];
      const oppArsenal = oppArsenalForSide[sideOf[p.id]];
      const mm = pitchMatchup(myBatArsenal, oppArsenal);
      if (mm) { out.pitch_matchup = mm.str; out.pitch_edge = mm.edge; }
      out.opp_sp = oppSPNameForSide[sideOf[p.id]] || "";

      // Personalized park HR factor: how this park plays for THIS batter's
      // handedness (short porches etc.), not a single park-wide number.
      out.park_hand_factor = parkHandFactor(venue, p.bats || "R");

      playerStats[p.id] = out;
    }));
    results.playerStats = playerStats;

    if (results.projected) {
      for (const side of ["away","home"]) {
        const roster = results.lineups[side] || [];
        const byOps = (a,b) => parseFloat(playerStats[b.id]?.recent_ops||playerStats[b.id]?.ops||0) - parseFloat(playerStats[a.id]?.recent_ops||playerStats[a.id]?.ops||0);
        // Try progressively looser AB thresholds so we never end up empty
        // just because early-season AB data is sparse for some hitters.
        let picked = [];
        for (const minAB of [30, 15, 5, 0]) {
          picked = roster.filter(p => (playerStats[p.id]?.ab||0) >= minAB).sort(byOps);
          if (picked.length >= 8) break;
        }
        // Final fallback: if stats never populated at all, just take the
        // roster in the order MLB returned it so projection still works.
        if (picked.length < 8) picked = roster.slice();
        results.lineups[side] = picked.slice(0, 9).map((p,i) => ({ ...p, lineup_spot: i+1 }));
      }
    }

    // Pitchers
    for (const [key, pid] of [["away", away_sp_id], ["home", home_sp_id]]) {
      if (!pid || pid==="null") continue;
      const ps = {};
      try {
        const r = await fetchT(`${BASE}/people/${pid}?hydrate=stats(group=pitching,type=season,season=2026)`, 9000);
        const d = await r.json();
        const s = d.people?.[0]?.stats?.[0]?.splits?.[0]?.stat;
        if (s) {
          ps.era=s.era||"N/A"; ps.whip=s.whip||"N/A"; ps.hr9=s.homeRunsPer9||"N/A"; ps.hr_allowed=s.homeRuns||0;
          // Fly-ball rate: a pitcher who lets hitters put the ball in the air
          // gives up more HRs than HR/9 alone reveals (it leads results).
          const go=s.groundOuts||0, ao=s.airOuts||0;
          if (go+ao>0) ps.fb_pct = Math.round(ao/(go+ao)*100);
        }
      } catch {}
      try {
        const start=daysAgoISO(21), end=daysAgoISO(0);
        const r = await fetchT(`${BASE}/people/${pid}/stats?stats=byDateRange&group=pitching&startDate=${start}&endDate=${end}&season=2026`, 9000);
        const d = await r.json();
        const s = d.stats?.[0]?.splits?.[0]?.stat;
        if (s) {
          ps.recent_hr9=s.homeRunsPer9||"N/A";
          ps.recent_era=s.era||"N/A";
          ps.recent_baa=s.avg||"N/A";            // batting avg against, last 21d
          ps.recent_hr=s.homeRuns||0;            // HRs allowed, last 21d
          ps.recent_ip=s.inningsPitched||"0";
        }
      } catch {}

      // Contact ALLOWED (Savant): barrel% and hard-hit% surrendered. This is the
      // FORWARD-LOOKING HR signal — loud contact precedes HR/9 rising, so it
      // catches pitchers about to get homered on before the results show it.
      const pName = (spName[key]||"").toLowerCase();
      const pc = pitcherContact?.[pName];
      if (pc) {
        ps.barrel_allowed = pc.barrel_pct;     // % of batted balls barreled against him
        ps.hardhit_allowed = pc.hard_hit_pct;  // % hard-hit (95+ mph) against him
        ps.ev_allowed = pc.avg_ev;             // avg exit velo against
      }

      // Explicit HR-VULNERABILITY GRADE for this starter, so the model can't
      // under-weight it. Blends recent (L21) & season HR/9 with the QUALITY OF
      // CONTACT ALLOWED (barrel%/hard-hit% against) and fly-ball rate.
      // Grades: ELITE (very hard) / TOUGH / NEUTRAL / VULNERABLE / MEATBALL.
      const seasonHr9 = parseFloat(ps.hr9);
      const recentHr9 = parseFloat(ps.recent_hr9);
      let blend = null;
      if (!isNaN(seasonHr9) && !isNaN(recentHr9)) blend = recentHr9*0.6 + seasonHr9*0.4;
      else if (!isNaN(recentHr9)) blend = recentHr9;
      else if (!isNaN(seasonHr9)) blend = seasonHr9;
      if (blend != null) {
        let adj = blend;
        // Fly-ball rate nudge.
        const fb = ps.fb_pct;
        if (typeof fb === "number") { if (fb >= 42) adj += 0.15; else if (fb <= 32) adj -= 0.1; }
        // Contact-quality nudge — the forward-looking part. League-average barrel%
        // allowed ≈ 8%, hard-hit% ≈ 39%. Reward/penalize relative to those.
        const brl = parseFloat(ps.barrel_allowed);
        const hh = parseFloat(ps.hardhit_allowed);
        if (!isNaN(brl)) adj += (brl - 8) * 0.045;   // +0.045 HR/9-equiv per pt of barrel% over avg
        if (!isNaN(hh))  adj += (hh - 39) * 0.012;   // smaller weight for hard-hit%
        ps.hr_vuln_blend = Math.round(adj*100)/100;
        ps.hr_vuln = adj <= 0.70 ? "ELITE"
                  : adj <= 1.00 ? "TOUGH"
                  : adj <= 1.30 ? "NEUTRAL"
                  : adj <= 1.65 ? "VULNERABLE"
                  : "MEATBALL";
      } else if (!isNaN(parseFloat(ps.barrel_allowed))) {
        // No HR/9 yet (e.g. early call-up) but we have contact data — grade on it.
        const brl = parseFloat(ps.barrel_allowed);
        ps.hr_vuln = brl >= 12 ? "VULNERABLE" : brl >= 9 ? "NEUTRAL" : "TOUGH";
      } else {
        ps.hr_vuln = "NEUTRAL";
      }

      results.pitcherStats[key] = ps;
    }

    // Opposing-STAFF home-run vulnerability (the signal today's misses needed).
    // A hitter faces the starter for ~5 innings and that team's BULLPEN the rest,
    // so unexpected HRs cluster against teams whose overall/bullpen staff is
    // homer-prone or getting hit hard lately. We fetch each team's full-staff
    // pitching (season) and recent 14-day pitching, then attach it to the side
    // whose hitters benefit: away hitters face the HOME staff and vice-versa.
    async function teamStaff(teamId) {
      const o = {};
      if (!teamId || teamId === "null") return o;
      try {
        const r = await fetchT(`${BASE}/teams/${teamId}/stats?stats=season&group=pitching&season=2026`, 9000);
        const d = await r.json();
        const s = d.stats?.[0]?.splits?.[0]?.stat;
        if (s) {
          o.staff_hr9 = s.homeRunsPer9 || "N/A";
          o.staff_era = s.era || "N/A";
          const go=s.groundOuts||0, ao=s.airOuts||0;
          if (go+ao>0) o.staff_fb_pct = Math.round(ao/(go+ao)*100);
        }
      } catch {}
      try {
        const start=daysAgoISO(14), end=daysAgoISO(0);
        const r = await fetchT(`${BASE}/teams/${teamId}/stats?stats=byDateRange&group=pitching&startDate=${start}&endDate=${end}&season=2026`, 9000);
        const d = await r.json();
        const s = d.stats?.[0]?.splits?.[0]?.stat;
        if (s) { o.staff_recent_hr9 = s.homeRunsPer9 || "N/A"; o.staff_recent_era = s.era || "N/A"; }
      } catch {}
      return o;
    }
    const [awayStaff, homeStaff] = await Promise.all([
      teamStaff(away_team_id), teamStaff(home_team_id)
    ]);
    // oppStaff[side] = the staff that side's hitters face.
    results.oppStaff = { away: homeStaff, home: awayStaff };

    // Weather
    const coords = Object.entries(VENUE_COORDS).find(([k]) => venue && venue.toLowerCase().includes(k.toLowerCase()))?.[1] || [40.7128,-74.0060];
    try {
      const r = await fetchT(`https://api.open-meteo.com/v1/forecast?latitude=${coords[0]}&longitude=${coords[1]}&hourly=temperature_2m,windspeed_10m,winddirection_10m&temperature_unit=fahrenheit&windspeed_unit=mph&forecast_days=1&timezone=auto`, 9000);
      const d = await r.json();
      const idx = results.isNightGame ? 19 : 13;
      const wdir = d.hourly?.winddirection_10m?.[idx]||180;
      const wmph = Math.round(d.hourly?.windspeed_10m?.[idx]||5);
      const tempF = Math.round(d.hourly?.temperature_2m?.[idx]||70);
      const wEffect = windEffect(venue, wdir, wmph);
      const wMult = windFactor(venue, wdir, wmph);
      const hrEnv = hrEnvironment(results.elevation, tempF, wMult);
      results.hrEnv = hrEnv; // unified game HR multiplier (1.00 = avg)
      results.weather = {
        temp: tempF+"°F",
        wind_speed: wmph+" mph",
        wind_dir: wdir,
        wind_effect: wEffect,
        hr_env: hrEnv,
        summary: `${tempF}°F, ${wEffect||`wind ${wmph}mph`}, HRenv ${hrEnv}`
      };
    } catch {}

    return res.status(200).json(results);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
