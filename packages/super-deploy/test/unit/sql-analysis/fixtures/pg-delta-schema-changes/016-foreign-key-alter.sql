-- foreign key / alter
-- ok=true
ALTER TABLE "public"."child" DROP CONSTRAINT "child_parent_fk";

ALTER TABLE "public"."child" ADD CONSTRAINT "child_parent_fk" FOREIGN KEY (parent_id) REFERENCES public.parent(alt) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
