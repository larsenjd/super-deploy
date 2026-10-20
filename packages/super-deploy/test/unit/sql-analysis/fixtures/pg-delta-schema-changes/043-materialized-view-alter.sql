-- materialized view / alter
-- ok=true
DROP MATERIALIZED VIEW "public"."mv";

CREATE MATERIALIZED VIEW "public"."mv" AS  SELECT a,
    b,
    count(*) AS n
   FROM public.t
  GROUP BY a, b;
