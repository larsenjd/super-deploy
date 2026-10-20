-- function (plpgsql) / create
-- ok=true
CREATE OR REPLACE FUNCTION public.f(x integer)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$ begin return x + 1; end $function$;
