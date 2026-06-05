// pages/api/analyze.js
// Uses Cerebras (Llama 3.3 70B) to analyze HR likelihood from live data

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { game, gameData } = req.body;
  const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;

  if (!CEREBRAS_KEY) return res.status(500).json({ error: "CEREBRAS_API_KEY not set" });

  // Build rich context from live data
  const awayLineup = (gameData?.lineups?.away || []).map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    return `${p.lineup_spot}. ${p.name} (${p.bats}HB) — AVG ${s.avg||"?"}, HR ${s.hr||"?"}, OPS ${s.ops||"?"}, SLG ${s.slg||"?"}`;
  }).join("\n") || "Lineup not yet available";

  const homeLineup = (gameData?.lineups?.home || []).map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    return `${p.lineup_spot}. ${p.name} (${p.bats}HB) — AVG ${s.avg||"?"}, HR ${s.hr||"?"}, OPS ${s.ops||"?"}, SLG ${s.slg||"?"}`;
  }).join("\n") || "Lineup not yet available";

  const awayPStats = gameData?.pitcherStats?.away || {};
  const homePStats = gameData?.pitcherStats?.home || {};
  const weather = gameData?.weather || {};

  const prompt = `You are an elite MLB sabermetrics analyst. Analyze this game for home run likelihood using the live 2026 season data provided.

GAME: ${game.away_team} @ ${game.home_team} at ${game.venue} — ${game.time_et} ET

AWAY STARTER: ${game.away_sp.name} (${game.away_sp.throws}HP)
2026 Stats: ERA ${awayPStats.era||game.away_sp.era}, WHIP ${awayPStats.whip||"N/A"}, HR/9 ${awayPStats.hr9||"N/A"}, HR allowed ${awayPStats.hr_allowed||"N/A"}

HOME STARTER: ${game.home_sp.name} (${game.home_sp.throws}HP)
2026 Stats: ERA ${homePStats.era||game.home_sp.era}, WHIP ${homePStats.whip||"N/A"}, HR/9 ${homePStats.hr9||"N/A"}, HR allowed ${homePStats.hr_allowed||"N/A"}

AWAY LINEUP (faces home starter ${game.home_sp.name}):
${awayLineup}

HOME LINEUP (faces away starter ${game.away_sp.name}):
${homeLineup}

WEATHER AT ${game.venue}: ${weather.summary || "Unknown"}, wind ${weather.wind_speed || "?"} from ${weather.wind_dir || "?"} degrees

PARK: Use your knowledge of ${game.venue} dimensions and HR park factor for L/R hitters.

INSTRUCTIONS:
- Identify top 4-5 HR candidates from EACH team
- Away batters face HOME starter; home batters face AWAY starter
- Weight: HR pace (most important), OPS/SLG, platoon advantage vs pitcher hand, park factors, weather (tailwind helps, headwind hurts)
- pitcher_grade: "BATTING PRACTICE" if ERA>4.5 or HR/9>1.3, "STUD" if ERA<3.0 and HR/9<0.8, else "AVERAGE"
- batter_grade: "FIRE" if elite HR pace + good matchup, "HOT" if above average, "COLD" if poor/slumping, else "AVERAGE"

Return ONLY a valid JSON array, no other text, no markdown:
[
  {
    "name": "Player Name",
    "team": "TEAM_ABB",
    "bats": "L",
    "lineup_spot": 3,
    "opposing_sp": "Pitcher Name",
    "sp_throws": "R",
    "pitcher_grade": "BATTING PRACTICE",
    "batter_grade": "FIRE",
    "hr_score": 78,
    "hr_prob": "16%",
    "key_stats": [
      { "label": "HR 2026", "value": "19" },
      { "label": "SLG", "value": ".582" },
      { "label": "OPS", "value": ".952" },
      { "label": "Pitcher HR/9", "value": "1.4" }
    ],
    "summary": "One sentence on why this is a good or bad HR play today."
  }
]`;

  try {
    const cbRes = await fetch("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CEREBRAS_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 4000
      })
    });

    const cbData = await cbRes.json();
    if (cbData.error) throw new Error(cbData.error.message || JSON.stringify(cbData.error));

    const rawText = cbData.choices?.[0]?.message?.content || "";

    // Parse JSON
    const t = rawText.trim();
    let parsed;
    const a1 = t.indexOf("["), a2 = t.lastIndexOf("]");
    if (a1 !== -1 && a2 > a1) {
      try { parsed = JSON.parse(t.slice(a1, a2+1)); } catch {}
    }
    if (!parsed) {
      const stripped = t.replace(/```(?:json)?/gi,"").trim();
      const b1 = stripped.indexOf("["), b2 = stripped.lastIndexOf("]");
      if (b1 !== -1 && b2 > b1) {
        try { parsed = JSON.parse(stripped.slice(b1, b2+1)); } catch {}
      }
    }
    if (!parsed) throw new Error("Could not parse response as JSON");

    return res.status(200).json({ candidates: parsed });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
