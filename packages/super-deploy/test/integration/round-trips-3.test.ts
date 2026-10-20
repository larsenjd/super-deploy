// Round trips for every supported object type, part 3 of 3 (split so the
// scenarios run in parallel test files, each with its own server).
import { roundTrips } from "../fixtures/round-trips.ts";
import { describeRoundTrips } from "../support/round-trip.ts";

describeRoundTrips(roundTrips.filter((_, index) => index % 3 === 2));
