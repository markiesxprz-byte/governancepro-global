export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "GovernancePro Global", version: "2.0" });
    }
    if (url.pathname === "/api/leads" && request.method === "POST") {
      if (!env.DB) return json({ ok:false, error:"Database binding not configured" }, 503);
      try {
        const body = await request.json();
        const id = crypto.randomUUID();
        const created = new Date().toISOString();
        await env.DB.prepare(`
          INSERT INTO leads (id, created_at, type, name, company, email, phone, framework,
            score, band, lead_status, challenge, region, currency, service, size, maturity,
            estimate_low, estimate_high, consent)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          id, created, body.type || "unknown", body.name || null, body.company || null,
          body.email || null, body.phone || null, body.framework || null,
          body.score ?? null, body.band || null, body.leadStatus || null,
          body.challenge || null, body.region || null, body.currency || null,
          body.service || null, body.size || null, body.maturity || null,
          body.estimateLow ?? null, body.estimateHigh ?? null, body.consent ? 1 : 0
        ).run();
        return json({ ok:true, id });
      } catch (e) {
        return json({ ok:false, error:"Unable to save lead" }, 500);
      }
    }
    if (url.pathname === "/api/leads" && request.method === "GET") {
      if (!env.DB) return json({ ok:false, error:"Database binding not configured" }, 503);
      const result = await env.DB.prepare(
        "SELECT * FROM leads ORDER BY created_at DESC LIMIT 200"
      ).all();
      return json({ ok:true, leads: result.results });
    }
    return env.ASSETS.fetch(request);
  }
};
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json","cache-control":"no-store"}})}
