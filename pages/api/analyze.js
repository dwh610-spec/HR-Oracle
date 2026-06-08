// pages/api/analyze.js
// v8: Google Gemini 2.5 Flash — 1M context (no truncation), recency-weighted

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { game, gameData } = req.body;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_API_KEY not set" });

  // Gemini's 1M context means we can use full lineups (9 per side)
  const awayList = (gameData?.lineups?.away || []).slice(0, 9);
  const homeList = (gameData?.lineups?.home || []).slice(0, 9);
  const isProjected = !!gameData?.projected;
  if (awayList.length < 3 || homeList.length < 3)
    return res.status(200).json({ candidates: [], skipped: true, reason: "Not enough roster data" });

  const validNames = [...awayList, ...homeList].map(p => p.name);

  // Rich per-player line — full recency + power data (room to breathe now)
  const fmt = (arr) => arr.map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    const power = s.barrel_pct
      ? ` | Statcast: Brl%${s.barrel_pct} HardHit%${s.hard_hit_pct||"?"} EV${s.avg_ev||"?"} LA${s.launch_angle||"?"}`
      : "";
    return `${p.lineup_spot}. ${p.name} (${p.bats}HB): SEASON HR${s.hr||0} OPS${s.ops||"?"} ISO${s.iso||"?"} | LAST 14d: HR${s.recent_hr??0} ISO${s.recent_iso||"?"} OPS${s.recent_ops||"?"} SLG${s.recent_slg||"?"} (${s.recent_ab||0}AB) | ${s.split_label||"slot"}OPS${s.split_ops||"?"}${power}`;
  }).join("\n");

  const aP = gameData?.pitcherStats?.away || {};
  const hP = gameData?.pitcherStats?.home || {};
  const weather = gameData?.weather || {};
  const elevation = gameData?.elevation || 20;
  const slot = gameData?.isNightGame ? "NIGHT" : "DAY";

  const prompt = `You are an elite MLB home-run prediction model. Identify the top 4-5 HR candidates per team for TODAY's game.

${game.away_team} @ ${game.home_team} at ${game.venue} — ${slot} game
Elevation: ${elevation} ft ${elevation>2000?"(HIGH — significant carry, boosts HR)":elevation>800?"(moderate)":"(low)"}
Away SP ${game.away_sp.name} (${game.away_sp.throws}HP): season ERA ${aP.era||game.away_sp.era}, HR/9 ${aP.hr9||"?"}, last-3wk HR/9 ${aP.recent_hr9||"?"}
Home SP ${game.home_sp.name} (${game.home_sp.throws}HP): season ERA ${hP.era||game.home_sp.era}, HR/9 ${hP.hr9||"?"}, last-3wk HR/9 ${hP.recent_hr9||"?"}

${isProjected ? "NOTE: Lineups NOT posted yet — these are healthy active-roster regulars (injured already removed). Project likely HR threats." : "These are CONFIRMED posted lineups."}

AWAY batters (face ${game.home_sp.name}, ${game.home_sp.throws}HP):
${fmt(awayList)}

HOME batters (face ${game.away_sp.name}, ${game.away_sp.throws}HP):
${fmt(homeList)}

Weather: ${weather.summary||"?"} (wind direction ${weather.wind_dir||"?"}°)

SCORING PRIORITY (most to least important):
1. RECENT FORM (last 14 days) DOMINATES — weight recent ~65%, season ~35%. A hot bat with a mediocre season should score HIGHER than a cold star with a great season line.
2. POWER METRICS — high barrel%, hard-hit%, exit velocity, optimal launch angle (10-30°) signal HRs are coming.
3. PITCHER recent HR/9 trend (getting squared up lately matters more than season number).
4. PLATOON edge — batter handedness vs pitcher throwing hand.
5. ${slot} split OPS — some hitters are much better in this time slot.
6. PARK + elevation — high elevation/small parks boost HR.
7. WEATHER — wind out + warm boosts; wind in + cold suppresses.

Use a DECIMAL hr_score (one decimal, e.g. 72.4). Reward genuinely hot+powerful bats with 80+, push cold bats into the 30s-40s even with good season lines.

You may ONLY select players listed above. Do NOT invent players from memory.

Respond with ONLY a JSON object (no markdown):
{"candidates":[{"name":"","team":"","bats":"L","lineup_spot":3,"opposing_sp":"","sp_throws":"R","pitcher_grade":"AVERAGE","batter_grade":"HOT","hr_score":72.4,"hr_prob":"14%","key_stats":[{"label":"L14 HR","value":"4"},{"label":"L14 ISO","value":".310"},{"label":"Brl%","value":"15"},{"label":"SP HR/9","value":"1.6"}],"summary":"brief insight"}]}
For key_stats, prefer recent/power metrics (L14 HR, L14 ISO, Brl%, recent OPS, SP recent HR/9).
pitcher_grade: BATTING PRACTICE|AVERAGE|STUD. batter_grade: FIRE|HOT|AVERAGE|COLD. hr_score: decimal 1.0-100.0.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const gRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 4000,
            responseMimeType: "application/json"
          }
        })
      });

      const gData = await gRes.json();

      // Rate limit / quota
      if (gRes.status === 429 || gData.error?.code === 429) {
        lastErr = "Gemini rate limit: " + (gData.error?.message || "429");
        await sleep(8000 + attempt * 4000);
        continue;
      }
      if (gData.error) {
        return res.status(500).json({ error: "Gemini: " + (gData.error.message || JSON.stringify(gData.error)) });
      }

      const rawText = gData.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!rawText) { lastErr = "empty"; await sleep(attempt*2000); continue; }

      let parsed;
      try { parsed = JSON.parse(rawText); }
      catch {
        const o1=rawText.indexOf("{"), o2=rawText.lastIndexOf("}");
        if (o1!==-1 && o2>o1) { try { parsed = JSON.parse(rawText.slice(o1,o2+1)); } catch {} }
      }
      if (!parsed) return res.status(500).json({ error: "PARSE: " + rawText.substring(0,120) });

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
