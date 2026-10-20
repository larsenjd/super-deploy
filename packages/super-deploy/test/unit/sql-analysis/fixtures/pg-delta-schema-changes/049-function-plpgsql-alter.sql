-- function (plpgsql) / alter
-- ok=true
CREATE OR REPLACE FUNCTION public.f(x integer)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$ begin return (select count(*) from t) + x; end $function$;
