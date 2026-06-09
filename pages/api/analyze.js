// pages/api/analyze.js
// v9: Gemini 2.5 Flash. Fixes the timeout-on-retry bug.
// - maxDuration raised to 30s
// - retry waits kept SHORT so total stays under the limit

export const config = { maxDuration: 30 };

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { game, gameData } = req.body;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_API_KEY not set" });

  const awayList = (gameData?.lineups?.away || []).slice(0, 9);
  const homeList = (gameData?.lineups?.home || []).slice(0, 9);
  const isProjected = !!gameData?.projected;
  if (awayList.length < 3 || homeList.length < 3)
    return res.status(200).json({ candidates: [], skipped: true, reason: "Not enough roster data" });

  const validNames = [...awayList, ...homeList].map(p => p.name);

  const fmt = (arr) => arr.map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    const power = s.barrel_pct ? ` | Statcast: Brl%${s.barrel_pct} EV${s.avg_ev||"?"}` : "";
    return `${p.lineup_spot}. ${p.name} (${p.bats}HB): SEASON HR${s.hr||0} OPS${s.ops||"?"} ISO${s.iso||"?"} | L14d: HR${s.recent_hr??0} ISO${s.recent_iso||"?"} OPS${s.recent_ops||"?"} (${s.recent_ab||0}AB) | ${s.split_label||"slot"}OPS${s.split_ops||"?"}${power}`;
  }).join("\n");

  const aP = gameData?.pitcherStats?.away || {};
  const hP = gameData?.pitcherStats?.home || {};
  const weather = gameData?.weather || {};
  const elevation = gameData?.elevation || 20;
  const slot = gameData?.isNightGame ? "NIGHT" : "DAY";

  const prompt = `You are an elite MLB home-run prediction model. Identify the top 4-5 HR candidates per team for TODAY's game.

${game.away_team} @ ${game.home_team} at ${game.venue} — ${slot} game
Elevation: ${elevation} ft ${elevation>2000?"(HIGH — boosts HR)":elevation>800?"(moderate)":"(low)"}
Away SP ${game.away_sp.name} (${game.away_sp.throws}HP): ERA ${aP.era||game.away_sp.era}, HR/9 ${aP.hr9||"?"}, last-3wk HR/9 ${aP.recent_hr9||"?"}
Home SP ${game.home_sp.name} (${game.home_sp.throws}HP): ERA ${hP.era||game.home_sp.era}, HR/9 ${hP.hr9||"?"}, last-3wk HR/9 ${hP.recent_hr9||"?"}

${isProjected ? "NOTE: Lineups NOT posted — these are healthy active-roster regulars. Project likely HR threats." : "CONFIRMED posted lineups."}

AWAY (face ${game.home_sp.name}, ${game.home_sp.throws}HP):
${fmt(awayList)}

HOME (face ${game.away_sp.name}, ${game.away_sp.throws}HP):
${fmt(homeList)}

Weather: ${weather.summary||"?"} (wind dir ${weather.wind_dir||"?"}°)

SCORING PRIORITY: (1) RECENT 14-day form DOMINATES — weight recent ~65%, season ~35%; a hot bat beats a cold star. (2) power metrics (barrel%, EV — HRs coming). (3) pitcher recent HR/9. (4) platoon handedness. (5) ${slot} split OPS. (6) park/elevation. (7) weather. Reward hot+powerful 80+, push cold into 30s-40s. Decimal hr_score.

Only use listed players. Respond with ONLY JSON (no markdown):
{"candidates":[{"name":"","team":"","bats":"L","lineup_spot":3,"opposing_sp":"","sp_throws":"R","pitcher_grade":"AVERAGE","batter_grade":"HOT","hr_score":72.4,"hr_prob":"14%","key_stats":[{"label":"L14 HR","value":"4"},{"label":"L14 ISO","value":".310"},{"label":"Brl%","value":"15"},{"label":"SP HR/9","value":"1.6"}],"summary":"brief"}]}
key_stats: prefer recent/power metrics. pitcher_grade: BATTING PRACTICE|AVERAGE|STUD. batter_grade: FIRE|HOT|AVERAGE|COLD.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

  // At most 2 attempts, with a SHORT wait, so we never approach the timeout.
  let lastErr = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const gRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 3000, responseMimeType: "application/json" }
        })
      });

      const gData = await gRes.json();

      // Busy/quota: short wait then ONE retry (keeps us well under 30s)
      if (gRes.status === 429 || gRes.status === 503 || gData.error?.code === 429 || gData.error?.code === 503) {
        lastErr = "Gemini busy: " + (gData.error?.message || gRes.status);
        if (attempt < 2) { await sleep(1500); continue; }
        return res.status(200).json({ candidates: [], skipped: true, reason: "AI busy — try again" });
      }
      if (gData.error) {
        return res.status(200).json({ candidates: [], skipped: true, reason: "Gemini: " + (gData.error.message||"error").substring(0,80) });
      }

      const rawText = gData.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!rawText) { lastErr="empty"; if(attempt<2){await sleep(1000);continue;} return res.status(200).json({candidates:[],skipped:true,reason:"empty AI response"}); }

      let parsed;
      try { parsed = JSON.parse(rawText); }
      catch { const o1=rawText.indexOf("{"),o2=rawText.lastIndexOf("}"); if(o1!==-1&&o2>o1){try{parsed=JSON.parse(rawText.slice(o1,o2+1));}catch{}} }
      if (!parsed) return res.status(200).json({ candidates: [], skipped: true, reason: "unparseable AI response" });

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
      if (attempt < 2) { await sleep(1000); continue; }
    }
  }
  // Never throw a 500 — return a clean skip so one bad game doesn't break the run
  return res.status(200).json({ candidates: [], skipped: true, reason: "failed: " + lastErr.substring(0,80) });
}
