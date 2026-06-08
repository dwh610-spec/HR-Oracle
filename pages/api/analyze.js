// pages/api/analyze.js
// v6: recency-dominant scoring + retry-on-high-traffic + tight token budget

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { game, gameData } = req.body;
  const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
  if (!CEREBRAS_KEY) return res.status(500).json({ error: "CEREBRAS_API_KEY not set" });

  const awayList = (gameData?.lineups?.away || []).slice(0, 9);
  const homeList = (gameData?.lineups?.home || []).slice(0, 9);
  const isProjected = !!gameData?.projected;
  if (awayList.length < 3 || homeList.length < 3)
    return res.status(200).json({ candidates: [], skipped: true, reason: "Not enough roster data" });

  const validNames = [...awayList, ...homeList].map(p => p.name);

  // Compact per-player line — recent + power focus, kept short to save tokens
  const fmt = (arr) => arr.map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    const pw = s.barrel_pct ? ` Brl${s.barrel_pct} HH${s.hard_hit_pct||"?"}` : "";
    return `${p.name}(${p.bats}) szHR${s.hr||0} szOPS${s.ops||"?"}|L14:HR${s.recent_hr??0} ISO${s.recent_iso||"?"} OPS${s.recent_ops||"?"}|${(s.split_label||"")[0]||""}OPS${s.split_ops||"?"}${pw}`;
  }).join("\n");

  const aP = gameData?.pitcherStats?.away || {};
  const hP = gameData?.pitcherStats?.home || {};
  const weather = gameData?.weather || {};
  const elevation = gameData?.elevation || 20;
  const slot = gameData?.isNightGame ? "NIGHT" : "DAY";

  const prompt = `Elite MLB HR model. Top 4-5 HR candidates per team for TODAY (${slot} game).
${game.away_team}@${game.home_team} ${game.venue} | elev ${elevation}ft${elevation>2000?" HIGH-carry":""}
AwaySP ${game.away_sp.name}(${game.away_sp.throws}) ERA${aP.era||game.away_sp.era} HR9 ${aP.hr9||"?"} recentHR9 ${aP.recent_hr9||"?"}
HomeSP ${game.home_sp.name}(${game.home_sp.throws}) ERA${hP.era||game.home_sp.era} HR9 ${hP.hr9||"?"} recentHR9 ${hP.recent_hr9||"?"}
${isProjected?"PROJECTED lineups (not posted).":"Confirmed lineups."}
AWAY (vs ${game.home_sp.name} ${game.home_sp.throws}HP):
${fmt(awayList)}
HOME (vs ${game.away_sp.name} ${game.away_sp.throws}HP):
${fmt(homeList)}
Weather ${weather.summary||"?"} dir${weather.wind_dir||"?"}

SCORE PRIORITY: (1) RECENT 14d form dominates — weight recent ~65%, season ~35%; a hot bat with mediocre season beats a cold star. (2) power (Brl/HH high = HRs coming). (3) pitcher recent HR9. (4) platoon handedness. (5) ${slot.toLowerCase()} split OPS. (6) park+elevation. (7) weather. Reward hot+powerful 80+, punish cold into 30s-40s. Use decimal hr_score.

Only use listed players. Return ONLY JSON:
{"candidates":[{"name":"","team":"","bats":"L","lineup_spot":3,"opposing_sp":"","sp_throws":"R","pitcher_grade":"AVERAGE","batter_grade":"HOT","hr_score":72.4,"hr_prob":"14%","key_stats":[{"label":"L14 HR","value":"4"},{"label":"L14 ISO","value":".310"},{"label":"Brl%","value":"15"},{"label":"SP HR/9","value":"1.6"}],"summary":""}]}
pitcher_grade:BATTING PRACTICE|AVERAGE|STUD. batter_grade:FIRE|HOT|AVERAGE|COLD.`;

  // Retry loop for "high traffic" / rate-limit responses
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const cbRes = await fetch("https://api.cerebras.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CEREBRAS_KEY}` },
        body: JSON.stringify({
          model: "gpt-oss-120b",
          messages: [
            { role: "system", content: "MLB HR model prioritizing recent form + power over season stats. JSON only. Only listed players." },
            { role: "user", content: prompt }
          ],
          temperature: 0.3,
          max_completion_tokens: 2500,
          response_format: { type: "json_object" }
        })
      });

      const cbData = await cbRes.json();

      // Detect transient capacity / rate-limit messages and retry
      const transient = cbData.message && /high traffic|try again|rate limit|capacity|busy/i.test(cbData.message);
      if (transient || cbRes.status === 429 || cbRes.status === 503) {
        lastErr = "CB busy: " + (cbData.message || cbRes.status);
        await sleep(attempt * 3000); // 3s, 6s, 9s backoff
        continue;
      }

      if (cbData.error || cbData.message) {
        const msg = cbData.error ? (typeof cbData.error==="string"?cbData.error:JSON.stringify(cbData.error)) : cbData.message;
        return res.status(500).json({ error: "CB: " + msg });
      }

      const rawText = cbData.choices?.[0]?.message?.content || "";
      if (!rawText) { lastErr = "empty"; await sleep(attempt*2000); continue; }

      let parsed;
      try { parsed = JSON.parse(rawText); }
      catch { const o1=rawText.indexOf("{"),o2=rawText.lastIndexOf("}"); if(o1!==-1&&o2>o1){try{parsed=JSON.parse(rawText.slice(o1,o2+1));}catch{}} }
      if (!parsed) return res.status(500).json({ error: "PARSE: " + rawText.substring(0,120) });

      let candidates = [];
      if (Array.isArray(parsed)) candidates = parsed;
      else if (Array.isArray(parsed.candidates)) candidates = parsed.candidates;
      else { const arr = Object.values(parsed).find(v=>Array.isArray(v)); if(arr) candidates=arr; }

      const validLower = validNames.map(n=>n.toLowerCase());
      candidates = candidates
        .filter(c => validLower.includes((c.name||"").toLowerCase()))
        .map(c => ({ ...c, hr_score: Math.round((parseFloat(c.hr_score)||0)*10)/10, projected: isProjected }));

      return res.status(200).json({ candidates, projected: isProjected });
    } catch (e) {
      lastErr = e.message;
      await sleep(attempt * 2000);
    }
  }

  // All retries exhausted
  return res.status(500).json({ error: "Busy after 3 retries: " + lastErr });
}
