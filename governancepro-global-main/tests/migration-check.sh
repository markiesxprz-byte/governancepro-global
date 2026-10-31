#!/bin/bash
# Proves the upgrade preserves existing data. Builds a LOCAL database in the old production shape (schema.sql plus
# legacy rows), starts the new Worker on it, and checks every row survived. Needs wrangler (npm install) and .dev.vars.
# Usage: bash tests/migration-check.sh        (uses port 8841 and a throwaway database under /tmp)
export CI=1 WRANGLER_SEND_METRICS=false
cd "$(dirname "$0")/.."
PERSIST=/tmp/gp_migration_check; PORT=${PORT:-8841}; PASS="${ADMIN_PASSWORD:-local-test-admin-pass}"
AUTH=$(printf "admin:%s" "$PASS" | base64)
for p in $PORT $((PORT+1)); do
  if [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' localhost:$p/api/health)" != "000" ]; then echo "Port $p is already in use (an old test server?). Stop it, or run:  PORT=<free port> bash tests/migration-check.sh"; exit 2; fi
done
rm -rf $PERSIST
cat > /tmp/gp_legacy.sql <<'SQL'
INSERT INTO leads (id,created_at,type,name,company,email,phone,framework,score,band,lead_status,challenge,region,currency,service,size,maturity,estimate_low,estimate_high,consent) VALUES
 ('legacy-1','2026-10-06T08:50:00.000Z','assessment','Ayesha Khan','Khan Logistics','ayesha@khan.co.za','0821234567','ISO 27001',41,'Defined','HOT','Audit findings','ZA','ZAR',NULL,NULL,NULL,NULL,NULL,1),
 ('legacy-2','2026-10-06T09:10:00.000Z','assessment','Tom Baker','Baker Ltd','tom@baker.co.uk',NULL,'ISO 9001',63,'Managed','WARM',NULL,'GB','GBP',NULL,NULL,NULL,NULL,NULL,1),
 ('legacy-3','2026-10-06T09:30:00.000Z','assessment','Nina Petrova','Petrova GmbH','nina@petrova.eu',NULL,'COBIT',74,'Managed','NURTURE',NULL,'EU','EUR',NULL,NULL,NULL,NULL,NULL,1),
 ('legacy-4','2026-10-06T10:00:00.000Z','quote',NULL,NULL,NULL,NULL,'ISO 27001',NULL,NULL,NULL,NULL,'US','USD','Readiness / Gap Analysis','51–100','Developing',23288,33767,0),
 ('legacy-5','2026-10-06T10:05:00.000Z','assessment','Sam Ndlovu','Ndlovu Co','sam@ndlovu.co.za',NULL,'ITSM',50,'Defined','Warm',NULL,'ZA','ZAR',NULL,NULL,NULL,NULL,NULL,1),
 ('legacy-6','2026-10-06T10:06:00.000Z','assessment','No Status','NS Ltd','ns@ns.co.za',NULL,'GRC',55,'Defined',NULL,NULL,'ZA','ZAR',NULL,NULL,NULL,NULL,NULL,1);
SQL
echo "1. build a database in the OLD production shape"
npx wrangler d1 execute DB --local --persist-to $PERSIST --file schema.sql >/dev/null 2>&1
npx wrangler d1 execute DB --local --persist-to $PERSIST --file /tmp/gp_legacy.sql >/dev/null 2>&1
q() { npx wrangler d1 execute DB --local --persist-to $PERSIST --json --command "$1" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(d)[0].results))}catch(e){console.log("ERR")}})'; }
echo "   legacy rows: $(q 'SELECT COUNT(*) AS n FROM leads')   has schema_meta table before upgrade: $(q "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='schema_meta'")"
echo "2. start the NEW Worker on it and trigger the upgrade"
timeout 100 npx wrangler dev --local --port $PORT --persist-to $PERSIST > /tmp/gp_migration.log 2>&1 &
SERVER=$!
for i in $(seq 1 25); do sleep 2; [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' localhost:$PORT/api/health)" != "000" ] && break; done
curl -s -o /dev/null -H "Authorization: Basic $AUTH" localhost:$PORT/api/admin/stats
curl -s -H "Authorization: Basic $AUTH" "localhost:$PORT/api/admin/leads" > /tmp/gp_after.json
node -e '
const d=JSON.parse(require("fs").readFileSync("/tmp/gp_after.json","utf8")); const by=Object.fromEntries(d.leads.map(l=>[l.id,l]));
let bad=0; const t=(n,ok)=>{console.log((ok?"PASS ":"FAIL ")+n); if(!ok) bad++};
t("every legacy row survived (6 of 6, same ids)", d.total===6 && ["legacy-1","legacy-2","legacy-3","legacy-4","legacy-5","legacy-6"].every(i=>by[i]));
t("names, companies, emails, scores and bands are untouched", by["legacy-1"].name==="Ayesha Khan" && by["legacy-1"].email==="ayesha@khan.co.za" && by["legacy-1"].score===41 && by["legacy-2"].band==="Managed" && by["legacy-3"].company==="Petrova GmbH");
t("HOT/WARM/NURTURE moved to temperature (Hot/Warm/Nurture), nothing lost", by["legacy-1"].temperature==="Hot" && by["legacy-2"].temperature==="Warm" && by["legacy-3"].temperature==="Nurture");
t("...and those leads now carry the normal starting status (New)", ["legacy-1","legacy-2","legacy-3"].every(i=>by[i].lead_status==="New"));
t("a lead already using an admin status (Warm) keeps it", by["legacy-5"].lead_status==="Warm" && by["legacy-5"].temperature===null);
t("a lead with no status is left alone", by["legacy-6"].lead_status===null);
t("old estimates are now labelled ZAR, and the display currency is kept as it was", by["legacy-4"].estimate_low===23288 && by["legacy-4"].estimate_currency==="ZAR" && by["legacy-4"].currency==="USD");
t("rows without an estimate got no invented currency", by["legacy-1"].estimate_currency===null);
t("old consent values are preserved (1 for contacts, 0 for the anonymous quote)", by["legacy-1"].consent===1 && by["legacy-4"].consent===0);
t("new columns exist and are empty for old rows", "message" in by["legacy-1"] && by["legacy-1"].consent_version===null && by["legacy-1"].answers===null);
process.exit(bad?1:0)'; RESULT1=$?
echo "   schema version after upgrade: $(q "SELECT value FROM schema_meta WHERE key='version'")  tables: $(q "SELECT group_concat(name) AS t FROM sqlite_master WHERE type='table' AND name IN ('leads','rate_limits','admin_audit','schema_meta')")"
echo "3. new submissions work on the upgraded database, and a SECOND start changes nothing"
curl -s -X POST localhost:$PORT/api/leads -H 'content-type: application/json' -H 'cf-connecting-ip: 198.51.100.9' -d '{"type":"enquiry","name":"New Person","email":"new@person.co.za","product_interest":"consulting","consent":true,"consent_version":"2026-10-12"}' | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log((d.ok?"PASS ":"FAIL ")+"a new enquiry saves on the upgraded database")'
sleep 1
echo "   rows now: $(q 'SELECT COUNT(*) AS n FROM leads')  (6 legacy + 1 new = 7)   HOT rows left: $(q "SELECT COUNT(*) AS n FROM leads WHERE lead_status IN ('HOT','WARM','NURTURE')")"
echo "4. stop the Worker, start it AGAIN on the same database (the upgrade must be safe to repeat)"
kill $SERVER 2>/dev/null; sleep 4
PORT2=$((PORT+1))
timeout 60 npx wrangler dev --local --port $PORT2 --persist-to $PERSIST > /tmp/gp_migration2.log 2>&1 &
SERVER2=$!
for i in $(seq 1 25); do sleep 2; [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' localhost:$PORT2/api/health)" != "000" ] && break; done
curl -s -H "Authorization: Basic $AUTH" "localhost:$PORT2/api/admin/leads" > /tmp/gp_after2.json
node -e '
const d=JSON.parse(require("fs").readFileSync("/tmp/gp_after2.json","utf8")); const by=Object.fromEntries(d.leads.map(l=>[l.id,l]));
let bad=0; const t=(n,ok)=>{console.log((ok?"PASS ":"FAIL ")+n); if(!ok) bad++};
t("after the second start: still 7 rows, nothing duplicated or lost", d.total===7);
t("legacy data is exactly as it was after the first upgrade", by["legacy-1"].temperature==="Hot" && by["legacy-1"].lead_status==="New" && by["legacy-4"].estimate_currency==="ZAR" && by["legacy-5"].lead_status==="Warm");
process.exit(bad?1:0)'; RESULT2=$?
echo "   schema version still: $(q "SELECT value FROM schema_meta WHERE key='version'")   audit rows: $(q 'SELECT COUNT(*) AS n FROM admin_audit')"
kill $SERVER2 2>/dev/null
exit $((RESULT1 + RESULT2))
