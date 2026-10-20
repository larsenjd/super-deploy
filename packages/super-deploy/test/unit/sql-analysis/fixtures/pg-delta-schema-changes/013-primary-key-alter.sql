-- primary key / alter
-- ok=true
ALTER TABLE "public"."t" DROP CONSTRAINT "t_pk";

ALTER TABLE "public"."t" ADD CONSTRAINT "t_pk" PRIMARY KEY (id, code);
