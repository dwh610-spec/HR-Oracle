// pages/api/gamedata.js
// Fetches live lineups + Statcast-style stats for a specific game

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { game_pk, away_team, home_team, venue, away_sp_id, home_sp_id } = req.query;

  try {
    const results = { lineups: {}, pitcherStats: {}, weather: null };

    // ── 1. Try to get live lineup from MLB boxscore ────────────────────
    if (game_pk) {
      try {
        const boxRes = await fetch(`https://statsapi.mlb.com/api/v1/game/${game_pk}/boxscore`);
        const boxData = await boxRes.json();

        for (const side of ["away", "home"]) {
          const teamData = boxData.teams?.[side];
          const battingOrder = teamData?.battingOrder || [];
          const players = teamData?.players || {};
          const lineup = [];

          battingOrder.forEach((id, idx) => {
            const player = players[`ID${id}`];
            if (player) {
              lineup.push({
                id,
                name: player.person?.fullName || "Unknown",
                position: player.position?.abbreviation || "",
                lineup_spot: idx + 1,
                bats: player.person?.batSide?.code || "R"
              });
            }
          });

          results.lineups[side] = lineup;
        }
      } catch {}
    }

    // ── 2. Get season stats for each lineup player ────────────────────
    const allPlayers = [
      ...(results.lineups.away || []),
      ...(results.lineups.home || [])
    ];

    const playerStats = {};
    await Promise.all(
      allPlayers.map(async (p) => {
        try {
          const sRes = await fetch(
            `https://statsapi.mlb.com/api/v1/people/${p.id}?hydrate=stats(group=hitting,type=season,season=2026)`
          );
          const sData = await sRes.json();
          const stat = sData.people?.[0]?.stats?.[0]?.splits?.[0]?.stat;
          if (stat) {
            playerStats[p.id] = {
              avg: stat.avg || ".000",
              ops: stat.ops || ".000",
              hr: stat.homeRuns || 0,
              slg: stat.slg || ".000",
              obp: stat.obp || ".000",
              ab: stat.atBats || 0,
              hits: stat.hits || 0
            };
          }
        } catch {}
      })
    );
    results.playerStats = playerStats;

    // ── 3. Get pitcher season stats ───────────────────────────────────
    for (const [key, pitcherId] of [["away", away_sp_id], ["home", home_sp_id]]) {
      if (!pitcherId || pitcherId === "null") continue;
      try {
        const pRes = await fetch(
          `https://statsapi.mlb.com/api/v1/people/${pitcherId}?hydrate=stats(group=pitching,type=season,season=2026)`
        );
        const pData = await pRes.json();
        const stat = pData.people?.[0]?.stats?.[0]?.splits?.[0]?.stat;
        if (stat) {
          results.pitcherStats[key] = {
            era: stat.era || "N/A",
            whip: stat.whip || "N/A",
            hr9: stat.homeRunsPer9 || "N/A",
            kPer9: stat.strikeoutsPer9Inn || "N/A",
            ip: stat.inningsPitched || "0",
            hr_allowed: stat.homeRuns || 0,
            gb_rate: "N/A" // MLB API doesn't expose GB rate directly
          };
        }
      } catch {}
    }

    // ── 4. Weather from Open-Meteo (free, no key) ─────────────────────
    // Venue coordinates lookup
    const venueCoords = {
      "Fenway Park": [42.3467, -71.0972],
      "Yankee Stadium": [40.8296, -73.9262],
      "Citi Field": [40.7571, -73.8458],
      "Citizens Bank Park": [39.9061, -75.1665],
      "Wrigley Field": [41.9484, -87.6553],
      "Guaranteed Rate Field": [41.8300, -87.6338],
      "Great American Ball Park": [39.0979, -84.5067],
      "Oracle Park": [37.7786, -122.3893],
      "Dodger Stadium": [34.0739, -118.2400],
      "Angel Stadium": [33.8003, -117.8827],
      "Petco Park": [32.7073, -117.1573],
      "T-Mobile Park": [47.5914, -122.3325],
      "Minute Maid Park": [29.7572, -95.3555],
      "Globe Life Field": [32.7473, -97.0842],
      "Truist Park": [33.8908, -84.4678],
      "Marlins Park": [25.7781, -80.2197],
      "loanDepot park": [25.7781, -80.2197],
      "Nationals Park": [38.8730, -77.0074],
      "PNC Park": [40.4469, -80.0057],
      "Busch Stadium": [38.6226, -90.1928],
      "American Family Field": [43.0280, -87.9712],
      "Target Field": [44.9817, -93.2781],
      "Kauffman Stadium": [39.0517, -94.4803],
      "Progressive Field": [41.4962, -81.6852],
      "Comerica Park": [42.3390, -83.0485],
      "Camden Yards": [39.2838, -76.6217],
      "Rogers Centre": [43.6414, -79.3894],
      "Tropicana Field": [27.7682, -82.6534],
      "Oakland Coliseum": [37.7516, -122.2005],
      "Sutter Health Park": [38.5804, -121.5005],
      "Las Vegas Ballpark": [36.1318, -115.1505]
    };

    const coords = Object.entries(venueCoords).find(([k]) =>
      venue && venue.toLowerCase().includes(k.toLowerCase())
    )?.[1] || [40.7128, -74.0060]; // default NYC

    try {
      const wxRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${coords[0]}&longitude=${coords[1]}&hourly=temperature_2m,windspeed_10m,winddirection_10m&temperature_unit=fahrenheit&windspeed_unit=mph&forecast_days=1&timezone=auto`
      );
      const wxData = await wxRes.json();
      // Get evening game time (~7pm = index 19)
      const idx = 19;
      results.weather = {
        temp: Math.round(wxData.hourly?.temperature_2m?.[idx] || 70) + "°F",
        wind_speed: Math.round(wxData.hourly?.windspeed_10m?.[idx] || 5) + " mph",
        wind_dir: wxData.hourly?.winddirection_10m?.[idx] || 180,
        summary: `${Math.round(wxData.hourly?.temperature_2m?.[idx] || 70)}°F, wind ${Math.round(wxData.hourly?.windspeed_10m?.[idx] || 5)} mph`
      };
    } catch {}

    return res.status(200).json(results);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
