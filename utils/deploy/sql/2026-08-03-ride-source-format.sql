-- Record what an imported ride actually arrived as, and keep the original file
-- for the formats that had nowhere to put one.
--
-- Before this, a GeoJSON or CSV import stored no file at all: the rows were
-- taken to be a complete record of the upload. They are not. A multi-day
-- GeoJSON collapses to one route on import, so the day structure existed in the
-- uploaded file and then existed nowhere — not deferred, destroyed. Keeping the
-- original means a later importer can recover it.
--
-- size_bytes has to name every byte column. used_bytes is incremented by the
-- app on import and decremented by this generated column on delete; a column
-- missing from the expression leaks quota on every delete, quietly and forever.
-- Postgres 17 can redefine a generated expression in place, so this needs no
-- drop-and-re-add.
--
-- Additive: no DROP, no TRUNCATE, no type changes. Safe to re-run.
--
--   docker exec -i tankbag-db psql -U tankbag -d tankbag -v ON_ERROR_STOP=1 \
--     --single-transaction -f - < this-file.sql

BEGIN;

ALTER TABLE rides ADD COLUMN IF NOT EXISTS source_format varchar(10);
ALTER TABLE rides ADD COLUMN IF NOT EXISTS source_bytes integer NOT NULL DEFAULT 0;

-- Backfill what is knowable. Rides predating the column have a stored KML or
-- GPX and nothing else, so their arrival format is whichever file they kept. A
-- KMZ import is indistinguishable from a KML one at this remove — both stored a
-- KML — so it is recorded as 'kml', which is what is on disk.
UPDATE rides
   SET source_format = CASE
         WHEN source <> 'imported' THEN NULL
         WHEN kml_bytes > 0 THEN 'kml'
         WHEN gpx_bytes > 0 THEN 'gpx'
         ELSE NULL
       END
 WHERE source_format IS NULL;

ALTER TABLE rides ALTER COLUMN size_bytes SET EXPRESSION AS (kml_bytes + gpx_bytes + source_bytes);

COMMIT;
