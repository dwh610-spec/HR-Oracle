// pages/api/analyzetest.js
// Runs ONE game through the REAL heavy pipeline (gamedata + analyze) and
// times each stage. Reveals whether the failure is a timeout, the data
// layer, or the AI. Visit /api/analyzetest in the browser.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const t0 = Date.now();
  const timing = {};
  const mark = (label, since) => { timing[label] = (Date.now() - since) + "ms"; };

  try {
    const host = req.headers.host;
    const proto = host.startsWith("localhost") ? "http" : "https";
    const base = `${proto}://${host}`;
    const today = new Date().toISOString().split("T")[0];

    // 1. schedule
    let s = Date.now();
    const schedR = await fetch(`${base}/api/schedule`);
    const sched = await schedR.json();
    mark("1_schedule", s);
    const games = sched.games || [];
    if (!games.length) return res.status(200).json({ stop:"no games", timing });

    // pick the first game
    const g = games[0];
    const result = { testGame: `${g.away_team} @ ${g.home_team}`, timing };

    // 2. gamedata (the heavy step — ~60 fetches)
    s = Date.now();
    let gameData;
    try {
      const gdR = await fetch(`${base}/api/gamedata?game_pk=${g.game_pk}&away_team=${g.away_team}&home_team=${g.home_team}&venue=${encodeURIComponent(g.venue)}&away_sp_id=${g.away_sp.id||""}&home_sp_id=${g.home_sp.id||""}&away_team_id=${g.away_team_id||""}&home_team_id=${g.home_team_id||""}&game_time=${encodeURIComponent(g.time_et||"")}`);
      result.gamedataStatus = gdR.status;
      gameData = await gdR.json();
      mark("2_gamedata", s);
      result.gamedataError = gameData.error || null;
      result.lineupsPosted = gameData.lineupsPosted;
      result.projected = gameData.projected;
      result.awayLineupCount = (gameData.lineups?.away||[]).length;
      result.homeLineupCount = (gameData.lineups?.home||[]).length;
      result.savantUsed = gameData.savantUsed;
      result.injuredCount = (gameData.injured||[]).length;
    } catch (e) {
      mark("2_gamedata_FAILED", s);
      result.gamedataException = e.message;
      return res.status(200).json(result);
    }

    // 3. analyze
    s = Date.now();
    try {
      const anR = await fetch(`${base}/api/analyze`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ game: g, gameData })
      });
      result.analyzeStatus = anR.status;
      const an = await anR.json();
      mark("3_analyze", s);
      result.analyzeError = an.error || null;
      result.analyzeSkipped = an.skipped || false;
      result.candidateCount = (an.candidates||[]).length;
      result.sampleCandidate = an.candidates?.[0] || null;
    } catch (e) {
      mark("3_analyze_FAILED", s);
      result.analyzeException = e.message;
    }

    result.totalTime = (Date.now() - t0) + "ms";
    result.note = "Vercel free-tier function timeout is 10000ms (10s). If any single stage approaches that, that's the bottleneck.";
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ fatalError: e.message, timing, totalTime: (Date.now()-t0)+"ms" });
  }
}
