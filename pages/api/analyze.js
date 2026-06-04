// pages/api/analyze.js
// Uses Cerebras (Llama 3.3 70B) to analyze HR likelihood — fast, high free-tier limits

export const config = { maxDuration: 60 };

const CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions";

function parseArray(rawText) {
  if (!rawText) return null;
  try { const p = JSON.parse(rawText); if (Array.isArray(p)) return p; } catch {}
  // Sometimes wrapped in an object like { "candidates": [...] } or { "batters": [...] }
  try {
    const obj = JSON.parse(rawText);
    for (const k of Object.keys(obj)) {
      if (Array.isArray(obj[k])) return obj[k];
    }
  } catch {}
  const a1 = rawText.indexOf("["), a2 = rawText.lastIndexOf("]");
  if (a1 !== -1 && a2 > a1) {
    try { const p = JSON.parse(rawText.slice(a1, a2 + 1)); if (Array.isArray(p)) return p; } catch {}
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { game, gameData } = req.body;
  const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
  if (!CEREBRAS_KEY) return res.status(500).json({ error: "CEREBRAS_API_KEY not set" });

  const fmtBatter = (p) => {
    const s = gameData?.playerStats?.[p.id] || {};
    let line = `${p.lineup_spot}. ${p.name} (${p.bats}HB) — AVG ${s.avg||"?"}, HR ${s.hr||"?"}, OPS ${s.ops||"?"}, SLG ${s.slg||"?"}`;
    if (s.iso) line += `, ISO ${s.iso}`;
    if (s.venueHistory) {
      const v = s.venueHistory;
      line += ` | Career at THIS park: ${v.hr} HR in ${v.ab} AB, ${v.slg} SLG`;
    }
    return line;
  };
  const awayLineup = (gameData?.lineups?.away || []).map(fmtBatter).join("\n")
    || "Lineup not yet posted — use your knowledge of this team's regulars";
  const homeLineup = (gameData?.lineups?.home || []).map(fmtBatter).join("\n")
    || "Lineup not yet posted — use your knowledge of this team's regulars";

  // Format pitcher arsenals (pitch mix, velocity, usage)
  const fmtArsenal = (arr) => {
    if (!arr || !arr.length) return "Arsenal data not available";
    return arr.map(p => {
      const parts = [p.type];
      if (p.usage != null) parts.push(p.usage + "%");
      if (p.avgSpeed != null) parts.push(p.avgSpeed + " mph");
      return parts.join(" ");
    }).join(", ");
  };
  const awayArsenal = fmtArsenal(gameData?.arsenal?.away);
  const homeArsenal = fmtArsenal(gameData?.arsenal?.home);

  const aP = gameData?.pitcherStats?.away || {};
  const hP = gameData?.pitcherStats?.home || {};
  const weather = gameData?.weather || {};

  const prompt = `You are an elite MLB sabermetrics analyst. Analyze this game for home run likelihood.

GAME: ${game.away_team} @ ${game.home_team} at ${game.venue} — ${game.time_et} ET

AWAY STARTER: ${game.away_sp.name} (${game.away_sp.throws}HP) — ERA ${aP.era||game.away_sp.era}, WHIP ${aP.whip||"N/A"}, HR/9 ${aP.hr9||"N/A"}, HR allowed ${aP.hr_allowed||"N/A"}
  Arsenal: ${awayArsenal}
HOME STARTER: ${game.home_sp.name} (${game.home_sp.throws}HP) — ERA ${hP.era||game.home_sp.era}, WHIP ${hP.whip||"N/A"}, HR/9 ${hP.hr9||"N/A"}, HR allowed ${hP.hr_allowed||"N/A"}
  Arsenal: ${homeArsenal}

AWAY LINEUP (faces ${game.home_sp.name}):
${awayLineup}

HOME LINEUP (faces ${game.away_sp.name}):
${homeLineup}

WEATHER: ${weather.summary || "typical conditions"}, wind from ${weather.wind_dir || "?"} degrees

Identify the top 4-5 HR candidates from EACH team. Weight: HR pace, SLG/OPS, platoon advantage vs pitcher hand, park factors at ${game.venue}, weather, AND the pitcher's arsenal. For arsenal: a pitcher who throws mostly fastballs in the zone is more HR-prone; high-velocity power pitchers with heavy breaking-ball usage suppress HRs; consider whether each hitter's power profile matches up well against the specific pitch mix that pitcher throws. Away batters face home starter; home batters face away starter.

When a batter's power profile is a strong match against the pitcher's primary pitch types, note it in the summary (e.g. "crushes fastballs, and SP throws 60% four-seam").

IMPORTANT additional factors to weigh heavily:
- CAREER AT THIS PARK: If a batter has strong career numbers at this specific ballpark (high HR/AB rate, high SLG), boost their score notably — research shows park-specific history is the single strongest HR predictor. Call it out in the summary (e.g. "owns a .610 SLG with 9 career HR at this park").
- ISO (isolated power = SLG minus AVG): higher ISO means more raw power independent of batting average; weight ISO over batting average for HR likelihood.
- Treat exit-velocity/quality-of-contact and power metrics as more predictive than recent batting average, which is noisier.

Grading:
- pitcher_grade: "BATTING PRACTICE" (ERA>4.5 or HR/9>1.3), "STUD" (ERA<3.0 and HR/9<0.8), else "AVERAGE"
- batter_grade: "FIRE" (elite HR pace + great matchup), "HOT" (above avg), "COLD" (poor/slumping), else "AVERAGE"

Return ONLY a JSON object with a single key "batters" whose value is an array of batter objects. Each batter object has exactly these fields:
{
  "name": "Player Name",
  "team": "${game.away_team} or ${game.home_team}",
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
    { "label": "vs RHP", "value": ".291" }
  ],
  "summary": "One sentence explanation."
}`;

  let MODEL = "llama3.1-70b";
  const requestBody = {
    model: MODEL,
    messages: [
      { role: "system", content: "You are an elite MLB sabermetrics analyst. You always respond with valid JSON only." },
      { role: "user", content: prompt }
    ],
    temperature: 0.3,
    max_tokens: 1400,
    response_format: { type: "json_object" }
  };

  async function callCerebras(modelName) {
    requestBody.model = modelName;
    const r = await fetch(CEREBRAS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CEREBRAS_KEY}`
      },
      body: JSON.stringify(requestBody)
    });
    return r.json();
  }

  try {
    let data = await callCerebras("llama3.1-70b");

    // If the model name isn't recognized, fall back to the older confirmed ID
    if (data.error && /model/i.test(JSON.stringify(data.error))) {
      data = await callCerebras("llama3.1-8b");
    }

    // Retry on rate limit up to 2 times
    let retries = 0;
    while (data.error && /rate|429|limit/i.test(JSON.stringify(data.error)) && retries < 2) {
      retries++;
      await new Promise(r => setTimeout(r, 5000 * retries));
      data = await callCerebras(requestBody.model);
    }

    if (data.error) {
      throw new Error(JSON.stringify(data.error).substring(0, 200));
    }

    const rawText = data.choices?.[0]?.message?.content || "";
    if (!rawText) {
      // Surface the FULL error message so we can diagnose
      const msg = data.error?.message || data.message || JSON.stringify(data);
      throw new Error("CEREBRAS: " + String(msg).substring(0, 400));
    }

    const parsed = parseArray(rawText);
    if (!parsed) throw new Error("Parse fail: " + rawText.substring(0, 150));

    return res.status(200).json({ candidates: parsed });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
