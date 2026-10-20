-- trigger / alter
-- ok=true
DROP TRIGGER "t_upper" ON "public"."t";

CREATE TRIGGER t_upper BEFORE INSERT OR UPDATE OF b ON public.t FOR EACH ROW WHEN ((new.b IS NOT NULL)) EXECUTE FUNCTION public.tf();
