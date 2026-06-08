// pages/api/analyzetest.js
// Visit /api/analyzetest in browser — runs ONE real game through the full
// pipeline and shows the RAW AI response + where parsing fails.
// This is read-only diagnosis; it does not change the main app.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
  const today = new Date().toISOString().split("T")[0];
  const log = {};

  try {
    // 1. Get schedule, pick first game with a posted lineup
    const schedR = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher,team,venue`);
    const sched = await schedR.json();
    const games = [];
    for (const d of sched.dates || []) for (const g of d.games || []) games.push(g);
    log.gamesFound = games.length;

    if (!games.length) return res.status(200).json({ ...log, stop: "no games today" });

    // find one with a boxscore lineup
    let chosen = null, lineupAway = [], lineupHome = [];
    for (const g of games.slice(0, 6)) {
      try {
        const bR = await fetch(`https://statsapi.mlb.com/api/v1/game/${g.gamePk}/boxscore`);
        const b = await bR.json();
        const ao = b.teams?.away?.battingOrder || [];
        const ho = b.teams?.home?.battingOrder || [];
        if (ao.length >= 8 && ho.length >= 8) {
          chosen = g;
          const ap = b.teams.away.players, hp = b.teams.home.players;
          lineupAway = ao.slice(0,9).map((id,i)=>({ name: ap[`ID${id}`]?.person?.fullName, bats: ap[`ID${id}`]?.person?.batSide?.code||"R", spot:i+1 }));
          lineupHome = ho.slice(0,9).map((id,i)=>({ name: hp[`ID${id}`]?.person?.fullName, bats: hp[`ID${id}`]?.person?.batSide?.code||"R", spot:i+1 }));
          break;
        }
      } catch {}
    }

    if (!chosen) {
      // fall back to first game, note that no posted lineups exist
      log.note = "No posted lineups found in first 6 games (early in day). Using a generic prompt to test AI response format only.";
      lineupAway = [{name:"Test Player A",bats:"R",spot:1},{name:"Test Player B",bats:"L",spot:2},{name:"Test Player C",bats:"R",spot:3}];
      lineupHome = [{name:"Test Player D",bats:"L",spot:1},{name:"Test Player E",bats:"R",spot:2},{name:"Test Player F",bats:"L",spot:3}];
      chosen = games[0];
    }

    const away = chosen.teams?.away?.team?.abbreviation || "AWY";
    const home = chosen.teams?.home?.team?.abbreviation || "HOM";
    log.testGame = `${away} @ ${home}`;
    log.lineupCounts = { away: lineupAway.length, home: lineupHome.length };

    // 2. Build a representative prompt (same shape as analyze.js)
    const prompt = `You are an MLB HR model. Pick top 4 HR candidates per team.
${away} @ ${home}
AWAY: ${lineupAway.map(p=>`${p.spot}.${p.name}(${p.bats})`).join("; ")}
HOME: ${lineupHome.map(p=>`${p.spot}.${p.name}(${p.bats})`).join("; ")}

Respond ONLY with JSON:
{"candidates":[{"name":"","team":"","bats":"L","lineup_spot":3,"opposing_sp":"","sp_throws":"R","pitcher_grade":"AVERAGE","batter_grade":"HOT","hr_score":72.4,"hr_prob":"14%","key_stats":[{"label":"HR","value":"4"}],"summary":"x"}]}`;

    // 3. Call whichever provider is configured (prefer Gemini)
    let raw = "", provider = "", httpStatus = 0, apiError = null, finishReason = "";

    if (GEMINI_KEY) {
      provider = "gemini-2.5-flash";
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{ temperature:0.3, maxOutputTokens:4000, responseMimeType:"application/json" } })
      });
      httpStatus = r.status;
      const d = await r.json();
      apiError = d.error || null;
      finishReason = d.candidates?.[0]?.finishReason || "";
      raw = d.candidates?.[0]?.content?.parts?.[0]?.text || "";
      log.fullGeminiShape = JSON.stringify(d).substring(0, 400);
    } else if (CEREBRAS_KEY) {
      provider = "cerebras gpt-oss-120b";
      const r = await fetch("https://api.cerebras.ai/v1/chat/completions", {
        method:"POST", headers:{"Content-Type":"application/json","Authorization":`Bearer ${CEREBRAS_KEY}`},
        body: JSON.stringify({ model:"gpt-oss-120b", messages:[{role:"user",content:prompt}], temperature:0.3, max_completion_tokens:2000, response_format:{type:"json_object"} })
      });
      httpStatus = r.status;
      const d = await r.json();
      apiError = d.error || d.message || null;
      finishReason = d.choices?.[0]?.finish_reason || "";
      raw = d.choices?.[0]?.message?.content || "";
    }

    log.provider = provider;
    log.httpStatus = httpStatus;
    log.apiError = apiError;
    log.finishReason = finishReason;
    log.rawLength = raw.length;
    log.rawResponse = raw.substring(0, 1500);  // show the actual output

    // 4. Try to parse it
    let parseResult = "not attempted";
    if (raw) {
      try {
        JSON.parse(raw);
        parseResult = "✅ PARSED CLEANLY";
      } catch (e) {
        parseResult = "❌ PARSE FAILED: " + e.message;
        // show last 100 chars so we can see if it's truncated
        log.rawTail = raw.substring(Math.max(0, raw.length - 150));
      }
    }
    log.parseResult = parseResult;

    return res.status(200).json(log);
  } catch (e) {
    return res.status(500).json({ ...log, fatalError: e.message });
  }
}
