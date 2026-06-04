// pages/api/analyze.js
// Uses Google Gemini to analyze HR likelihood — forces clean JSON output

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { game, gameData } = req.body;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_API_KEY not set" });

  const awayLineup = (gameData?.lineups?.away || []).map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    return `${p.lineup_spot}. ${p.name} (${p.bats}HB) — AVG ${s.avg||"?"}, HR ${s.hr||"?"}, OPS ${s.ops||"?"}, SLG ${s.slg||"?"}`;
  }).join("\n") || "Lineup not yet posted — use your knowledge of this team's regulars";

  const homeLineup = (gameData?.lineups?.home || []).map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    return `${p.lineup_spot}. ${p.name} (${p.bats}HB) — AVG ${s.avg||"?"}, HR ${s.hr||"?"}, OPS ${s.ops||"?"}, SLG ${s.slg||"?"}`;
  }).join("\n") || "Lineup not yet posted — use your knowledge of this team's regulars";

  const aP = gameData?.pitcherStats?.away || {};
  const hP = gameData?.pitcherStats?.home || {};
  const weather = gameData?.weather || {};

  const prompt = `You are an elite MLB sabermetrics analyst. Analyze this game for home run likelihood.

GAME: ${game.away_team} @ ${game.home_team} at ${game.venue} — ${game.time_et} ET

AWAY STARTER: ${game.away_sp.name} (${game.away_sp.throws}HP) — ERA ${aP.era||game.away_sp.era}, WHIP ${aP.whip||"N/A"}, HR/9 ${aP.hr9||"N/A"}, HR allowed ${aP.hr_allowed||"N/A"}
HOME STARTER: ${game.home_sp.name} (${game.home_sp.throws}HP) — ERA ${hP.era||game.home_sp.era}, WHIP ${hP.whip||"N/A"}, HR/9 ${hP.hr9||"N/A"}, HR allowed ${hP.hr_allowed||"N/A"}

AWAY LINEUP (faces ${game.home_sp.name}):
${awayLineup}

HOME LINEUP (faces ${game.away_sp.name}):
${homeLineup}

WEATHER: ${weather.summary || "typical conditions"}, wind from ${weather.wind_dir || "?"}°

Identify the top 4-5 HR candidates from EACH team. Weight: HR pace, SLG/OPS, platoon advantage vs pitcher hand, park factors at ${game.venue}, weather. Away batters face home starter; home batters face away starter.

Grading:
- pitcher_grade: "BATTING PRACTICE" (ERA>4.5 or HR/9>1.3), "STUD" (ERA<3.0 and HR/9<0.8), else "AVERAGE"
- batter_grade: "FIRE" (elite HR pace + great matchup), "HOT" (above avg), "COLD" (poor/slumping), else "AVERAGE"

Return a JSON array of batter objects. Each: name, team, bats, lineup_spot, opposing_sp, sp_throws, pitcher_grade, batter_grade, hr_score (integer 1-100), hr_prob (like "15%"), key_stats (array of 4 objects each with label and value), summary (one sentence).`;

  // Schema forces Gemini to return clean JSON
  const responseSchema = {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties: {
        name: { type: "STRING" },
        team: { type: "STRING" },
        bats: { type: "STRING" },
        lineup_spot: { type: "INTEGER" },
        opposing_sp: { type: "STRING" },
        sp_throws: { type: "STRING" },
        pitcher_grade: { type: "STRING" },
        batter_grade: { type: "STRING" },
        hr_score: { type: "INTEGER" },
        hr_prob: { type: "STRING" },
        key_stats: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: { label: { type: "STRING" }, value: { type: "STRING" } },
            required: ["label", "value"]
          }
        },
        summary: { type: "STRING" }
      },
      required: ["name","team","bats","opposing_sp","sp_throws","pitcher_grade","batter_grade","hr_score","hr_prob","key_stats","summary"]
    }
  };

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 2048,
            responseMimeType: "application/json",
            responseSchema
          }
        })
      }
    );

let geminiData = await geminiRes.json();

    // Retry on rate limit (429) up to 3 times with increasing waits
    let retries = 0;
    while (geminiData.error && /429|quota|rate|exceeded/i.test(JSON.stringify(geminiData.error)) && retries < 3) {
      retries++;
      await new Promise(r => setTimeout(r, 8000 * retries)); // 8s, 16s, 24s
      const retryRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
        { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
        })}
      );
      geminiData = await retryRes.json();
    }

    if (geminiData.error) {
      throw new Error(JSON.stringify(geminiData.error).substring(0, 200));}
  
      const retryDelay = geminiData.error.details?.find(d => d["@type"]?.includes("RetryInfo"))?.retryDelay;
      const waitMs = retryDelay ? parseInt(retryDelay) * 1000 : 20000;
      await new Promise(r => setTimeout(r, Math.min(waitMs, 25000)));
      const retryRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
        { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
        })}
      );
      geminiData = await retryRes.json();
    }

    if (geminiData.error) {
      const full = JSON.stringify(geminiData.error).substring(0, 300);
      throw new Error(full);
    }

    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!rawText) throw new Error("Empty Gemini response");

    // With responseSchema, output should be clean JSON already
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      // Fallback extraction
      const a1 = rawText.indexOf("["), a2 = rawText.lastIndexOf("]");
      if (a1 !== -1 && a2 > a1) parsed = JSON.parse(rawText.slice(a1, a2+1));
    }
    if (!Array.isArray(parsed)) throw new Error("Response was not an array");

    return res.status(200).json({ candidates: parsed });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
