-- procedure / alter
-- ok=true
CREATE OR REPLACE PROCEDURE public.p(IN x integer)
 LANGUAGE plpgsql
AS $procedure$ begin update t set a = x where id = x; end $procedure$;
