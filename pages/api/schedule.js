// pages/api/schedule.js
// Today's MLB schedule from official MLB Stats API (free)
// v2: includes team IDs for injury/roster lookups

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    // Use US Eastern calendar date, NOT UTC. new Date().toISOString() is UTC,
    // which after ~8pm ET has already rolled to tomorrow — that's why late-night
    // runs were pulling the next day's slate. en-CA gives YYYY-MM-DD format.
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

    const mlbRes = await fetch(
      `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher(note),team,venue,linescore`
    );
    const mlbData = await mlbRes.json();

    const games = [];

    for (const date of mlbData.dates || []) {
      for (const game of date.games || []) {
        // Game state: "Preview" (upcoming), "Live" (in progress), "Final" (done).
        const abstractState = game.status?.abstractGameState || "";
        const detailed = game.status?.detailedState || "";
        const isFinal = abstractState === "Final" || /final|completed|game over/i.test(detailed);
        const isLive = abstractState === "Live" || /in progress|manager challenge|warmup|delayed/i.test(detailed);

        // Skip games that are already over — they're not actionable for HR picks.
        if (isFinal) continue;

        const away = game.teams?.away;
        const home = game.teams?.home;
        const venue = game.venue?.name || "Unknown Venue";

        const awayPitcher = away?.probablePitcher;
        const homePitcher = home?.probablePitcher;

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

        let gameTime = "TBD";
        try {
          if (game.gameDate) {
            const d = new Date(game.gameDate);
            if (!isNaN(d.getTime())) {
              gameTime = d.toLocaleTimeString("en-US", {
                hour: "numeric", minute: "2-digit", timeZone: "America/New_York"
              });
            }
          }
        } catch { gameTime = "TBD"; }

        games.push({
          game_id: `${away?.team?.abbreviation}_${home?.team?.abbreviation}`,
          game_pk: game.gamePk,
          away_team: away?.team?.abbreviation || "???",
          home_team: home?.team?.abbreviation || "???",
          away_team_id: away?.team?.id || null,
          home_team_id: home?.team?.id || null,
          time_et: gameTime,
          venue,
          status: detailed,
          live: isLive,                       // true if game already underway
          state: isLive ? "live" : "upcoming",
          away_sp: { id: awayPitcher?.id || null, name: awayPitcher?.fullName || "TBD", throws: awayThrows, era: awayEra },
          home_sp: { id: homePitcher?.id || null, name: homePitcher?.fullName || "TBD", throws: homeThrows, era: homeEra }
        });
      }
    }

    return res.status(200).json({ games, date: today });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
