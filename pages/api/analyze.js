// pages/api/analyze.js
// Cerebras gpt-oss-120b — handles confirmed AND projected lineups

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { game, gameData } = req.body;
  const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
  if (!CEREBRAS_KEY) return res.status(500).json({ error: "CEREBRAS_API_KEY not set" });

  const awayList = gameData?.lineups?.away || [];
  const homeList = gameData?.lineups?.home || [];
  const isProjected = !!gameData?.projected;

  // Need at least some hitters to work with
  if (awayList.length < 3 || homeList.length < 3) {
    return res.status(200).json({ candidates: [], skipped: true, reason: "Not enough roster data" });
  }

  const validNames = [...awayList, ...homeList].map(p => p.name);

  const fmt = (arr) => arr.map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    return `${p.name}(${p.bats}) HR${s.hr||"?"} OPS${s.ops||"?"} AVG${s.avg||"?"}`;
  }).join("; ") || "none";

  const awayLineup = fmt(awayList);
  const homeLineup = fmt(homeList);
  const awayP = gameData?.pitcherStats?.away || {};
  const homeP = gameData?.pitcherStats?.home || {};
  const weather = gameData?.weather || {};

  const lineupNote = isProjected
    ? `NOTE: Official lineups are NOT posted yet. The players below are the healthy active roster regulars (injured players already removed). Project the most likely HR threats and estimate batting order positions.`
    : `These are the CONFIRMED posted starting lineups.`;

  const prompt = `MLB home run analysis. Identify the top 4-5 HR candidates per team.

${game.away_team} @ ${game.home_team} at ${game.venue}
Away SP ${game.away_sp.name} (${game.away_sp.throws}) ERA ${awayP.era||game.away_sp.era} HR/9 ${awayP.hr9||"?"}
Home SP ${game.home_sp.name} (${game.home_sp.throws}) ERA ${homeP.era||game.home_sp.era} HR/9 ${homeP.hr9||"?"}

${lineupNote}

Away players (vs ${game.home_sp.name}): ${awayLineup}
Home players (vs ${game.away_sp.name}): ${homeLineup}
Weather: ${weather.summary||"?"}

CRITICAL RULES:
- You may ONLY select players from the lists above. Do NOT add any player not listed.
- Do NOT use prior knowledge of rosters; the lists above are the ONLY valid players.
- Away batters face home SP; home batters face away SP.
- Weight HR pace, OPS, platoon advantage vs pitcher hand, ${game.venue} park factor, and weather.
- For hr_score, use a DECIMAL with one decimal place (e.g. 72.4).
- For lineup_spot, estimate the likely batting order position (1-9).

Return ONLY this JSON (no markdown): {"candidates":[{"name":"","team":"","bats":"L","lineup_spot":3,"opposing_sp":"","sp_throws":"R","pitcher_grade":"AVERAGE","batter_grade":"HOT","hr_score":72.4,"hr_prob":"14%","key_stats":[{"label":"HR 2026","value":"15"},{"label":"OPS","value":".880"},{"label":"AVG","value":".285"},{"label":"SP HR/9","value":"1.2"}],"summary":""}]}
pitcher_grade: BATTING PRACTICE|AVERAGE|STUD. batter_grade: FIRE|HOT|AVERAGE|COLD. hr_score: decimal 1.0-100.0.`;

  let rawText = "";
  try {
    const cbRes = await fetch("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CEREBRAS_KEY}` },
      body: JSON.stringify({
        model: "gpt-oss-120b",
        messages: [
          { role: "system", content: "You are an MLB analyst. Respond only with valid JSON. Only use players from the provided lists; never invent players from memory." },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        max_completion_tokens: 4000,
        response_format: { type: "json_object" }
      })
    });

    const cbData = await cbRes.json();
    if (cbData.error || cbData.message) {
      const msg = cbData.error ? (typeof cbData.error==="string"?cbData.error:JSON.stringify(cbData.error)) : cbData.message;
      return res.status(500).json({ error: "CB: " + msg });
    }

    rawText = cbData.choices?.[0]?.message?.content || "";
    if (!rawText) return res.status(500).json({ error: "EMPTY" });

    let parsed;
    try { parsed = JSON.parse(rawText); }
    catch {
      const o1 = rawText.indexOf("{"), o2 = rawText.lastIndexOf("}");
      if (o1 !== -1 && o2 > o1) { try { parsed = JSON.parse(rawText.slice(o1,o2+1)); } catch {} }
    }
    if (!parsed) return res.status(500).json({ error: "PARSE: " + rawText.substring(0,150) });

    let candidates = [];
    if (Array.isArray(parsed)) candidates = parsed;
    else if (Array.isArray(parsed.candidates)) candidates = parsed.candidates;
    else { const arr = Object.values(parsed).find(v => Array.isArray(v)); if (arr) candidates = arr; }

    // Hard filter: only real listed players
    const validLower = validNames.map(n => n.toLowerCase());
    candidates = candidates.filter(c => validLower.includes((c.name||"").toLowerCase()));

    // normalize decimal + tag projected status
    candidates = candidates.map(c => ({
      ...c,
      hr_score: Math.round((parseFloat(c.hr_score)||0) * 10) / 10,
      projected: isProjected
    }));

    return res.status(200).json({ candidates, projected: isProjected });
  } catch (e) {
    return res.status(500).json({ error: "CATCH: " + e.message });
  }
}
