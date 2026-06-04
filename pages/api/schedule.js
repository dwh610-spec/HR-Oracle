// pages/api/schedule.js
// Fetches today's MLB schedule from the official MLB Stats API (free, no key needed)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const today = new Date().toISOString().split("T")[0];

    // MLB Stats API — completely free, no auth required
    const mlbRes = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher(note),team,venue,weather,linescore`
    );
    const mlbData = await mlbRes.json();

    const games = [];

    for (const date of mlbData.dates || []) {
      for (const game of date.games || []) {
        const away = game.teams?.away;
        const home = game.teams?.home;
        const venue = game.venue?.name || "Unknown Venue";

        // Get probable pitchers
        const awayPitcher = away?.probablePitcher;
        const homePitcher = home?.probablePitcher;

        // Fetch pitcher stats if available
        let awayEra = "N/A", homeEra = "N/A";
        let awayThrows = "R", homeThrows = "R";

        if (awayPitcher?.id) {
          try {
            const pRes = await fetch(`https://statsapi.mlb.com/api/v1/people/${awayPitcher.id}?hydrate=stats(group=pitching,type=season,season=2026)`);
            const pData = await pRes.json();
            const stats = pData.people?.[0]?.stats?.[0]?.splits?.[0]?.stat;
            awayEra = stats?.era || "N/A";
            awayThrows = pData.people?.[0]?.pitchHand?.code || "R";
          } catch {}
        }

        if (homePitcher?.id) {
          try {
            const pRes = await fetch(`https://statsapi.mlb.com/api/v1/people/${homePitcher.id}?hydrate=stats(group=pitching,type=season,season=2026)`);
            const pData = await pRes.json();
            const stats = pData.people?.[0]?.stats?.[0]?.splits?.[0]?.stat;
            homeEra = stats?.era || "N/A";
            homeThrows = pData.people?.[0]?.pitchHand?.code || "R";
          } catch {}
        }

        // Get game time
        const gameTime = game.gameDate ? new Date(game.gameDate).toLocaleTimeString("en-US", {
          hour: "numeric", minute: "2-digit", timeZone: "America/New_York"
        }) : "TBD";

        games.push({
          game_id: `${away?.team?.abbreviation}_${home?.team?.abbreviation}`,
          game_pk: game.gamePk,
          away_team_id: away?.team?.id || null,
          home_team_id: home?.team?.id || null,
          away_team: away?.team?.abbreviation || "???",
          home_team: home?.team?.abbreviation || "???",
          away_team_full: away?.team?.name || "",
          home_team_full: home?.team?.name || "",
          time_et: gameTime,
          venue,
          status: game.status?.detailedState || "",
          away_sp: {
            id: awayPitcher?.id || null,
            name: awayPitcher?.fullName || "TBD",
            throws: awayThrows,
            era: awayEra
          },
          home_sp: {
            id: homePitcher?.id || null,
            name: homePitcher?.fullName || "TBD",
            throws: homeThrows,
            era: homeEra
          }
        });
      }
    }

    return res.status(200).json({ games, date: today });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
