// pages/api/gamedata.js
// Fetches live lineups (or current active roster as fallback) + stats + weather
// Filters out injured/inactive players (no game in last 10 days)

export const config = { maxDuration: 30 };

async function fetchWithTimeout(url, ms = 4000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return await res.json();
  } catch {
    clearTimeout(id);
    return null;
  }
}

// Get current active roster for a team
async function fetchRoster(teamId) {
  if (!teamId) return [];
  const data = await fetchWithTimeout(
    `https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active`,
    4000
  );
  const roster = data?.roster || [];
  return roster
    .filter(r => r.position?.abbreviation !== "P")
    .map((r, idx) => ({
      id: r.person?.id,
      name: r.person?.fullName || "Unknown",
      position: r.position?.abbreviation || "",
      lineup_spot: idx + 1,
      bats: "R"
    }));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { game_pk, venue, away_sp_id, home_sp_id, away_team_id, home_team_id } = req.query;

  const results = { lineups: { away: [], home: [] }, pitcherStats: {}, playerStats: {}, weather: null, source: "lineup" };

  // Cutoff: players must have played within the last 10 days to count as active
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 10);

  try {
    // ── 1. Try live lineup from boxscore ──────────────────────────────
    let hasLineup = false;
    if (game_pk) {
      const box = await fetchWithTimeout(`https://statsapi.mlb.com/api/v1/game/${game_pk}/boxscore`, 4000);
      if (box?.teams) {
        for (const side of ["away", "home"]) {
          const teamData = box.teams[side];
          const order = teamData?.battingOrder || [];
          const players = teamData?.players || {};
          if (order.length > 0) {
            hasLineup = true;
            results.lineups[side] = order.map((id, idx) => {
              const p = players[`ID${id}`];
              return p ? {
                id,
                name: p.person?.fullName || "Unknown",
                position: p.position?.abbreviation || "",
                lineup_spot: idx + 1,
                bats: p.person?.batSide?.code || "R"
              } : null;
            }).filter(Boolean);
          }
        }
      }
    }

    // ── 2. Fallback: current active rosters ───────────────────────────
    if (!hasLineup) {
      results.source = "roster";
      const [awayRoster, homeRoster] = await Promise.all([
        fetchRoster(away_team_id),
        fetchRoster(home_team_id)
      ]);
      results.lineups.away = awayRoster;
      results.lineups.home = homeRoster;
    }

    // ── 3. Batter stats + recent-activity check in parallel ───────────
    const allPlayers = [...results.lineups.away, ...results.lineups.home];
    const statPromises = allPlayers.map(async (p) => {
      if (!p.id) return;
      // Pull season hitting stats AND the player's last game date
      const data = await fetchWithTimeout(
        `https://statsapi.mlb.com/api/v1/people/${p.id}?hydrate=stats(group=hitting,type=season,season=2026),stats(group=hitting,type=lastXGames,limit=1)`,
        3500
      );
      const person = data?.people?.[0];
      if (!person) { p._inactive = true; return; }
      if (person.batSide?.code) p.bats = person.batSide.code;

      // Season stats
      const seasonStat = person.stats?.find(s => s.type?.displayName === "season")?.splits?.[0]?.stat;
      if (seasonStat) {
        results.playerStats[p.id] = {
          avg: seasonStat.avg || ".000",
          ops: seasonStat.ops || ".000",
          hr: seasonStat.homeRuns || 0,
          slg: seasonStat.slg || ".000",
          obp: seasonStat.obp || ".000",
          ab: seasonStat.atBats || 0
        };
      }

      // Recent-activity check: find most recent game date across stat splits
      let lastGameDate = null;
      for (const s of person.stats || []) {
        for (const split of s.splits || []) {
          if (split.date) {
            const d = new Date(split.date);
            if (!lastGameDate || d > lastGameDate) lastGameDate = d;
          }
        }
      }
      // If we have a last game date and it's older than cutoff → inactive/injured
      if (lastGameDate && lastGameDate < cutoff) p._inactive = true;
      // If no 2026 stats at all → not actively playing this season
      if (!seasonStat || (seasonStat.atBats || 0) === 0) p._inactive = true;
    });

    // ── 4. Pitcher stats in parallel ──────────────────────────────────
    const pitcherPromises = [["away", away_sp_id], ["home", home_sp_id]].map(async ([key, pid]) => {
      if (!pid || pid === "null" || pid === "") return;
      const data = await fetchWithTimeout(
        `https://statsapi.mlb.com/api/v1/people/${pid}?hydrate=stats(group=pitching,type=season,season=2026)`,
        3000
      );
      const stat = data?.people?.[0]?.stats?.[0]?.splits?.[0]?.stat;
      if (stat) {
        results.pitcherStats[key] = {
          era: stat.era || "N/A",
          whip: stat.whip || "N/A",
          hr9: stat.homeRunsPer9 || "N/A",
          hr_allowed: stat.homeRuns || 0
        };
      }
    });

    // ── 5. Weather in parallel ────────────────────────────────────────
    const venueCoords = {
      "Fenway Park":[42.3467,-71.0972],"Yankee Stadium":[40.8296,-73.9262],"Citi Field":[40.7571,-73.8458],
      "Citizens Bank Park":[39.9061,-75.1665],"Wrigley Field":[41.9484,-87.6553],"Rate Field":[41.8300,-87.6338],
      "Guaranteed Rate Field":[41.8300,-87.6338],"Great American Ball Park":[39.0979,-84.5067],"Oracle Park":[37.7786,-122.3893],
      "Dodger Stadium":[34.0739,-118.2400],"Angel Stadium":[33.8003,-117.8827],"Petco Park":[32.7073,-117.1573],
      "T-Mobile Park":[47.5914,-122.3325],"Daikin Park":[29.7572,-95.3555],"Minute Maid Park":[29.7572,-95.3555],
      "Globe Life Field":[32.7473,-97.0842],"Truist Park":[33.8908,-84.4678],"loanDepot park":[25.7781,-80.2197],
      "Nationals Park":[38.8730,-77.0074],"PNC Park":[40.4469,-80.0057],"Busch Stadium":[38.6226,-90.1928],
      "American Family Field":[43.0280,-87.9712],"Target Field":[44.9817,-93.2781],"Kauffman Stadium":[39.0517,-94.4803],
      "Progressive Field":[41.4962,-81.6852],"Comerica Park":[42.3390,-83.0485],"Oriole Park at Camden Yards":[39.2838,-76.6217],
      "Camden Yards":[39.2838,-76.6217],"Rogers Centre":[43.6414,-79.3894],"Tropicana Field":[27.7682,-82.6534],
      "George M. Steinbrenner Field":[27.9806,-82.5069],"Sutter Health Park":[38.5804,-121.5005]
    };
    const coords = Object.entries(venueCoords).find(([k]) =>
      venue && venue.toLowerCase().includes(k.toLowerCase())
    )?.[1] || [40.7128,-74.0060];

    const weatherPromise = (async () => {
      const wx = await fetchWithTimeout(
        `https://api.open-meteo.com/v1/forecast?latitude=${coords[0]}&longitude=${coords[1]}&hourly=temperature_2m,windspeed_10m,winddirection_10m&temperature_unit=fahrenheit&windspeed_unit=mph&forecast_days=1&timezone=auto`,
        3000
      );
      if (wx?.hourly) {
        const i = 19;
        const t = Math.round(wx.hourly.temperature_2m?.[i] ?? 70);
        const w = Math.round(wx.hourly.windspeed_10m?.[i] ?? 5);
        results.weather = {
          temp: t + "°F",
          wind_speed: w + " mph",
          wind_dir: wx.hourly.winddirection_10m?.[i] ?? 180,
          summary: `${t}°F, wind ${w} mph`
        };
      }
    })();

    await Promise.all([...statPromises, ...pitcherPromises, weatherPromise]);

    // ── 6. Drop inactive/injured players ──────────────────────────────
    for (const side of ["away", "home"]) {
      results.lineups[side] = results.lineups[side].filter(p => !p._inactive);
    }

    // For roster-based lineups, keep only the top 9 HR threats with stats
    if (results.source === "roster") {
      for (const side of ["away", "home"]) {
        results.lineups[side] = results.lineups[side]
          .filter(p => results.playerStats[p.id])
          .sort((a, b) => (results.playerStats[b.id]?.hr || 0) - (results.playerStats[a.id]?.hr || 0))
          .slice(0, 9)
          .map((p, idx) => ({ ...p, lineup_spot: idx + 1 }));
      }
    }

    return res.status(200).json(results);
  } catch (e) {
    return res.status(200).json(results);
  }
}
