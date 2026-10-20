-- function (BEGIN ATOMIC) / create
-- ok=true
CREATE OR REPLACE FUNCTION public.g(x integer)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
BEGIN ATOMIC
 SELECT (x + 1);
END;
