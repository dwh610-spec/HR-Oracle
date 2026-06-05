// pages/api/analyze.js
// Cerebras (Llama 3.3 70B) — with debug output on parse failure

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { game, gameData } = req.body;
  const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;

  if (!CEREBRAS_KEY) return res.status(500).json({ error: "CEREBRAS_API_KEY not set" });

  const awayLineup = (gameData?.lineups?.away || []).map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    return `${p.lineup_spot}. ${p.name} (${p.bats}HB) — AVG ${s.avg||"?"}, HR ${s.hr||"?"}, OPS ${s.ops||"?"}`;
  }).join("\n") || "Lineup not available";

  const homeLineup = (gameData?.lineups?.home || []).map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    return `${p.lineup_spot}. ${p.name} (${p.bats}HB) — AVG ${s.avg||"?"}, HR ${s.hr||"?"}, OPS ${s.ops||"?"}`;
  }).join("\n") || "Lineup not available";

  const awayPStats = gameData?.pitcherStats?.away || {};
  const homePStats = gameData?.pitcherStats?.home || {};
  const weather = gameData?.weather || {};

  const prompt = `Analyze this MLB game for home run likelihood. Identify the top 4-5 HR candidates from EACH team.

GAME: ${game.away_team} @ ${game.home_team} at ${game.venue}
AWAY SP: ${game.away_sp.name} (${game.away_sp.throws}HP) ERA ${awayPStats.era||game.away_sp.era}, HR/9 ${awayPStats.hr9||"N/A"}
HOME SP: ${game.home_sp.name} (${game.home_sp.throws}HP) ERA ${homePStats.era||game.home_sp.era}, HR/9 ${homePStats.hr9||"N/A"}

AWAY LINEUP (faces ${game.home_sp.name}):
${awayLineup}

HOME LINEUP (faces ${game.away_sp.name}):
${homeLineup}

WEATHER: ${weather.summary || "Unknown"}

Away batters face the home starter; home batters face the away starter.
Weight HR pace, OPS, platoon advantage, park factor at ${game.venue}, and weather.

Return a JSON object with this exact structure:
{
  "candidates": [
    {
      "name": "Player Name",
      "team": "${game.away_team}",
      "bats": "L",
      "lineup_spot": 3,
      "opposing_sp": "${game.home_sp.name}",
      "sp_throws": "${game.home_sp.throws}",
      "pitcher_grade": "AVERAGE",
      "batter_grade": "HOT",
      "hr_score": 72,
      "hr_prob": "14%",
      "key_stats": [
        {"label": "HR 2026", "value": "15"},
        {"label": "OPS", "value": ".880"},
        {"label": "AVG", "value": ".285"},
        {"label": "SP HR/9", "value": "1.2"}
      ],
      "summary": "Brief insight."
    }
  ]
}

pitcher_grade is one of: "BATTING PRACTICE", "AVERAGE", "STUD".
batter_grade is one of: "FIRE", "HOT", "AVERAGE", "COLD".
hr_score is an integer 1-100.`;

  let rawText = "";
  try {
    const cbRes = await fetch("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CEREBRAS_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b",
        messages: [
          { role: "system", content: "You respond only with valid JSON. No markdown, no explanation." },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 4000,
        response_format: { type: "json_object" }
      })
    });

    const cbData = await cbRes.json();

    if (cbData.error) {
      return res.status(500).json({ error: "Cerebras API: " + (cbData.error.message || JSON.stringify(cbData.error)) });
    }

    rawText = cbData.choices?.[0]?.message?.content || "";

    if (!rawText) {
      return res.status(500).json({ error: "Empty response. Data: " + JSON.stringify(cbData).substring(0, 300) });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      const o1 = rawText.indexOf("{"), o2 = rawText.lastIndexOf("}");
      if (o1 !== -1 && o2 > o1) {
        try { parsed = JSON.parse(rawText.slice(o1, o2+1)); } catch {}
      }
    }

    if (!parsed) {
      return res.status(500).json({ error: "Parse fail. Raw: " + rawText.substring(0, 250) });
    }

    let candidates = [];
    if (Array.isArray(parsed)) candidates = parsed;
    else if (Array.isArray(parsed.candidates)) candidates = parsed.candidates;
    else {
      const arr = Object.values(parsed).find(v => Array.isArray(v));
      if (arr) candidates = arr;
    }

    if (!candidates.length) {
      return res.status(500).json({ error: "No candidates in: " + JSON.stringify(parsed).substring(0, 200) });
    }

    return res.status(200).json({ candidates });
  } catch (e) {
    return res.status(500).json({ error: e.message + " | raw: " + rawText.substring(0, 150) });
  }
}
