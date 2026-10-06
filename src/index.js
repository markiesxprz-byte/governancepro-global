export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---------------------------------------------------------
    // HEALTH CHECK
    // ---------------------------------------------------------
    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "GovernancePro Global",
        version: "3.0"
      });
    }

    // ---------------------------------------------------------
    // PUBLIC LEAD CAPTURE
    // Keeps the existing V2 assessment/quote functionality.
    // ---------------------------------------------------------
    if (url.pathname === "/api/leads" && request.method === "POST") {
      if (!env.DB) {
        return json({
          ok: false,
          error: "Database binding not configured"
        }, 503);
      }

      try {
        const body = await request.json();

        const id = crypto.randomUUID();
        const created = new Date().toISOString();

        await env.DB.prepare(`
          INSERT INTO leads (
            id,
            created_at,
            type,
            name,
            company,
            email,
            phone,
            framework,
            score,
            band,
            lead_status,
            challenge,
            region,
            currency,
            service,
            size,
            maturity,
            estimate_low,
            estimate_high,
            consent
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          id,
          created,
          body.type || "unknown",
          body.name || null,
          body.company || null,
          body.email || null,
          body.phone || null,
          body.framework || null,
          body.score ?? null,
          body.band || null,
          body.leadStatus || "New",
          body.challenge || null,
          body.region || null,
          body.currency || null,
          body.service || null,
          body.size || null,
          body.maturity || null,
          body.estimateLow ?? null,
          body.estimateHigh ?? null,
          body.consent ? 1 : 0
        ).run();

        return json({
          ok: true,
          id
        });

      } catch (e) {
        return json({
          ok: false,
          error: "Unable to save lead"
        }, 500);
      }
    }

    // ---------------------------------------------------------
    // PROTECT OLD /api/leads GET
    // Customer lead information must not be publicly accessible.
    // ---------------------------------------------------------
    if (url.pathname === "/api/leads" && request.method === "GET") {
      if (!isAdmin(request, env)) {
        return unauthorized();
      }

      return getLeads(env);
    }

    // ---------------------------------------------------------
    // ADMIN DASHBOARD
    // ---------------------------------------------------------
    if (url.pathname === "/admin") {
      if (!isAdmin(request, env)) {
        return unauthorized();
      }

      return new Response(adminDashboard(), {
        headers: {
          "content-type": "text/html;charset=UTF-8",
          "cache-control": "no-store"
        }
      });
    }

    // ---------------------------------------------------------
    // ADMIN LEADS API
    // ---------------------------------------------------------
    if (url.pathname === "/api/admin/leads" && request.method === "GET") {
      if (!isAdmin(request, env)) {
        return unauthorized();
      }

      return getLeads(env);
    }

    // ---------------------------------------------------------
    // ADMIN STATISTICS
    // ---------------------------------------------------------
    if (url.pathname === "/api/admin/stats" && request.method === "GET") {
      if (!isAdmin(request, env)) {
        return unauthorized();
      }

      if (!env.DB) {
        return json({
          ok: false,
          error: "Database binding not configured"
        }, 503);
      }

      try {
        const total = await env.DB.prepare(`
          SELECT COUNT(*) AS total
          FROM leads
        `).first();

        const scores = await env.DB.prepare(`
          SELECT AVG(score) AS average_score
          FROM leads
          WHERE score IS NOT NULL
        `).first();

        const pipeline = await env.DB.prepare(`
          SELECT
            COALESCE(SUM(estimate_low), 0) AS pipeline_low,
            COALESCE(SUM(estimate_high), 0) AS pipeline_high
          FROM leads
          WHERE estimate_low IS NOT NULL
             OR estimate_high IS NOT NULL
        `).first();

        const regions = await env.DB.prepare(`
          SELECT
            COALESCE(region, 'Unknown') AS region,
            COUNT(*) AS total
          FROM leads
          GROUP BY region
          ORDER BY total DESC
        `).all();

        const statuses = await env.DB.prepare(`
          SELECT
            COALESCE(NULLIF(lead_status, ''), 'New') AS status,
            COUNT(*) AS total
          FROM leads
          GROUP BY COALESCE(NULLIF(lead_status, ''), 'New')
          ORDER BY total DESC
        `).all();

        const frameworks = await env.DB.prepare(`
          SELECT
            COALESCE(framework, 'Unknown') AS framework,
            COUNT(*) AS total
          FROM leads
          GROUP BY framework
          ORDER BY total DESC
        `).all();

        return json({
          ok: true,
          stats: {
            total: Number(total?.total || 0),
            averageScore: Number(scores?.average_score || 0),
            pipelineLow: Number(pipeline?.pipeline_low || 0),
            pipelineHigh: Number(pipeline?.pipeline_high || 0),
            regions: regions.results || [],
            statuses: statuses.results || [],
            frameworks: frameworks.results || []
          }
        });

      } catch (e) {
        return json({
          ok: false,
          error: "Unable to load statistics"
        }, 500);
      }
    }

    // ---------------------------------------------------------
    // UPDATE LEAD STATUS
    // ---------------------------------------------------------
    if (
      url.pathname.startsWith("/api/admin/leads/") &&
      request.method === "PATCH"
    ) {
      if (!isAdmin(request, env)) {
        return unauthorized();
      }

      if (!env.DB) {
        return json({
          ok: false,
          error: "Database binding not configured"
        }, 503);
      }

      const id = url.pathname.split("/").pop();

      try {
        const body = await request.json();

        const allowedStatuses = [
          "New",
          "Warm",
          "Qualified",
          "Proposal",
          "Won",
          "Lost"
        ];

        if (!allowedStatuses.includes(body.status)) {
          return json({
            ok: false,
            error: "Invalid lead status"
          }, 400);
        }

        await env.DB.prepare(`
          UPDATE leads
          SET lead_status = ?
          WHERE id = ?
        `).bind(
          body.status,
          id
        ).run();

        return json({
          ok: true,
          id,
          status: body.status
        });

      } catch (e) {
        return json({
          ok: false,
          error: "Unable to update lead"
        }, 500);
      }
    }

    // ---------------------------------------------------------
    // PUBLIC ASSETS
    // ---------------------------------------------------------
    return env.ASSETS.fetch(request);
  }
};


// =============================================================
// ADMIN AUTHENTICATION
// =============================================================

function isAdmin(request, env) {
  const auth = request.headers.get("Authorization");

  if (!auth || !auth.startsWith("Basic ")) {
    return false;
  }

  if (!env.ADMIN_PASSWORD) {
    return false;
  }

  try {
    const decoded = atob(auth.substring(6));
    const separator = decoded.indexOf(":");

    if (separator === -1) {
      return false;
    }

    const username = decoded.substring(0, separator);
    const password = decoded.substring(separator + 1);

    return username === "admin" && password === env.ADMIN_PASSWORD;

  } catch (e) {
    return false;
  }
}


function unauthorized() {
  return new Response(
    JSON.stringify({
      ok: false,
      error: "Administrator authentication required"
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "WWW-Authenticate": 'Basic realm="GovernancePro Global Admin"'
      }
    }
  );
}


// =============================================================
// LEADS
// =============================================================

async function getLeads(env) {
  if (!env.DB) {
    return json({
      ok: false,
      error: "Database binding not configured"
    }, 503);
  }

  try {
    const result = await env.DB.prepare(`
      SELECT *
      FROM leads
      ORDER BY created_at DESC
      LIMIT 200
    `).all();

    return json({
      ok: true,
      leads: result.results || []
    });

  } catch (e) {
    return json({
      ok: false,
      error: "Unable to load leads"
    }, 500);
  }
}


// =============================================================
// JSON RESPONSE
// =============================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store"
      }
    }
  );
}


// =============================================================
// ADMIN DASHBOARD
// =============================================================

function adminDashboard() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>GovernancePro Global — Admin</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Arial, Helvetica, sans-serif;
  background: #f4f7fb;
  color: #172033;
}

header {
  background: #101828;
  color: white;
  padding: 22px 30px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

header h1 {
  margin: 0;
  font-size: 22px;
}

header span {
  font-size: 13px;
  opacity: .75;
}

.container {
  max-width: 1400px;
  margin: auto;
  padding: 30px;
}

.cards {
  display: grid;
  grid-template-columns:
    repeat(4, minmax(180px, 1fr));
  gap: 18px;
  margin-bottom: 25px;
}

.card {
  background: white;
  border-radius: 12px;
  padding: 22px;
  box-shadow: 0 2px 8px rgba(0,0,0,.06);
}

.card .label {
  color: #667085;
  font-size: 13px;
  margin-bottom: 10px;
}

.card .value {
  font-size: 28px;
  font-weight: bold;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  margin-bottom: 25px;
}

.panel {
  background: white;
  border-radius: 12px;
  padding: 22px;
  box-shadow: 0 2px 8px rgba(0,0,0,.06);
}

.panel h2 {
  margin-top: 0;
  font-size: 18px;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

th,
td {
  text-align: left;
  padding: 11px 8px;
  border-bottom: 1px solid #eaecf0;
  vertical-align: top;
}

th {
  color: #667085;
  font-weight: 600;
}

select {
  padding: 6px;
  border: 1px solid #d0d5dd;
  border-radius: 6px;
  background: white;
}

.small {
  color: #667085;
  font-size: 12px;
}

.loading {
  text-align: center;
  padding: 30px;
  color: #667085;
}

.badge {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 20px;
  background: #eef2ff;
  font-size: 12px;
}

@media(max-width:900px) {
  .cards {
    grid-template-columns: repeat(2, 1fr);
  }

  .grid {
    grid-template-columns: 1fr;
  }
}

@media(max-width:600px) {
  .container {
    padding: 15px;
  }

  .cards {
    grid-template-columns: 1fr;
  }

  table {
    font-size: 11px;
  }
}

</style>
</head>

<body>

<header>
  <div>
    <h1>GovernancePro Global</h1>
    <span>V3 Administrator Dashboard</span>
  </div>

  <span>Secure Admin Area</span>
</header>

<div class="container">

  <div class="cards">

    <div class="card">
      <div class="label">Total Leads / Assessments</div>
      <div class="value" id="total">—</div>
    </div>

    <div class="card">
      <div class="label">Average Assessment Score</div>
      <div class="value" id="averageScore">—</div>
    </div>

    <div class="card">
      <div class="label">Indicative Pipeline — Low</div>
      <div class="value" id="pipelineLow">—</div>
    </div>

    <div class="card">
      <div class="label">Indicative Pipeline — High</div>
      <div class="value" id="pipelineHigh">—</div>
    </div>

  </div>


  <div class="grid">

    <div class="panel">
      <h2>Leads by Region</h2>
      <div id="regions" class="loading">Loading...</div>
    </div>

    <div class="panel">
      <h2>Lead Status</h2>
      <div id="statuses" class="loading">Loading...</div>
    </div>

  </div>


  <div class="grid">

    <div class="panel">
      <h2>Frameworks</h2>
      <div id="frameworks" class="loading">Loading...</div>
    </div>

    <div class="panel">
      <h2>System</h2>
      <p class="small">
        GovernancePro Global V3
      </p>
      <p class="small">
        Assessment and quote submissions are stored in Cloudflare D1.
      </p>
      <p class="small">
        Administrator access is protected using Cloudflare Worker authentication.
      </p>
    </div>

  </div>


  <div class="panel">

    <h2>Recent Leads</h2>

    <div style="overflow-x:auto">

      <table>

        <thead>

          <tr>
            <th>Date</th>
            <th>Name</th>
            <th>Company</th>
            <th>Email</th>
            <th>Framework</th>
            <th>Score</th>
            <th>Region</th>
            <th>Service</th>
            <th>Investment</th>
            <th>Status</th>
          </tr>

        </thead>

        <tbody id="leads">
          <tr>
            <td colspan="10" class="loading">
              Loading...
            </td>
          </tr>
        </tbody>

      </table>

    </div>

  </div>

</div>


<script>

async function loadDashboard() {

  try {

    const statsResponse =
      await fetch("/api/admin/stats");

    if (!statsResponse.ok) {
      throw new Error("Unable to load statistics");
    }

    const statsData =
      await statsResponse.json();

    const stats =
      statsData.stats;

    document.getElementById("total")
      .textContent = stats.total;

    document.getElementById("averageScore")
      .textContent =
      stats.averageScore
        ? stats.averageScore.toFixed(1)
        : "0";

    document.getElementById("pipelineLow")
      .textContent =
      formatNumber(stats.pipelineLow);

    document.getElementById("pipelineHigh")
      .textContent =
      formatNumber(stats.pipelineHigh);


    renderList(
      "regions",
      stats.regions,
      "region"
    );

    renderList(
      "statuses",
      stats.statuses,
      "status"
    );

    renderList(
      "frameworks",
      stats.frameworks,
      "framework"
    );


    const leadsResponse =
      await fetch("/api/admin/leads");

    if (!leadsResponse.ok) {
      throw new Error("Unable to load leads");
    }

    const leadsData =
      await leadsResponse.json();

    renderLeads(leadsData.leads || []);

  } catch (error) {

    document.getElementById("leads").innerHTML =
      '<tr><td colspan="10">Unable to load dashboard data.</td></tr>';

    console.error(error);

  }

}


function formatNumber(value) {

  return Number(value || 0)
    .toLocaleString();

}


function renderList(elementId, rows, field) {

  const element =
    document.getElementById(elementId);

  if (!rows || !rows.length) {

    element.innerHTML =
      '<p class="small">No data yet.</p>';

    return;
  }


  let html =
    '<table><thead><tr><th>' +
    field.charAt(0).toUpperCase() +
    field.slice(1) +
    '</th><th>Total</th></tr></thead><tbody>';


  rows.forEach(row => {

    html +=
      '<tr>' +
      '<td><span class="badge">' +
      escapeHtml(row[field]) +
      '</span></td>' +
      '<td>' +
      row.total +
      '</td>' +
      '</tr>';

  });


  html += '</tbody></table>';

  element.innerHTML = html;

}


function renderLeads(leads) {

  const tbody =
    document.getElementById("leads");

  if (!leads.length) {

    tbody.innerHTML =
      '<tr><td colspan="10">No leads yet.</td></tr>';

    return;
  }


  tbody.innerHTML = leads.map(lead => {

    const investment =
      lead.estimate_low != null ||
      lead.estimate_high != null
        ? formatNumber(lead.estimate_low || 0) +
          " – " +
          formatNumber(lead.estimate_high || 0) +
          " " +
          escapeHtml(lead.currency || "")
        : "—";


    return '<tr>' +

      '<td>' +
      escapeHtml(
        formatDate(lead.created_at)
      ) +
      '</td>' +

      '<td>' +
      escapeHtml(lead.name || "—") +
      '</td>' +

      '<td>' +
      escapeHtml(lead.company || "—") +
      '</td>' +

      '<td>' +
      escapeHtml(lead.email || "—") +
      '</td>' +

      '<td>' +
      escapeHtml(lead.framework || "—") +
      '</td>' +

      '<td>' +
      escapeHtml(
        lead.score != null
          ? Number(lead.score).toFixed(0)
          : "—"
      ) +
      '</td>' +

      '<td>' +
      escapeHtml(lead.region || "—") +
      '</td>' +

      '<td>' +
      escapeHtml(lead.service || "—") +
      '</td>' +

      '<td>' +
      investment +
      '</td>' +

      '<td>' +

      '<select onchange="updateStatus(\\'' +
      lead.id +
      '\\', this.value)">' +

      statusOptions(
        lead.lead_status || "New"
      ) +

      '</select>' +

      '</td>' +

      '</tr>';

  }).join("");

}


function statusOptions(current) {

  const statuses = [
    "New",
    "Warm",
    "Qualified",
    "Proposal",
    "Won",
    "Lost"
  ];

  return statuses.map(status => {

    return '<option value="' +
      status +
      '"' +
      (
        status === current
          ? " selected"
          : ""
      ) +
      '>' +
      status +
      '</option>';

  }).join("");

}


async function updateStatus(id, status) {

  try {

    const response =
      await fetch(
        "/api/admin/leads/" +
        encodeURIComponent(id),
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            status
          })
        }
      );

    if (!response.ok) {
      alert("Unable to update lead status.");
    }

  } catch (error) {

    alert("Unable to update lead status.");

  }

}


function formatDate(value) {

  if (!value) {
    return "—";
  }

  return new Date(value)
    .toLocaleString();

}


function escapeHtml(value) {

  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

}


loadDashboard();

</script>

</body>
</html>`;
}
