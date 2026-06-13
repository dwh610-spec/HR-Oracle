// pages/api/gamedata.js
// v7: Savant logic INLINED (no internal API-to-API call, which was failing).
// recent 14-day form, day/night & handedness splits, elevation, power metrics

const BASE = "https://statsapi.mlb.com/api/v1";

export const config = { maxDuration: 30 };

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

// ── Module-level Savant cache (persists across warm invocations) ────────
let SAVANT_CACHE = { ts: 0, data: null };

async function getSavant() {
  if (SAVANT_CACHE.data && Date.now() - SAVANT_CACHE.ts < 10 * 60 * 1000) {
    return SAVANT_CACHE.data;
  }
  const year = new Date().getFullYear();
  const players = {};
  try {
    const url = `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${year}&position=&team=&min=q&csv=true`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { game_pk, venue, away_sp_id, home_sp_id, away_team_id, home_team_id, game_time } = req.query;

  try {
    const results = {
      lineups: {}, pitcherStats: {}, weather: null, injured: [],
      lineupsPosted: false, projected: false, gameState: "",
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
        const r = await fetch(`${BASE}/teams/${teamId}/roster/depthChart`);
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
        const r = await fetch(`${BASE}/game/${game_pk}/boxscore`);
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
        const sr = await fetch(`${BASE}/game/${game_pk}/feed/live`);
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
          const r = await fetch(`${BASE}/teams/${teamId}/roster/active`);
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

    // Savant (inlined — no internal API call)
    const savant = await getSavant();
    if (Object.keys(savant).length) results.savantUsed = true;

    // Resolve each starter's throwing hand up front — batters need the opposing
    // SP's handedness to fetch the correct vs-LHP / vs-RHP platoon split.
    const spThrows = {}; // { away: "R"|"L", home: "R"|"L" }
    await Promise.all([["away", away_sp_id], ["home", home_sp_id]].map(async ([key, pid]) => {
      if (!pid || pid === "null") return;
      try {
        const r = await fetch(`${BASE}/people/${pid}`);
        const d = await r.json();
        spThrows[key] = d.people?.[0]?.pitchHand?.code || "R";
      } catch { spThrows[key] = "R"; }
    }));
    // Away batters face the HOME starter and vice-versa.
    const oppHandForSide = { away: spThrows.home || "R", home: spThrows.away || "R" };

    // Per-player stats
    const sideOf = {};
    (results.lineups.away||[]).forEach(p => { sideOf[p.id] = "away"; });
    (results.lineups.home||[]).forEach(p => { sideOf[p.id] = "home"; });
    const allPlayers = [...(results.lineups.away||[]), ...(results.lineups.home||[])];
    const playerStats = {};
    await Promise.all(allPlayers.map(async (p) => {
      const out = {};
      try {
        const r = await fetch(`${BASE}/people/${p.id}?hydrate=stats(group=hitting,type=season,season=2026)`);
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
        const r = await fetch(`${BASE}/people/${p.id}/stats?stats=byDateRange&group=hitting&startDate=${start}&endDate=${end}&season=2026`);
        const d = await r.json();
        const s = d.stats?.[0]?.splits?.[0]?.stat;
        if (s) { out.recent_hr=s.homeRuns||0; out.recent_avg=s.avg||".000"; out.recent_slg=s.slg||".000"; out.recent_ops=s.ops||".000"; out.recent_ab=s.atBats||0; out.recent_iso=(parseFloat(s.slg||0)-parseFloat(s.avg||0)).toFixed(3); }
      } catch {}
      try {
        const r = await fetch(`${BASE}/people/${p.id}/stats?stats=statSplits&sitCodes=${results.isNightGame?"n":"d"}&group=hitting&season=2026`);
        const d = await r.json();
        const s = d.stats?.[0]?.splits?.[0]?.stat;
        if (s) { out.split_ops=s.ops||".000"; out.split_hr=s.homeRuns||0; out.split_label=results.isNightGame?"night":"day"; }
      } catch {}
      // Platoon split vs the handedness of the starter this batter actually faces.
      try {
        const oppHand = oppHandForSide[sideOf[p.id]] || "R";
        const sit = oppHand === "L" ? "vl" : "vr"; // vs LHP / vs RHP
        const r = await fetch(`${BASE}/people/${p.id}/stats?stats=statSplits&sitCodes=${sit}&group=hitting&season=2026`);
        const d = await r.json();
        const s = d.stats?.[0]?.splits?.[0]?.stat;
        if (s) {
          out.plat_hand = oppHand;
          out.plat_ops = s.ops||".000";
          out.plat_slg = s.slg||".000";
          out.plat_hr = s.homeRuns||0;
          out.plat_ab = s.atBats||0;
          out.plat_iso = (parseFloat(s.slg||0)-parseFloat(s.avg||0)).toFixed(3);
        }
      } catch {}
      const sv = savant[(p.name||"").toLowerCase()];
      if (sv) { out.barrel_pct=sv.barrel_pct; out.hard_hit_pct=sv.hard_hit_pct; out.avg_ev=sv.avg_ev; out.launch_angle=sv.launch_angle; }
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
        const r = await fetch(`${BASE}/people/${pid}?hydrate=stats(group=pitching,type=season,season=2026)`);
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
        const r = await fetch(`${BASE}/people/${pid}/stats?stats=byDateRange&group=pitching&startDate=${start}&endDate=${end}&season=2026`);
        const d = await r.json();
        const s = d.stats?.[0]?.splits?.[0]?.stat;
        if (s) { ps.recent_hr9=s.homeRunsPer9||"N/A"; ps.recent_era=s.era||"N/A"; }
      } catch {}
      results.pitcherStats[key] = ps;
    }

    // Weather
    const coords = Object.entries(VENUE_COORDS).find(([k]) => venue && venue.toLowerCase().includes(k.toLowerCase()))?.[1] || [40.7128,-74.0060];
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${coords[0]}&longitude=${coords[1]}&hourly=temperature_2m,windspeed_10m,winddirection_10m&temperature_unit=fahrenheit&windspeed_unit=mph&forecast_days=1&timezone=auto`);
      const d = await r.json();
      const idx = results.isNightGame ? 19 : 13;
      const wdir = d.hourly?.winddirection_10m?.[idx]||180;
      const wmph = Math.round(d.hourly?.windspeed_10m?.[idx]||5);
      const wEffect = windEffect(venue, wdir, wmph);
      results.weather = {
        temp: Math.round(d.hourly?.temperature_2m?.[idx]||70)+"°F",
        wind_speed: wmph+" mph",
        wind_dir: wdir,
        wind_effect: wEffect,
        summary: `${Math.round(d.hourly?.temperature_2m?.[idx]||70)}°F, ${wEffect||`wind ${wmph}mph`}`
      };
    } catch {}

    return res.status(200).json(results);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
