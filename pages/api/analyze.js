// pages/api/analyze.js
// Cerebras (Llama 3.3 70B) — full error capture, free-tier token limits

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { game, gameData } = req.body;
  const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;

  if (!CEREBRAS_KEY) return res.status(500).json({ error: "CEREBRAS_API_KEY not set" });

  // Keep lineups compact to stay under the 8192-token free-tier cap
  const fmt = (arr) => (arr || []).slice(0, 9).map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    return `${p.lineup_spot}.${p.name}(${p.bats}) HR${s.hr||"?"} OPS${s.ops||"?"}`;
  }).join("; ") || "TBD";

  const awayLineup = fmt(gameData?.lineups?.away);
  const homeLineup = fmt(gameData?.lineups?.home);
  const awayP = gameData?.pitcherStats?.away || {};
  const homeP = gameData?.pitcherStats?.home || {};
  const weather = gameData?.weather || {};

  const prompt = `MLB HR analysis. Top 4-5 HR candidates per team.

${game.away_team} @ ${game.home_team} at ${game.venue}
Away SP ${game.away_sp.name} (${game.away_sp.throws}) ERA ${awayP.era||game.away_sp.era} HR/9 ${awayP.hr9||"?"}
Home SP ${game.home_sp.name} (${game.home_sp.throws}) ERA ${homeP.era||game.home_sp.era} HR/9 ${homeP.hr9||"?"}
Away lineup (vs ${game.home_sp.name}): ${awayLineup}
Home lineup (vs ${game.away_sp.name}): ${homeLineup}
Weather: ${weather.summary||"?"}

Away batters face home SP; home batters face away SP. Weight HR pace, OPS, platoon, ${game.venue} park factor, weather.

Return JSON: {"candidates":[{"name","team","bats","lineup_spot","opposing_sp","sp_throws","pitcher_grade","batter_grade","hr_score","hr_prob","key_stats":[{"label","value"}],"summary"}]}
pitcher_grade: BATTING PRACTICE|AVERAGE|STUD. batter_grade: FIRE|HOT|AVERAGE|COLD. hr_score: 1-100 int. 4 key_stats each.`;

  let rawText = "", fullError = "";
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
          { role: "system", content: "Respond only with valid JSON." },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        max_completion_tokens: 3000,
        response_format: { type: "json_object" }
      })
    });

    const cbData = await cbRes.json();

    if (cbData.error) {
      // Capture the COMPLETE error message
      fullError = typeof cbData.error === "string" ? cbData.error : JSON.stringify(cbData.error);
      return res.status(500).json({ error: "CB_ERR: " + fullError });
    }

    rawText = cbData.choices?.[0]?.message?.content || "";
    if (!rawText) {
      return res.status(500).json({ error: "EMPTY. Full: " + JSON.stringify(cbData) });
    }

    let parsed;
    try { parsed = JSON.parse(rawText); }
    catch {
      const o1 = rawText.indexOf("{"), o2 = rawText.lastIndexOf("}");
      if (o1 !== -1 && o2 > o1) { try { parsed = JSON.parse(rawText.slice(o1, o2+1)); } catch {} }
    }
    if (!parsed) return res.status(500).json({ error: "PARSE_FAIL: " + rawText.substring(0, 200) });

    let candidates = [];
    if (Array.isArray(parsed)) candidates = parsed;
    else if (Array.isArray(parsed.candidates)) candidates = parsed.candidates;
    else { const arr = Object.values(parsed).find(v => Array.isArray(v)); if (arr) candidates = arr; }

    if (!candidates.length) return res.status(500).json({ error: "NO_CANDS: " + JSON.stringify(parsed).substring(0, 200) });

    return res.status(200).json({ candidates });
  } catch (e) {
    return res.status(500).json({ error: "CATCH: " + e.message });
  }
}
