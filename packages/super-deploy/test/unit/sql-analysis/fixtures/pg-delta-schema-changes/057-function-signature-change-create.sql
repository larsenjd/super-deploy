-- function signature change / create
-- ok=true
CREATE OR REPLACE FUNCTION public.h(x integer)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$ select x $function$;
