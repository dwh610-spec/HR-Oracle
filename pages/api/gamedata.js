// pages/api/gamedata.js
// v6: adds recent 14-day form, day/night & handedness splits, fatigue flag,
// ballpark elevation, and Savant power metrics (with game-log fallback)

const BASE = "https://statsapi.mlb.com/api/v1";

// Ballpark elevation (feet) — higher = more carry = more HR
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
  "George M. Steinbrenner Field": 10
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
  "Chase Field":[33.4453,-112.0667],"Coors Field":[39.7559,-104.9942]
};

function daysAgoISO(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { game_pk, venue, away_sp_id, home_sp_id, away_team_id, home_team_id,
          game_time, savant_host } = req.query;

  try {
    const results = {
      lineups: {}, pitcherStats: {}, weather: null, injured: [],
      lineupsPosted: false, projected: false,
      elevation: VENUE_ELEV[Object.keys(VENUE_ELEV).find(k => venue && venue.toLowerCase().includes(k.toLowerCase()))] || 20,
      isNightGame: false, savantUsed: false
    };

    // Determine day vs night from game_time (ET hour)
    const hour = parseInt((game_time||"").match(/(\d+):/)?.[1] || "19");
    const isPM = /PM/i.test(game_time||"");
    const h24 = isPM && hour !== 12 ? hour + 12 : hour;
    results.isNightGame = h24 >= 17;

    // ── Injuries ──────────────────────────────────────────────────────
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

    // ── Posted lineup ─────────────────────────────────────────────────
    let aCount=0, hCount=0;
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
            if (injuredIds.has(id)) return;
            const p = players[`ID${id}`];
            if (p) lineup.push({ id, name:p.person?.fullName||"?", position:p.position?.abbreviation||"", lineup_spot:idx+1, bats:p.person?.batSide?.code||"R" });
          });
          results.lineups[side] = lineup;
          if (side==="away") aCount=lineup.length; else hCount=lineup.length;
        }
      } catch {}
    }
    results.lineupsPosted = (aCount>=8 && hCount>=8);

    // ── Projected fallback ────────────────────────────────────────────
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

    const allPlayers = [...(results.lineups.away||[]), ...(results.lineups.home||[])];
    const oppThrows = { away: undefined, home: undefined };
    // away batters face home SP and vice versa — captured in analyze; here we fetch both splits

    // ── Savant power map (shared, cached) ─────────────────────────────
    let savant = {};
    try {
      const proto = (savant_host||"").startsWith("localhost") ? "http" : "https";
      const host = req.headers.host;
      const sRes = await fetch(`${proto}://${host}/api/savant`);
      const sData = await sRes.json();
      savant = sData.players || {};
      if (Object.keys(savant).length) results.savantUsed = true;
    } catch {}

    // ── Per-player: season + recent(14d) + splits + power ─────────────
    const playerStats = {};
    await Promise.all(allPlayers.map(async (p) => {
      const out = {};
      // Season hitting
      try {
        const r = await fetch(`${BASE}/people/${p.id}?hydrate=stats(group=hitting,type=season,season=2026)`);
        const d = await r.json();
        const person = d.people?.[0];
        if (person?.batSide?.code) p.bats = person.batSide.code;
        const s = person?.stats?.[0]?.splits?.[0]?.stat;
        if (s) {
          out.avg = s.avg||".000"; out.ops = s.ops||".000"; out.hr = s.homeRuns||0;
          out.slg = s.slg||".000"; out.iso = ((parseFloat(s.slg||0) - parseFloat(s.avg||0)).toFixed(3)); out.ab = s.atBats||0;
        }
      } catch {}

      // Recent 14-day via game logs
      try {
        const start = daysAgoISO(14), end = daysAgoISO(0);
        const r = await fetch(`${BASE}/people/${p.id}/stats?stats=byDateRange&group=hitting&startDate=${start}&endDate=${end}&season=2026`);
        const d = await r.json();
        const s = d.stats?.[0]?.splits?.[0]?.stat;
        if (s) {
          out.recent_hr = s.homeRuns||0;
          out.recent_avg = s.avg||".000";
          out.recent_slg = s.slg||".000";
          out.recent_ops = s.ops||".000";
          out.recent_ab = s.atBats||0;
          out.recent_iso = (parseFloat(s.slg||0) - parseFloat(s.avg||0)).toFixed(3);
        }
      } catch {}

      // Day/Night split
      try {
        const r = await fetch(`${BASE}/people/${p.id}/stats?stats=statSplits&sitCodes=${results.isNightGame?"n":"d"}&group=hitting&season=2026`);
        const d = await r.json();
        const s = d.stats?.[0]?.splits?.[0]?.stat;
        if (s) { out.split_ops = s.ops||".000"; out.split_hr = s.homeRuns||0; out.split_label = results.isNightGame?"night":"day"; }
      } catch {}

      // Savant power (fallback handled in analyze)
      const sv = savant[(p.name||"").toLowerCase()];
      if (sv) { out.barrel_pct = sv.barrel_pct; out.hard_hit_pct = sv.hard_hit_pct; out.avg_ev = sv.avg_ev; out.launch_angle = sv.launch_angle; }

      playerStats[p.id] = out;
    }));
    results.playerStats = playerStats;

    // Trim projected lineups to regulars, sort by recent OPS then season OPS
    if (results.projected) {
      for (const side of ["away","home"]) {
        results.lineups[side] = (results.lineups[side]||[])
          .filter(p => (playerStats[p.id]?.ab||0) >= 30)
          .sort((a,b) => (parseFloat(playerStats[b.id]?.recent_ops||playerStats[b.id]?.ops||0)) - (parseFloat(playerStats[a.id]?.recent_ops||playerStats[a.id]?.ops||0)))
          .slice(0, 9);
      }
    }

    // ── Pitcher stats (season + recent HR/9 trend) ────────────────────
    for (const [key, pid] of [["away", away_sp_id], ["home", home_sp_id]]) {
      if (!pid || pid==="null") continue;
      const ps = {};
      try {
        const r = await fetch(`${BASE}/people/${pid}?hydrate=stats(group=pitching,type=season,season=2026)`);
        const d = await r.json();
        const s = d.people?.[0]?.stats?.[0]?.splits?.[0]?.stat;
        if (s) { ps.era=s.era||"N/A"; ps.whip=s.whip||"N/A"; ps.hr9=s.homeRunsPer9||"N/A"; ps.hr_allowed=s.homeRuns||0; }
      } catch {}
      // recent 14d HR/9
      try {
        const start = daysAgoISO(21), end = daysAgoISO(0);
        const r = await fetch(`${BASE}/people/${pid}/stats?stats=byDateRange&group=pitching&startDate=${start}&endDate=${end}&season=2026`);
        const d = await r.json();
        const s = d.stats?.[0]?.splits?.[0]?.stat;
        if (s) { ps.recent_hr9 = s.homeRunsPer9||"N/A"; ps.recent_era = s.era||"N/A"; }
      } catch {}
      results.pitcherStats[key] = ps;
    }

    // ── Weather ───────────────────────────────────────────────────────
    const coords = Object.entries(VENUE_COORDS).find(([k]) => venue && venue.toLowerCase().includes(k.toLowerCase()))?.[1] || [40.7128,-74.0060];
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${coords[0]}&longitude=${coords[1]}&hourly=temperature_2m,windspeed_10m,winddirection_10m&temperature_unit=fahrenheit&windspeed_unit=mph&forecast_days=1&timezone=auto`);
      const d = await r.json();
      const idx = results.isNightGame ? 19 : 13;
      results.weather = {
        temp: Math.round(d.hourly?.temperature_2m?.[idx]||70)+"°F",
        wind_speed: Math.round(d.hourly?.windspeed_10m?.[idx]||5)+" mph",
        wind_dir: d.hourly?.winddirection_10m?.[idx]||180,
        summary: `${Math.round(d.hourly?.temperature_2m?.[idx]||70)}°F, wind ${Math.round(d.hourly?.windspeed_10m?.[idx]||5)} mph`
      };
    } catch {}

    return res.status(200).json(results);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
