// pages/api/analyze.js
// v7: trimmed to fit the free-tier 8,192-token cap (prompt + completion)

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { game, gameData } = req.body;
  const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
  if (!CEREBRAS_KEY) return res.status(500).json({ error: "CEREBRAS_API_KEY not set" });

  // Limit to the 7 most relevant hitters per side to keep tokens down.
  // For projected lineups they're already sorted by recent OPS; for posted,
  // top-7 lineup spots are where HR threats concentrate anyway.
  const awayList = (gameData?.lineups?.away || []).slice(0, 7);
  const homeList = (gameData?.lineups?.home || []).slice(0, 7);
  const isProjected = !!gameData?.projected;
  if (awayList.length < 3 || homeList.length < 3)
    return res.status(200).json({ candidates: [], skipped: true, reason: "Not enough roster data" });

  const validNames = [...awayList, ...homeList].map(p => p.name);

  // Ultra-compact stat line
  const fmt = (arr) => arr.map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    const brl = s.barrel_pct ? `Brl${s.barrel_pct}` : "";
    return `${p.name}(${p.bats}) L14:HR${s.recent_hr??0}/ISO${s.recent_iso||"?"}/OPS${s.recent_ops||"?"} sz:HR${s.hr||0}/OPS${s.ops||"?"} ${brl}`;
  }).join("\n");

  const aP = gameData?.pitcherStats?.away || {};
  const hP = gameData?.pitcherStats?.home || {};
  const weather = gameData?.weather || {};
  const elevation = gameData?.elevation || 20;
  const slot = gameData?.isNightGame ? "N" : "D";

  // Concise prompt
  const prompt = `MLB HR model. Pick top 3-4 HR candidates per team for today.
${game.away_team}@${game.home_team} ${game.venue} elev${elevation}${elevation>2000?"(HIGH carry)":""} ${slot}game
AwaySP ${game.away_sp.name}(${game.away_sp.throws}) ERA${aP.era||game.away_sp.era} HR9 ${aP.hr9||"?"}/recent${aP.recent_hr9||"?"}
HomeSP ${game.home_sp.name}(${game.home_sp.throws}) ERA${hP.era||game.home_sp.era} HR9 ${hP.hr9||"?"}/recent${hP.recent_hr9||"?"}
${isProjected?"PROJECTED lineup.":"Confirmed."}
AWAY (vs ${game.home_sp.throws}HP):
${fmt(awayList)}
HOME (vs ${game.away_sp.throws}HP):
${fmt(homeList)}
Wx ${weather.summary||"?"}

PRIORITY: recent 14d form dominates (~65%) over season (~35%) — hot bat beats cold star. Then power(Brl), pitcher recent HR9, platoon vs SP hand, park/elevation, weather. Hot+powerful=80+, cold=30s-40s. Decimal scores.
Only listed players. JSON only:
{"candidates":[{"name":"","team":"","bats":"L","lineup_spot":3,"opposing_sp":"","sp_throws":"R","pitcher_grade":"AVERAGE","batter_grade":"HOT","hr_score":72.4,"hr_prob":"14%","key_stats":[{"label":"L14 HR","value":"4"},{"label":"L14 ISO","value":".310"},{"label":"Brl%","value":"15"},{"label":"SP HR9","value":"1.6"}],"summary":"short"}]}
grades: pitcher=BATTING PRACTICE|AVERAGE|STUD batter=FIRE|HOT|AVERAGE|COLD`;

  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const cbRes = await fetch("https://api.cerebras.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CEREBRAS_KEY}` },
        body: JSON.stringify({
          model: "gpt-oss-120b",
          messages: [
            { role: "system", content: "MLB HR model. Recent form + power over season. JSON only. Listed players only. Keep summaries under 12 words." },
            { role: "user", content: prompt }
          ],
          temperature: 0.3,
          max_completion_tokens: 1800,
          response_format: { type: "json_object" }
        })
      });

      const cbData = await cbRes.json();

      const transient = cbData.message && /high traffic|try again|rate limit|capacity|busy/i.test(cbData.message);
      if (transient || cbRes.status === 429 || cbRes.status === 503) {
        lastErr = "busy: " + (cbData.message || cbRes.status);
        await sleep(attempt * 3000);
        continue;
      }
      if (cbData.error || cbData.message) {
        const msg = cbData.error ? (typeof cbData.error==="string"?cbData.error:JSON.stringify(cbData.error)) : cbData.message;
        return res.status(500).json({ error: "CB: " + msg });
      }

      const rawText = cbData.choices?.[0]?.message?.content || "";
      const finishReason = cbData.choices?.[0]?.finish_reason || "";
      if (!rawText) { lastErr="empty"; await sleep(attempt*2000); continue; }

      let parsed;
      try { parsed = JSON.parse(rawText); }
      catch {
        // attempt to repair truncated JSON: close any open array/object
        let repair = rawText.slice(0, rawText.lastIndexOf("}") + 1);
        // count brackets to close the candidates array
        if (repair && !repair.trim().endsWith("]}")) repair += "]}";
        try { parsed = JSON.parse(repair); } catch {}
        if (!parsed) {
          const o1=rawText.indexOf("{"),o2=rawText.lastIndexOf("}");
          if(o1!==-1&&o2>o1){try{parsed=JSON.parse(rawText.slice(o1,o2+1));}catch{}}
        }
      }
      if (!parsed) {
        // If truncated (finish_reason=length), retry once smaller
        if (finishReason === "length" && attempt < 3) { lastErr="truncated"; continue; }
        return res.status(500).json({ error: "PARSE("+finishReason+"): " + rawText.substring(0,100) });
      }

      let candidates = [];
      if (Array.isArray(parsed)) candidates = parsed;
      else if (Array.isArray(parsed.candidates)) candidates = parsed.candidates;
      else { const arr = Object.values(parsed).find(v=>Array.isArray(v)); if(arr) candidates=arr; }

      const validLower = validNames.map(n=>n.toLowerCase());
      candidates = candidates
        .filter(c => c && c.name && validLower.includes((c.name||"").toLowerCase()))
        .map(c => ({ ...c, hr_score: Math.round((parseFloat(c.hr_score)||0)*10)/10, projected: isProjected }));

      return res.status(200).json({ candidates, projected: isProjected });
    } catch (e) {
      lastErr = e.message;
      await sleep(attempt * 2000);
    }
  }
  return res.status(500).json({ error: "Failed after retries: " + lastErr });
}
