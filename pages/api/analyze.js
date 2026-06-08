// pages/api/analyze.js
// v5: recency-dominant scoring + power metrics, splits, elevation, fatigue

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { game, gameData } = req.body;
  const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
  if (!CEREBRAS_KEY) return res.status(500).json({ error: "CEREBRAS_API_KEY not set" });

  const awayList = gameData?.lineups?.away || [];
  const homeList = gameData?.lineups?.home || [];
  const isProjected = !!gameData?.projected;
  if (awayList.length < 3 || homeList.length < 3)
    return res.status(200).json({ candidates: [], skipped: true, reason: "Not enough roster data" });

  const validNames = [...awayList, ...homeList].map(p => p.name);

  // Rich per-player line emphasizing RECENT form + power
  const fmt = (arr) => arr.map(p => {
    const s = gameData?.playerStats?.[p.id] || {};
    const power = s.barrel_pct ? `Brl%${s.barrel_pct} HardHit%${s.hard_hit_pct||"?"} EV${s.avg_ev||"?"} LA${s.launch_angle||"?"}` : `(no statcast)`;
    return `${p.name}(${p.bats}): SEASON HR${s.hr||"?"} OPS${s.ops||"?"} ISO${s.iso||"?"} | LAST14d HR${s.recent_hr??"?"} OPS${s.recent_ops||"?"} ISO${s.recent_iso||"?"} SLG${s.recent_slg||"?"} (${s.recent_ab||0}AB) | ${s.split_label||"split"}OPS${s.split_ops||"?"} | ${power}`;
  }).join("\n") || "none";

  const awayLineup = fmt(awayList);
  const homeLineup = fmt(homeList);
  const aP = gameData?.pitcherStats?.away || {};
  const hP = gameData?.pitcherStats?.home || {};
  const weather = gameData?.weather || {};
  const elevation = gameData?.elevation || 20;
  const slot = gameData?.isNightGame ? "NIGHT" : "DAY";

  const lineupNote = isProjected
    ? `Lineups NOT posted yet — these are healthy active-roster regulars. Project likely HR threats.`
    : `CONFIRMED posted lineups.`;

  const prompt = `Elite MLB home-run model. Identify the top 4-5 HR candidates per team for TODAY.

${game.away_team} @ ${game.home_team} at ${game.venue} — ${slot} game
Elevation: ${elevation} ft ${elevation>2000?"(HIGH — significant carry, boosts HR)":elevation>800?"(moderate)":"(low)"}
Away SP ${game.away_sp.name} (${game.away_sp.throws}) season ERA ${aP.era||game.away_sp.era} HR/9 ${aP.hr9||"?"} | last3wk HR/9 ${aP.recent_hr9||"?"} ERA ${aP.recent_era||"?"}
Home SP ${game.home_sp.name} (${game.home_sp.throws}) season ERA ${hP.era||game.home_sp.era} HR/9 ${hP.hr9||"?"} | last3wk HR/9 ${hP.recent_hr9||"?"} ERA ${hP.recent_era||"?"}

${lineupNote}
Away batters (face ${game.home_sp.name}, ${game.home_sp.throws}HP):
${awayLineup}
Home batters (face ${game.away_sp.name}, ${game.away_sp.throws}HP):
${homeLineup}

Weather: ${weather.summary||"?"} (wind dir ${weather.wind_dir||"?"}°)

SCORING PRIORITY (most to least important):
1. RECENT FORM (last 14 days) — this should DOMINATE. A hitter with high recent HR/ISO/OPS and rising power is the strongest signal. Weight recent ~65%, season ~35%. A cold hitter with a great season line should score LOWER than a hot hitter with a mediocre season line.
2. POWER METRICS — high barrel%, hard-hit%, exit velocity, and optimal launch angle (10-30°) indicate HRs are coming even if they haven't dropped yet.
3. PITCHER VULNERABILITY — especially recent HR/9 trend (getting squared up lately matters more than season number).
4. PLATOON EDGE — batter handedness vs the pitcher's throwing hand.
5. DAY/NIGHT SPLIT — use the ${slot.toLowerCase()} OPS shown; some hitters are much better in one slot.
6. PARK + ELEVATION — high elevation and small parks boost HR; pitcher-friendly parks suppress.
7. WEATHER — wind blowing out + warm air boosts; wind in + cold suppresses.

Use a DECIMAL hr_score (one decimal, e.g. 72.4). Spread scores realistically; reward genuinely hot+powerful bats with 80+, punish cold bats into the 30s-40s even if their season line is good.

Return ONLY JSON: {"candidates":[{"name":"","team":"","bats":"L","lineup_spot":3,"opposing_sp":"","sp_throws":"R","pitcher_grade":"AVERAGE","batter_grade":"HOT","hr_score":72.4,"hr_prob":"14%","key_stats":[{"label":"L14 HR","value":"4"},{"label":"L14 ISO","value":".310"},{"label":"Brl%","value":"15"},{"label":"SP HR/9","value":"1.6"}],"summary":""}]}
For key_stats prefer RECENT/POWER metrics (L14 HR, L14 ISO, Brl%, recent OPS, SP recent HR/9) over season stats.
pitcher_grade: BATTING PRACTICE|AVERAGE|STUD. batter_grade: FIRE|HOT|AVERAGE|COLD. hr_score: decimal 1.0-100.0.`;

  let rawText = "";
  try {
    const cbRes = await fetch("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CEREBRAS_KEY}` },
      body: JSON.stringify({
        model: "gpt-oss-120b",
        messages: [
          { role: "system", content: "You are an MLB HR model that prioritizes recent form and power metrics over season-long stats. Respond only with valid JSON. Only use listed players." },
          { role: "user", content: prompt }
        ],
        temperature: 0.3,
        max_completion_tokens: 5000,
        response_format: { type: "json_object" }
      })
    });

    const cbData = await cbRes.json();
    if (cbData.error || cbData.message) {
      const msg = cbData.error ? (typeof cbData.error==="string"?cbData.error:JSON.stringify(cbData.error)) : cbData.message;
      return res.status(500).json({ error: "CB: " + msg });
    }
    rawText = cbData.choices?.[0]?.message?.content || "";
    if (!rawText) return res.status(500).json({ error: "EMPTY" });

    let parsed;
    try { parsed = JSON.parse(rawText); }
    catch { const o1=rawText.indexOf("{"),o2=rawText.lastIndexOf("}"); if(o1!==-1&&o2>o1){try{parsed=JSON.parse(rawText.slice(o1,o2+1));}catch{}} }
    if (!parsed) return res.status(500).json({ error: "PARSE: " + rawText.substring(0,150) });

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
    return res.status(500).json({ error: "CATCH: " + e.message });
  }
}
