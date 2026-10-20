-- function (BEGIN ATOMIC) / alter
-- ok=true
CREATE OR REPLACE FUNCTION public.g(x integer)
 RETURNS integer
 LANGUAGE sql
 STABLE
BEGIN ATOMIC
 SELECT (x + ( SELECT (count(*))::integer AS count
            FROM public.t));
END;
