-- trigger / create
-- ok=true
CREATE TRIGGER t_upper BEFORE INSERT ON public.t FOR EACH ROW EXECUTE FUNCTION public.tf();
