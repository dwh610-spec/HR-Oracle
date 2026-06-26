// pages/api/gametest.js
// Diagnostic: runs ONE game through the same data steps as gamedata.js and
// returns a plain report of what loaded vs. what failed. Visit:
//   /api/gametest                 → picks today's first game automatically
//   /api/gametest?game_pk=...&away_team_id=...&home_team_id=...&venue=...
// Reports each step so we can see EXACTLY where the pipeline breaks.

const BASE = "https://statsapi.mlb.com/api/v1";

async function fetchT(url, ms = 9000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const out = { steps: {} };

  try {
    // Step 0: resolve a game to test
    let { game_pk, away_team_id, home_team_id, venue } = req.query;
    if (!game_pk) {
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const r = await fetchT(`${BASE}/schedule?sportId=1&date=${today}&hydrate=team,venue`);
      const d = await r.json();
      const g = d.dates?.[0]?.games?.[0];
      if (!g) { out.error = "no games today"; return res.status(200).json(out); }
      game_pk = g.gamePk;
      away_team_id = g.teams?.away?.team?.id;
      home_team_id = g.teams?.home?.team?.id;
      venue = g.venue?.name;
      out.steps.autopicked = { game_pk, away_team_id, home_team_id, venue,
        matchup: `${g.teams?.away?.team?.abbreviation}@${g.teams?.home?.team?.abbreviation}` };
    }
    out.steps.params = { game_pk, away_team_id, home_team_id, venue };

    // Step 1: boxscore battingOrder (official lineup)
    try {
      const r = await fetchT(`${BASE}/game/${game_pk}/boxscore`);
      const d = await r.json();
      const a = d.teams?.away?.battingOrder || [];
      const h = d.teams?.home?.battingOrder || [];
      out.steps.boxscore = { httpStatus: r.status, awayOrder: a.length, homeOrder: h.length };
    } catch (e) { out.steps.boxscore = { error: e.name === "AbortError" ? "timeout" : e.message }; }

    // Step 2: game status
    try {
      const r = await fetchT(`${BASE}/game/${game_pk}/feed/live`);
      const d = await r.json();
      out.steps.status = d.gameData?.status?.abstractGameState || "unknown";
    } catch (e) { out.steps.status = { error: e.name === "AbortError" ? "timeout" : e.message }; }

    // Step 3: active roster (the projected-lineup source) — THE LIKELY SUSPECT
    for (const [label, tid] of [["away", away_team_id], ["home", home_team_id]]) {
      const rep = {};
      if (!tid) { out.steps["roster_"+label] = "NO TEAM ID"; continue; }
      try {
        const r = await fetchT(`${BASE}/teams/${tid}/roster/active`);
        const d = await r.json();
        const hitters = (d.roster||[]).filter(e => !["P","SP","RP"].includes(e.position?.abbreviation||""));
        rep.httpStatus = r.status;
        rep.rosterTotal = (d.roster||[]).length;
        rep.hitters = hitters.length;
        rep.sample = hitters.slice(0,3).map(e => e.person?.fullName);
      } catch (e) { rep.error = e.name === "AbortError" ? "timeout" : e.message; }
      out.steps["roster_"+label] = rep;
    }

    // Step 4: 40-man fallback check
    try {
      const r = await fetchT(`${BASE}/teams/${away_team_id}/roster/40Man`);
      const d = await r.json();
      out.steps.roster40man_away = { httpStatus: r.status, total: (d.roster||[]).length };
    } catch (e) { out.steps.roster40man_away = { error: e.name === "AbortError" ? "timeout" : e.message }; }

    // Step 5: savant module import + cache
    try {
      const { getCachedSavant } = require("../../lib/savantfeeds");
      const t0 = Date.now();
      const bundle = await getCachedSavant();
      out.steps.savant = {
        importedOK: true,
        fetchMs: Date.now() - t0,
        savantPlayers: Object.keys(bundle.savant||{}).length,
        arsenalPitchers: Object.keys(bundle.arsenals?.pitcher||{}).length
      };
    } catch (e) { out.steps.savant = { importError: e.message }; }

    out.VERDICT = "Check roster_away / roster_home — if hitters=0 or NO TEAM ID, that's why games show no data. If savant.importError is set, the shared module is broken.";
    return res.status(200).json(out);
  } catch (e) {
    out.fatal = e.message;
    return res.status(200).json(out);
  }
}
