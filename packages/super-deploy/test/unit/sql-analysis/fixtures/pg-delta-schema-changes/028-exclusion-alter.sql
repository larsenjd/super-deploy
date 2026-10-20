-- exclusion / alter
-- ok=true
ALTER TABLE "public"."booking" DROP CONSTRAINT "booking_no_overlap";

ALTER TABLE "public"."booking" ADD CONSTRAINT "booking_no_overlap" EXCLUDE USING gist (during WITH &&) WHERE ((room IS NOT NULL));
