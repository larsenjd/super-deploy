-- view (column removed/retyped -> needs drop+create) / alter
-- ok=true
DROP VIEW "public"."v";

CREATE VIEW "public"."v" AS  SELECT id,
    (b)::character varying(10) AS a
   FROM public.t;
