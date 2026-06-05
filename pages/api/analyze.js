// pages/api/analyze.js
// Uses Cerebras (Llama 3.3 70B) with forced JSON output

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { game, gameData } = req.body;
  const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;

  if (!CEREBRAS_KEY) return res.status(500).json({ error: "CEREBRAS_API_KEY not set" });

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

  const prompt = `You are an elite MLB sabermetrics analyst. Analyze this game for home run likelihood using the live 2026 season data.

GAME: ${game.away_team} @ ${game.home_team} at ${game.venue} — ${game.time_et} ET

AWAY STARTER: ${game.away_sp.name} (${game.away_sp.throws}HP) — ERA ${awayPStats.era||game.away_sp.era}, WHIP ${awayPStats.whip||"N/A"}, HR/9 ${awayPStats.hr9||"N/A"}
HOME STARTER: ${game.home_sp.name} (${game.home_sp.throws}HP) — ERA ${homePStats.era||game.home_sp.era}, WHIP ${homePStats.whip||"N/A"}, HR/9 ${homePStats.hr9||"N/A"}

AWAY LINEUP (faces ${game.home_sp.name}):
${awayLineup}

HOME LINEUP (faces ${game.away_sp.name}):
${homeLineup}

WEATHER: ${weather.summary || "Unknown"}, wind ${weather.wind_speed || "?"}
PARK: Use your knowledge of ${game.venue} HR factors for L/R hitters.

Identify the top 4-5 HR candidates from EACH team. Away batters face the home starter; home batters face the away starter.
Weight: HR pace, OPS/SLG, platoon advantage vs pitcher hand, park factor, weather.
- pitcher_grade: "BATTING PRACTICE" (ERA>4.5 or HR/9>1.3), "STUD" (ERA<3.0 and HR/9<0.8), or "AVERAGE"
- batter_grade: "FIRE", "HOT", "AVERAGE", or "COLD"
- hr_score: integer 1-100

Respond with a JSON object containing a "candidates" array. Each candidate has: name, team, bats, lineup_spot, opposing_sp, sp_throws, pitcher_grade, batter_grade, hr_score, hr_prob (like "16%"), key_stats (array of 4 objects each with label and value), summary (one sentence).`;

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
          { role: "system", content: "You are an MLB analyst that responds only with valid JSON matching the requested schema." },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 4000,
        response_format: { type: "json_object" }
      })
    });

    const cbData = await cbRes.json();
    if (cbData.error) throw new Error(cbData.error.message || JSON.stringify(cbData.error));

    const rawText = cbData.choices?.[0]?.message?.content || "";

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // fallback: extract object
      const o1 = rawText.indexOf("{"), o2 = rawText.lastIndexOf("}");
      if (o1 !== -1 && o2 > o1) {
        parsed = JSON.parse(rawText.slice(o1, o2+1));
      } else {
        throw new Error("Could not parse JSON");
      }
    }

    // Accept either {candidates:[...]} or a bare array
    let candidates = [];
    if (Array.isArray(parsed)) candidates = parsed;
    else if (Array.isArray(parsed.candidates)) candidates = parsed.candidates;
    else if (Array.isArray(parsed.players)) candidates = parsed.players;
    else if (Array.isArray(parsed.batters)) candidates = parsed.batters;
    else {
      // find first array value in the object
      const arr = Object.values(parsed).find(v => Array.isArray(v));
      if (arr) candidates = arr;
    }

    return res.status(200).json({ candidates });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
