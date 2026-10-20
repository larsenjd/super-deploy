-- foreign key / create
-- ok=true
ALTER TABLE "public"."child" ADD CONSTRAINT "child_parent_fk" FOREIGN KEY (parent_id) REFERENCES public.parent(id);
