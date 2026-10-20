-- procedure / create
-- ok=true
CREATE OR REPLACE PROCEDURE public.p(IN x integer)
 LANGUAGE plpgsql
AS $procedure$ begin insert into t (id, a) values (x, x); end $procedure$;
