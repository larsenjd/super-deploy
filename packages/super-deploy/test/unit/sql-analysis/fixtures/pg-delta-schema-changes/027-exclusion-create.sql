-- exclusion / create
-- ok=true
ALTER TABLE "public"."booking" ADD CONSTRAINT "booking_no_overlap" EXCLUDE USING gist (during WITH &&);
