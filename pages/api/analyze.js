// pages/api/analyze.js
// Uses Google Gemini to analyze HR likelihood from live data

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { game, gameData } = req.body;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_API_KEY not set" });
  async function callGeminiWithRetry(url, body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, body);
    const data = await res.json();
    if (data.error?.status === "RESOURCE_EXHAUSTED") {
      await new Promise(r => setTimeout(r, 10000 * (i + 1)));
      continue;
    }
    return data;
  }
  throw new Error("Gemini quota exceeded after retries");
}

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
2026 Stats: ERA ${awayPStats.era||game.away_sp.era}, WHIP ${awayPStats.whip||"N/A"}, HR/9 ${awayPStats.hr9||"N/A"}, K/9 ${awayPStats.kPer9||"N/A"}, HR allowed ${awayPStats.hr_allowed||"N/A"}

HOME STARTER: ${game.home_sp.name} (${game.home_sp.throws}HP)
2026 Stats: ERA ${homePStats.era||game.home_sp.era}, WHIP ${homePStats.whip||"N/A"}, HR/9 ${homePStats.hr9||"N/A"}, K/9 ${homePStats.kPer9||"N/A"}, HR allowed ${homePStats.hr_allowed||"N/A"}

AWAY LINEUP (faces home starter ${game.home_sp.name}):
${awayLineup}

HOME LINEUP (faces away starter ${game.away_sp.name}):
${homeLineup}

WEATHER AT ${game.venue}: ${weather.summary || "Unknown"}
Wind: ${weather.wind_speed || "Unknown"} from ${weather.wind_dir || "unknown"} degrees

PARK FACTORS: Use your knowledge of ${game.venue} dimensions, HR park factor, and how it plays for left vs right-handed hitters.

ANALYSIS INSTRUCTIONS:
- Identify top 4-5 HR candidates from EACH team
- Away batters face HOME starter; home batters face AWAY starter
- Weight heavily: HR pace (most important), OPS/SLG, platoon advantage vs pitcher handedness, park factors, weather (wind direction matters a lot — tailwind helps, headwind hurts)
- pitcher_grade: "BATTING PRACTICE" if ERA>4.5 or HR/9>1.3, "STUD" if ERA<3.0 and HR/9<0.8, otherwise "AVERAGE"
- batter_grade: "FIRE" if top 5% HR pace + favorable matchup, "HOT" if above average, "COLD" if poor matchup or slumping, otherwise "AVERAGE"

Return ONLY a valid JSON array, no other text:
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
    "summary": "One sentence explaining why this is a good or bad HR play today."
  }
]`;

try {
    let geminiData;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 15000));
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
          })
        }
      );
      geminiData = await geminiRes.json();
      if (!geminiData.error) break;
      if (!geminiData.error.message?.includes("quota")) throw new Error(geminiData.error.message);
    }

    if (geminiData.error) throw new Error(geminiData.error.message);

    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Parse JSON from response
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
    if (!parsed) throw new Error("Could not parse Gemini response as JSON");

    return res.status(200).json({ candidates: parsed });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
