ALTER TABLE "rides" ADD COLUMN "original_stored_at" timestamp;--> statement-breakpoint
-- THE BACKFILL THE DIFFER CANNOT SEE, and it is exact rather than a guess.
--
-- Without it every ride imported before this migration has a NULL here, and
-- since NULL means "no original was ever stored" the export path would go on
-- preferring their uploaded file forever — which is the whole bug #172 is
-- about, left in place for exactly the rides most likely to have hit it.
--
-- `created_at` is not an approximation of when the original was written: the
-- import inserts the ride row and writes its files in ONE transaction, so for
-- an imported ride the two moments are the same. A ride built in the builder
-- has no byte columns set and correctly keeps its NULL.
UPDATE "rides"
   SET "original_stored_at" = "created_at"
 WHERE "kml_bytes" > 0 OR "gpx_bytes" > 0 OR "source_bytes" > 0;
