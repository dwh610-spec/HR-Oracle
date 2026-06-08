// pages/api/savant.js
// Pulls the Baseball Savant exit-velocity & barrels leaderboard (season)
// Returns a map of player name -> { barrel_pct, hard_hit_pct, avg_ev, launch_angle, max_ev }
// Used as a shared lookup so we hit Savant once per run instead of per-player.

let CACHE = { ts: 0, data: null };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Serve from a short in-memory cache (10 min) to avoid hammering Savant
  if (CACHE.data && Date.now() - CACHE.ts < 10 * 60 * 1000) {
    return res.status(200).json({ players: CACHE.data, cached: true });
  }

  const year = new Date().getFullYear();

  try {
    // Savant exit velocity & barrels leaderboard as JSON
    // type=batter, min batted-ball events low so most regulars are included
    const url = `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${year}&position=&team=&min=q&csv=true`;
    // The CSV endpoint is most reliable. Fetch and parse.
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const text = await r.text();

    const players = {};

    // Parse CSV: header row then data
    const lines = text.split("\n").filter(l => l.trim());
    if (lines.length > 1) {
      const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim().toLowerCase());
      const idx = (name) => headers.findIndex(h => h.includes(name));

      const iName = idx("name") >= 0 ? idx("name") : 0;
      const iBarrel = idx("barrel") >= 0 ? headers.findIndex(h => h.includes("barrel") && h.includes("pa") || h === "brl_percent" || h.includes("barrel_batted_rate")) : -1;
      const iHard = headers.findIndex(h => h.includes("hard") || h.includes("hardhit"));
      const iEV = headers.findIndex(h => h.includes("exit_velocity") || h.includes("avg_hit_speed") || h.includes("launch_speed"));
      const iLA = headers.findIndex(h => h.includes("launch_angle") || h.includes("avg_angle"));

      for (let i = 1; i < lines.length; i++) {
        // naive CSV split (Savant names can be "Last, First" quoted)
        const cols = lines[i].match(/("([^"]*)"|[^,]+)/g) || [];
        const clean = cols.map(c => c.replace(/"/g, "").trim());
        let name = clean[iName] || "";
        // Savant often formats "Last, First" — flip to "First Last"
        if (name.includes(",")) {
          const [last, first] = name.split(",").map(s => s.trim());
          name = `${first} ${last}`;
        }
        if (!name) continue;
        players[name.toLowerCase()] = {
          barrel_pct: iBarrel >= 0 ? clean[iBarrel] : null,
          hard_hit_pct: iHard >= 0 ? clean[iHard] : null,
          avg_ev: iEV >= 0 ? clean[iEV] : null,
          launch_angle: iLA >= 0 ? clean[iLA] : null
        };
      }
    }

    CACHE = { ts: Date.now(), data: players };
    return res.status(200).json({ players, cached: false, count: Object.keys(players).length });
  } catch (e) {
    // Fail-safe: return empty so the app falls back to game-log power proxy
    return res.status(200).json({ players: {}, error: e.message });
  }
}
