// pages/api/analyze.js
// Uses Google Gemini to analyze HR likelihood from live data

// Simple in-memory rate limiter
const lastCallTime = { t: 0 };

async function geminiWithRetry(prompt, apiKey, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    // Enforce minimum 5 seconds between calls
    const now = Date.now();
    const elapsed = now - lastCallTime.t;
    if (elapsed < 5000) {
      await new Promise(r => setTimeout(r, 5000 - elapsed + 500));
    }
    lastCallTime.t = Date.now();

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
        })
      }
    );

    const data = await res.json();

    // If rate limited, wait and retry
    if (data.error?.status === "RESOURCE_EXHAUSTED") {
      const waitMs = (attempt + 1) * 10000;
      console.log(`Rate limited, waiting ${waitMs}ms before retry ${attempt + 1}`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    if (data.error) throw new Error(data.error.message);

    return data;
  }
  throw new Error("Gemini rate limit exceeded after retries");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { game, gameData } = req.body;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_API_KEY not set" });

  const awayLineup = (gameData?.lineups?.away || []).map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    return `${p.lineup_spot}. ${p.name} (${p.bats}HB) - AVG ${s.avg||"?"}, HR ${s.hr||"?"}, OPS ${s.ops||"?"}, SLG ${s.slg||"?"}`;
  }).join("\n") || "Lineup not yet available";

  const homeLineup = (gameData?.lineups?.home || []).map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    return `${p.lineup_spot}. ${p.name} (${p.bats}HB) - AVG ${s.avg||"?"}, HR ${s.hr||"?"}, OPS ${s.ops||"?"}, SLG ${s.slg||"?"}`;
  }).join("\n") || "Lineup not yet available";

  const awayPStats = gameData?.pitcherStats?.away || {};
  const homePStats = gameData?.pitcherStats?.home || {};
  const weather = gameData?.weather || {};

  const prompt = `You are an elite MLB sabermetrics analyst. Analyze this game for home run likelihood.

GAME: ${game.away_team} @ ${game.home_team} at ${game.venue} - ${game.time_et} ET

AWAY STARTER: ${game.away_sp.name} (${game.away_sp.throws}HP)
2026 Stats: ERA ${awayPStats.era||game.away_sp.era}, WHIP ${awayPStats.whip||"N/A"}, HR/9 ${awayPStats.hr9||"N/A"}, HR allowed ${awayPStats.hr_allowed||"N/A"}

HOME STARTER: ${game.home_sp.name} (${game.home_sp.throws}HP)
2026 Stats: ERA ${homePStats.era||game.home_sp.era}, WHIP ${homePStats.whip||"N/A"}, HR/9 ${homePStats.hr9||"N/A"}, HR allowed ${homePStats.hr_allowed||"N/A"}

AWAY LINEUP (faces home starter ${game.home_sp.name}):
${awayLineup}

HOME LINEUP (faces away starter ${game.away_sp.name}):
${homeLineup}

WEATHER: ${weather.summary || "Unknown"}, Wind: ${weather.wind_speed || "Unknown"}

Identify top 4-5 HR candidates from EACH team. Weight: HR pace, OPS/SLG, platoon advantage, park factors at ${game.venue}, weather.

Return ONLY a JSON array starting with [:
[
  {
    "name": "Player Name",
    "team": "TEAM",
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
    "summary": "One sentence explaining this HR play."
  }
]
pitcher_grade: BATTING PRACTICE, AVERAGE, or STUD only
batter_grade: FIRE, HOT, AVERAGE, or COLD only
hr_score: integer 1-100
Output ONLY the JSON array.`;

  try {
    const geminiData = await geminiWithRetry(prompt, GEMINI_KEY);
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";

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
