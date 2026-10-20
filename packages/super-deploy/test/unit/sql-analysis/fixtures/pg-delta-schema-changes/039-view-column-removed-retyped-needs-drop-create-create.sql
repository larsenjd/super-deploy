-- view (column removed/retyped -> needs drop+create) / create
-- ok=true
CREATE VIEW "public"."v" AS  SELECT id,
    a,
    b
   FROM public.t;
