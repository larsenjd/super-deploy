-- function (sql, binds at create) / create
-- ok=true
CREATE OR REPLACE FUNCTION public.total_a()
 RETURNS bigint
 LANGUAGE sql
 STABLE
AS $function$ select sum(a) from t $function$;
