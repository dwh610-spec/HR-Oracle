// pages/api/gamedata.js
// Fetches live lineups + stats — optimized for speed (parallel, timeout-safe)

export const config = { maxDuration: 30 };

// Helper: fetch with timeout so one slow call can't kill everything
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { game_pk, venue, away_sp_id, home_sp_id } = req.query;

  const results = { lineups: { away: [], home: [] }, pitcherStats: {}, playerStats: {}, weather: null };

  try {
    // ── 1. Lineups from boxscore (single call) ────────────────────────
    if (game_pk) {
      const box = await fetchWithTimeout(`https://statsapi.mlb.com/api/v1/game/${game_pk}/boxscore`, 4000);
      if (box?.teams) {
        for (const side of ["away", "home"]) {
          const teamData = box.teams[side];
          const order = teamData?.battingOrder || [];
          const players = teamData?.players || {};
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

    // ── 2. Batter stats — ALL IN PARALLEL (was the bottleneck) ────────
    const allPlayers = [...results.lineups.away, ...results.lineups.home];
    const statPromises = allPlayers.map(async (p) => {
      const data = await fetchWithTimeout(
        `https://statsapi.mlb.com/api/v1/people/${p.id}?hydrate=stats(group=hitting,type=season,season=2026)`,
        3000
      );
      const stat = data?.people?.[0]?.stats?.[0]?.splits?.[0]?.stat;
      if (stat) {
        results.playerStats[p.id] = {
          avg: stat.avg || ".000",
          ops: stat.ops || ".000",
          hr: stat.homeRuns || 0,
          slg: stat.slg || ".000",
          obp: stat.obp || ".000"
        };
      }
    });

    // ── 3. Pitcher stats in parallel ──────────────────────────────────
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

    // ── 4. Weather in parallel ────────────────────────────────────────
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

    // Wait for everything in parallel — much faster than sequential
    await Promise.all([...statPromises, ...pitcherPromises, weatherPromise]);

    return res.status(200).json(results);
  } catch (e) {
    // Return partial data rather than failing entirely
    return res.status(200).json(results);
  }
}
