// pages/api/analyze.js
// v10: ONE Gemini call for the ENTIRE slate (sidesteps free-tier rate limits).
// Receives an array of games (each with its gameData) and returns a single
// ranked candidate list spanning all games.

export const config = { maxDuration: 60 };

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// Compact one game into a short text block for the prompt.
function gameBlock(game, gameData) {
  const awayList = (gameData?.lineups?.away || []).slice(0, 9);
  const homeList = (gameData?.lineups?.home || []).slice(0, 9);
  const isProjected = !!gameData?.projected;
  const aP = gameData?.pitcherStats?.away || {};
  const hP = gameData?.pitcherStats?.home || {};
  const weather = gameData?.weather || {};
  const elevation = gameData?.elevation || 20;
  const slot = gameData?.isNightGame ? "N" : "D";

  const fmt = (arr) => arr.map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    const power = s.barrel_pct ? ` Brl%${s.barrel_pct}EV${s.avg_ev||"?"}` : "";
    return `${p.name}(${p.bats}) HR${s.hr||0} OPS${s.ops||"?"} ISO${s.iso||"?"} L14:HR${s.recent_hr??0}ISO${s.recent_iso||"?"}OPS${s.recent_ops||"?"}(${s.recent_ab||0}ab)${power}`;
  }).join("\n");

  return `=== ${game.away_team}@${game.home_team} @${game.venue} ${slot} elev${elevation}${isProjected?" [PROJ]":""}
ASP ${game.away_sp.name}(${game.away_sp.throws}) ERA${aP.era||game.away_sp.era} HR/9 ${aP.hr9||"?"}
HSP ${game.home_sp.name}(${game.home_sp.throws}) ERA${hP.era||game.home_sp.era} HR/9 ${hP.hr9||"?"}
Wx:${weather.summary||"?"} wind${weather.wind_dir||"?"}
AWAY(vs ${game.home_sp.throws}HP):
${fmt(awayList)}
HOME(vs ${game.away_sp.throws}HP):
${fmt(homeList)}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { games } = req.body; // [{ game, gameData }, ...]
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_API_KEY not set" });
  if (!Array.isArray(games) || !games.length)
    return res.status(400).json({ error: "no games provided" });

  // Build valid-name allow-list and per-game blocks.
  const validLower = new Set();
  const blocks = [];
  let projectedAny = false;
  for (const { game, gameData } of games) {
    const a = (gameData?.lineups?.away || []).slice(0, 9);
    const h = (gameData?.lineups?.home || []).slice(0, 9);
    if (a.length < 3 || h.length < 3) continue; // skip games with no usable roster
    [...a, ...h].forEach(p => validLower.add((p.name||"").toLowerCase()));
    if (gameData?.projected) projectedAny = true;
    blocks.push(gameBlock(game, gameData));
  }

  if (!blocks.length)
    return res.status(200).json({ candidates: [], reason: "no usable lineups in any game" });

  const prompt = `You are an elite MLB home-run prediction model. Below are ALL of today's games with lineups and stats. Identify the TOP HOME RUN CANDIDATES across the ENTIRE slate.

Return the best ~25 HR candidates total (the strongest 2-4 hitters from each game). Games tagged [PROJ] have projected (not confirmed) lineups — still analyze them.

SCORING PRIORITY: (1) RECENT 14-day form DOMINATES — weight recent ~65%, season ~35%; a hot bat beats a cold star. (2) power metrics (barrel%, EV). (3) pitcher HR/9. (4) platoon handedness (batter bats vs SP throws). (5) park/elevation (high elev boosts HR). (6) weather/wind. Reward hot+powerful 80+, push cold bats into 30s-40s. Use decimal hr_score to break ties.

${blocks.join("\n\n")}

Respond with ONLY JSON (no markdown):
{"candidates":[{"name":"","team":"","bats":"L","lineup_spot":3,"opposing_sp":"","sp_throws":"R","pitcher_grade":"AVERAGE","batter_grade":"HOT","hr_score":72.4,"hr_prob":"14%","key_stats":[{"label":"L14 HR","value":"4"},{"label":"L14 ISO","value":".310"},{"label":"Brl%","value":"15"},{"label":"SP HR/9","value":"1.6"}],"summary":"brief"}]}
Only use players listed above. team = the 2-3 letter abbreviation. pitcher_grade: BATTING PRACTICE|AVERAGE|STUD. batter_grade: FIRE|HOT|AVERAGE|COLD.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

  let lastErr = "";
  // Up to 3 attempts: rate limits clear quickly, and this is the ONLY call now.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const gRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 8000, responseMimeType: "application/json" }
        })
      });

      const gData = await gRes.json();

      if (gRes.status === 429 || gRes.status === 503 || gData.error?.code === 429 || gData.error?.code === 503) {
        lastErr = "Gemini busy: " + (gData.error?.message || gRes.status);
        if (attempt < 3) { await sleep(4000); continue; }
        return res.status(200).json({ candidates: [], reason: "AI busy after retries — wait a minute and refresh" });
      }
      if (gData.error) {
        return res.status(200).json({ candidates: [], reason: "Gemini: " + (gData.error.message||"error").substring(0,120) });
      }

      const rawText = gData.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!rawText) { lastErr="empty"; if(attempt<3){await sleep(2000);continue;} return res.status(200).json({candidates:[],reason:"empty AI response"}); }

      let parsed;
      try { parsed = JSON.parse(rawText); }
      catch { const o1=rawText.indexOf("{"),o2=rawText.lastIndexOf("}"); if(o1!==-1&&o2>o1){try{parsed=JSON.parse(rawText.slice(o1,o2+1));}catch{}} }
      // Parse failure now triggers a retry (fresh generation), not just a skip.
      if (!parsed) { lastErr="unparseable"; if(attempt<3){await sleep(2000);continue;} return res.status(200).json({ candidates: [], reason: "unparseable AI response after retries" }); }

      let candidates = [];
      if (Array.isArray(parsed)) candidates = parsed;
      else if (Array.isArray(parsed.candidates)) candidates = parsed.candidates;
      else { const arr = Object.values(parsed).find(v=>Array.isArray(v)); if(arr) candidates=arr; }

      candidates = candidates
        .filter(c => c && c.name && validLower.has((c.name||"").toLowerCase()))
        .map(c => ({ ...c, hr_score: Math.round((parseFloat(c.hr_score)||0)*10)/10, projected: projectedAny }))
        .sort((a,b) => b.hr_score - a.hr_score);

      return res.status(200).json({ candidates });
    } catch (e) {
      lastErr = e.message;
      if (attempt < 3) { await sleep(2000); continue; }
    }
  }
  return res.status(200).json({ candidates: [], reason: "failed: " + lastErr.substring(0,120) });
}
