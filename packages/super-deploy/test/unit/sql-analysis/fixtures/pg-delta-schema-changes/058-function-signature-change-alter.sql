-- function signature change / alter
-- ok=true
DROP FUNCTION "public"."h"(integer);

CREATE OR REPLACE FUNCTION public.h(x integer, y integer DEFAULT 0)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
AS $function$ select (x + y)::bigint $function$;
