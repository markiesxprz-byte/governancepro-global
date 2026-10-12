-- Rollback for 0002. You almost never need this: the schema changes are additive, and the previous version of the
-- Worker ignores the new columns and tables, so rolling the CODE back (Cloudflare → Workers → Deployments → previous
-- version) is enough and loses nothing.
--
-- The one thing the old code cannot read is DATA CHANGE 1 (HOT/WARM/NURTURE moved to "temperature"). To restore the
-- original values on the rows that were migrated (legacy rows have source IS NULL; rows created since have 'web'):
UPDATE leads
   SET lead_status = CASE temperature WHEN 'Hot' THEN 'HOT' WHEN 'Warm' THEN 'WARM' WHEN 'Nurture' THEN 'NURTURE' END
 WHERE source IS NULL AND lead_status = 'New' AND temperature IN ('Hot', 'Warm', 'Nurture');
-- Do NOT drop the new columns or tables unless you have a reason; leaving them is harmless.
-- Re-applying the data change after this rollback is NOT a tested procedure.
