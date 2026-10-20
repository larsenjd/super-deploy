-- view / alter
-- ok=true
DROP VIEW "public"."v";

CREATE VIEW "public"."v" AS  SELECT id,
    a,
    b,
    (a + 1) AS a1
   FROM public.t
  WHERE (id > 0);
