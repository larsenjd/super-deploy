-- function (sql, binds at create) / alter
-- ok=true
CREATE OR REPLACE FUNCTION public.total_a()
 RETURNS bigint
 LANGUAGE sql
 STABLE PARALLEL SAFE
AS $function$ select coalesce(sum(a), 0) from t where id > 0 $function$;
