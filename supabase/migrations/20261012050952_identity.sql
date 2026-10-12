


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "private";


ALTER SCHEMA "private" OWNER TO "postgres";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."consume_command_rate"("actor_id" "uuid", "is_creation" boolean) RETURNS integer
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare now_at timestamptz; oldest timestamptz; attempts integer; maximum integer;
begin
  if actor_id is null or is_creation is null then raise exception 'invalid actor'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,1));
  now_at := clock_timestamp();
  delete from private.command_attempts a where a.actor_id=consume_command_rate.actor_id and a.attempted_at <= now_at-interval '1 minute';
  select count(*), min(attempted_at) into attempts, oldest from private.command_attempts a
    where a.actor_id=consume_command_rate.actor_id and a.is_creation=consume_command_rate.is_creation;
  maximum := case when is_creation then 5 else 60 end;
  if attempts >= maximum then return greatest(1,ceil(extract(epoch from (oldest+interval '1 minute'-now_at))*1000)::integer); end if;
  insert into private.command_attempts(actor_id,is_creation,attempted_at) values(actor_id,is_creation,now_at);
  return null;
end $$;


ALTER FUNCTION "public"."consume_command_rate"("actor_id" "uuid", "is_creation" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_gladiator"("actor_id" "uuid", "operation_id" "uuid", "input" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $_$
declare command jsonb := input->'command'; allocation jsonb; total numeric; value jsonb; stat jsonb;
  existing public.operation_receipts%rowtype; result jsonb; gid uuid := gen_random_uuid(); receipt uuid := gen_random_uuid();
  weapon_id uuid := gen_random_uuid(); body_id uuid := gen_random_uuid(); now_ms bigint; slot bigint; item jsonb; item_id uuid; n integer := 0;
begin
  if actor_id is null then return jsonb_build_object('ok',false,'code','unauthenticated'); end if;
  if operation_id is null or jsonb_typeof(input) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if (select count(*) from jsonb_object_keys(input)) <> 3 or not (input ?& array['command','starterItems','staminaMaximum'])
    or jsonb_typeof(command) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  -- One account lock covers all its operation IDs. Name's unique index also serializes different accounts.
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text,0));
  select * into existing from public.operation_receipts r where r.owner_id=actor_id and r.operation_id=create_gladiator.operation_id;
  if found then
    if existing.request <> command then return jsonb_build_object('ok',false,'code','conflict'); end if;
    return existing.result;
  end if;
  if (select count(*) from jsonb_object_keys(command)) <> 5
    or not (command ?& array['kind','operationId','name','classId','allocation'])
    or command->>'kind' is distinct from 'create-character' or command->>'operationId' is distinct from operation_id::text
    or jsonb_typeof(command->'name') is distinct from 'string' or command->>'name' <> btrim(command->>'name')
    or not (command->>'name' ~ '^[A-Za-z0-9 _-]{3,20}$')
    or jsonb_typeof(command->'classId') is distinct from 'string' or command->>'classId' not in ('berserker','guardian','duelist') then
    return jsonb_build_object('ok',false,'code','invalid');
  end if;
  allocation := command->'allocation';
  if jsonb_typeof(allocation) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if (select count(*) from jsonb_object_keys(allocation)) <> 5
    or not (allocation ?& array['strength','agility','vitality','endurance','precision']) then return jsonb_build_object('ok',false,'code','invalid'); end if;
  total := 0;
  for value in select v from jsonb_each(allocation) e(k,v) loop
    if jsonb_typeof(value) <> 'number' or value::text::numeric < 0 or value::text::numeric > 10 or trunc(value::text::numeric) <> value::text::numeric then
      return jsonb_build_object('ok',false,'code','invalid');
    end if;
    total := total + value::text::numeric;
  end loop;
  if total <> 10 or jsonb_typeof(input->'staminaMaximum') is distinct from 'number'
    or jsonb_typeof(input->'starterItems') is distinct from 'array' then return jsonb_build_object('ok',false,'code','invalid'); end if;
  if (input->>'staminaMaximum')::numeric not between 90 and 122
    or trunc((input->>'staminaMaximum')::numeric) <> (input->>'staminaMaximum')::numeric
    or jsonb_array_length(input->'starterItems') <> 2 then
    return jsonb_build_object('ok',false,'code','invalid');
  end if;
  -- Catalog rolls come only from the backend's canonical v1 domain catalog, never from the player's command.
  for item in select * from jsonb_array_elements(input->'starterItems') loop
    if jsonb_typeof(item) is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
    if (select count(*) from jsonb_object_keys(item)) <> 6 or not (item ?& array['catalogId','catalogVersion','tier','rarity','stats','binding'])
      or item->>'catalogId' is distinct from (case when n=0 then 'sword:1:common' else 'light-armor:1:common' end)
      or item->>'catalogVersion' is distinct from 'v1' or item->'tier' is distinct from '1'::jsonb
      or item->>'rarity' is distinct from 'common' or item->>'binding' is distinct from 'tradable'
      or jsonb_typeof(item->'stats') is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
    stat := item->'stats';
    if (select count(*) from jsonb_object_keys(stat)) <> 5 or not (stat ?& array['damage','armor','weight','intervalMs','attributes'])
      or jsonb_typeof(stat->'attributes') is distinct from 'object' then return jsonb_build_object('ok',false,'code','invalid'); end if;
    if (select count(*) from jsonb_object_keys(stat->'attributes')) <> 5
      or not ((stat->'attributes') ?& array['strength','agility','vitality','endurance','precision']) then return jsonb_build_object('ok',false,'code','invalid'); end if;
    for value in select v from jsonb_each(stat-'attributes') e(k,v) union all select v from jsonb_each(stat->'attributes') e(k,v) loop
      if jsonb_typeof(value) is distinct from 'number' then return jsonb_build_object('ok',false,'code','invalid'); end if;
      if value::text::numeric not between 0 and 1000000000 or trunc(value::text::numeric*100) <> value::text::numeric*100 then
        return jsonb_build_object('ok',false,'code','invalid'); end if;
    end loop;
    if trunc((stat->>'intervalMs')::numeric) <> (stat->>'intervalMs')::numeric then return jsonb_build_object('ok',false,'code','invalid'); end if;
    n := n+1;
  end loop;
  now_ms := floor(extract(epoch from clock_timestamp())*1000)::bigint;
  slot := now_ms / 4800000;
  begin
    insert into public.gladiators(id,owner_id,name,stamina_current,stamina_maximum,processed_slot_index,created_at_ms,orientation_end_ms)
      values(gid,actor_id,command->>'name',(input->>'staminaMaximum')::bigint,(input->>'staminaMaximum')::bigint,slot,now_ms,(slot+1)*4800000);
    insert into public.builds(gladiator_id,current_build) values(gid,jsonb_build_object('version',1,'classId',command->>'classId','stance','balanced','allocations',allocation,
      'equipment',jsonb_build_object('weapon',weapon_id,'body',body_id,'offHand',null,'head',null,'feet',null)));
    insert into public.schedules(gladiator_id,schedule) values(gid,'{"morning":{"kind":"training"},"afternoon":{"kind":"expedition","expeditionId":"woodland"},"evening":{"kind":"rest"}}');
    insert into public.wallets(gladiator_id) values(gid);
    n := 0;
    for item in select * from jsonb_array_elements(input->'starterItems') loop
      item_id := case when n=0 then weapon_id else body_id end;
      insert into public.item_instances(id,gladiator_id,item) values(item_id,gid,item || jsonb_build_object('id',item_id,'ownerId',gid,'quantity',1,'origin','starter',
        'reservation',jsonb_build_object('kind','equipment','referenceId',gid)));
      n := n+1;
    end loop;
    result := jsonb_build_object('ok',true,'receiptId',receipt,'value',jsonb_build_object('gladiatorId',gid));
  exception when unique_violation then
    gid := null;
    result := jsonb_build_object('ok',false,'code','conflict');
  end;
  insert into public.operation_receipts(owner_id,operation_id,receipt_id,gladiator_id,request,request_digest,result)
    values(actor_id,operation_id,receipt,gid,command,sha256(convert_to(command::text,'UTF8')),result);
  if gid is not null then insert into public.wallet_ledger(gladiator_id,receipt_id,money_delta,renown_delta,reason) values(gid,receipt,100,0,'creation'); end if;
  return result;
end $_$;


ALTER FUNCTION "public"."create_gladiator"("actor_id" "uuid", "operation_id" "uuid", "input" "jsonb") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "private"."command_attempts" (
    "actor_id" "uuid" NOT NULL,
    "is_creation" boolean NOT NULL,
    "attempted_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL
);


ALTER TABLE "private"."command_attempts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."builds" (
    "gladiator_id" "uuid" NOT NULL,
    "current_build" "jsonb" NOT NULL,
    "pending_build" "jsonb",
    CONSTRAINT "builds_current_build_check" CHECK (("jsonb_typeof"("current_build") = 'object'::"text")),
    CONSTRAINT "builds_pending_build_check" CHECK (("jsonb_typeof"("pending_build") = 'object'::"text"))
);


ALTER TABLE "public"."builds" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."gladiators" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "normalized_name" "text" GENERATED ALWAYS AS ("lower"(("name" COLLATE "C"))) STORED,
    "level" bigint DEFAULT 1 NOT NULL,
    "xp" bigint DEFAULT 0 NOT NULL,
    "earned_points" bigint DEFAULT 10 NOT NULL,
    "unspent_points" bigint DEFAULT 0 NOT NULL,
    "league" "text" DEFAULT 'bronze'::"text" NOT NULL,
    "peak_strength" numeric DEFAULT 0 NOT NULL,
    "rating" bigint DEFAULT 1000 NOT NULL,
    "stamina_current" bigint NOT NULL,
    "stamina_maximum" bigint NOT NULL,
    "tournament_opt_in" boolean DEFAULT false NOT NULL,
    "processed_slot_index" bigint NOT NULL,
    "created_at_ms" bigint NOT NULL,
    "orientation_end_ms" bigint NOT NULL,
    CONSTRAINT "gladiators_check" CHECK ((("unspent_points" >= 0) AND ("unspent_points" <= "earned_points"))),
    CONSTRAINT "gladiators_check1" CHECK ((("stamina_maximum" >= 1) AND ("stamina_maximum" <= '9007199254740991'::bigint) AND ("stamina_current" <= "stamina_maximum"))),
    CONSTRAINT "gladiators_check2" CHECK ((("orientation_end_ms" > "created_at_ms") AND (("orientation_end_ms" % (4800000)::bigint) = 0))),
    CONSTRAINT "gladiators_earned_points_check" CHECK ((("earned_points" >= 10) AND ("earned_points" <= 1000000000))),
    CONSTRAINT "gladiators_league_check" CHECK (("league" = ANY (ARRAY['bronze'::"text", 'silver'::"text", 'gold'::"text", 'champion'::"text"]))),
    CONSTRAINT "gladiators_level_check" CHECK ((("level" >= 1) AND ("level" <= 1000000000))),
    CONSTRAINT "gladiators_name_check" CHECK ((("name" = "btrim"("name")) AND ("name" ~ '^[A-Za-z0-9 _-]{3,20}$'::"text"))),
    CONSTRAINT "gladiators_peak_strength_check" CHECK (("peak_strength" >= (0)::numeric)),
    CONSTRAINT "gladiators_processed_slot_index_check" CHECK (("processed_slot_index" >= 0)),
    CONSTRAINT "gladiators_rating_check" CHECK ((("rating" >= 0) AND ("rating" <= '9007199254740991'::bigint))),
    CONSTRAINT "gladiators_stamina_current_check" CHECK (("stamina_current" >= 0)),
    CONSTRAINT "gladiators_xp_check" CHECK ((("xp" >= 0) AND ("xp" <= '9007199254740991'::bigint)))
);


ALTER TABLE "public"."gladiators" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."item_instances" (
    "id" "uuid" NOT NULL,
    "gladiator_id" "uuid" NOT NULL,
    "item" "jsonb" NOT NULL,
    CONSTRAINT "item_instances_check" CHECK ((("jsonb_typeof"("item") = 'object'::"text") AND (("item" ->> 'id'::"text") = ("id")::"text") AND (("item" ->> 'ownerId'::"text") = ("gladiator_id")::"text") AND ("jsonb_typeof"(("item" -> 'quantity'::"text")) = 'number'::"text") AND (((("item" ->> 'quantity'::"text"))::numeric >= (1)::numeric) AND ((("item" ->> 'quantity'::"text"))::numeric <= (999)::numeric)) AND ("trunc"((("item" ->> 'quantity'::"text"))::numeric) = (("item" ->> 'quantity'::"text"))::numeric)))
);


ALTER TABLE "public"."item_instances" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."operation_receipts" (
    "owner_id" "uuid" NOT NULL,
    "operation_id" "uuid" NOT NULL,
    "receipt_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "gladiator_id" "uuid",
    "request" "jsonb" NOT NULL,
    "request_digest" "bytea" NOT NULL,
    "result" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL
);


ALTER TABLE "public"."operation_receipts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reservations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "gladiator_id" "uuid" NOT NULL,
    "operation_id" "uuid" NOT NULL,
    "money" bigint NOT NULL,
    "renown" bigint DEFAULT 0 NOT NULL,
    "status" "text" NOT NULL,
    CONSTRAINT "reservations_money_check" CHECK ((("money" >= 0) AND ("money" <= '9007199254740991'::bigint))),
    CONSTRAINT "reservations_renown_check" CHECK ((("renown" >= 0) AND ("renown" <= '9007199254740991'::bigint))),
    CONSTRAINT "reservations_status_check" CHECK (("status" = ANY (ARRAY['held'::"text", 'consumed'::"text", 'refunded'::"text"])))
);


ALTER TABLE "public"."reservations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."schedules" (
    "gladiator_id" "uuid" NOT NULL,
    "version" bigint DEFAULT 1 NOT NULL,
    "schedule" "jsonb" NOT NULL,
    CONSTRAINT "schedules_schedule_check" CHECK (("jsonb_typeof"("schedule") = 'object'::"text")),
    CONSTRAINT "schedules_version_check" CHECK ((("version" >= 1) AND ("version" <= '9007199254740991'::bigint)))
);


ALTER TABLE "public"."schedules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."wallets" (
    "gladiator_id" "uuid" NOT NULL,
    "money" bigint DEFAULT 100 NOT NULL,
    "renown" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "wallets_money_check" CHECK ((("money" >= 0) AND ("money" <= '9007199254740991'::bigint))),
    CONSTRAINT "wallets_renown_check" CHECK ((("renown" >= 0) AND ("renown" <= '9007199254740991'::bigint)))
);


ALTER TABLE "public"."wallets" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."owner_state" WITH ("security_invoker"='true') AS
 SELECT "g"."owner_id",
    "jsonb_build_object"('gladiatorId', "g"."id", 'name', "g"."name", 'currentBuild', "b"."current_build", 'pendingBuild', "b"."pending_build", 'schedule', "s"."schedule", 'scheduleVersion', "s"."version", 'wallets', "jsonb_build_object"('money', "w"."money", 'renown', "w"."renown"), 'reservedFees', "jsonb_build_object"('money', COALESCE(( SELECT "sum"("r"."money") AS "sum"
           FROM "public"."reservations" "r"
          WHERE (("r"."gladiator_id" = "g"."id") AND ("r"."status" = 'held'::"text"))), (0)::numeric), 'renown', COALESCE(( SELECT "sum"("r"."renown") AS "sum"
           FROM "public"."reservations" "r"
          WHERE (("r"."gladiator_id" = "g"."id") AND ("r"."status" = 'held'::"text"))), (0)::numeric)), 'inventory', COALESCE(( SELECT "jsonb_agg"("i"."item" ORDER BY "i"."id") AS "jsonb_agg"
           FROM "public"."item_instances" "i"
          WHERE ("i"."gladiator_id" = "g"."id")), '[]'::"jsonb"), 'inventoryCapacity', 60, 'progression', "jsonb_build_object"('level', "g"."level", 'xp', "g"."xp", 'earnedAttributePoints', "g"."earned_points", 'unspentAttributePoints', "g"."unspent_points", 'league', "g"."league", 'peakStrength', "g"."peak_strength", 'rating', "g"."rating"), 'stamina', "jsonb_build_object"('current', "g"."stamina_current", 'maximum', "g"."stamina_maximum"), 'tournamentOptIn', "g"."tournament_opt_in", 'processedSlotIndex', "g"."processed_slot_index", 'currentActivity', "jsonb_build_object"('id', "g"."id", 'kind', 'orientation', 'status',
        CASE
            WHEN ((EXTRACT("epoch" FROM "statement_timestamp"()) * (1000)::numeric) < ("g"."orientation_end_ms")::numeric) THEN 'active'::"text"
            ELSE 'processing'::"text"
        END, 'startsAtMs', "g"."created_at_ms", 'endsAtMs', "g"."orientation_end_ms", 'label', 'Orientation')) AS "state"
   FROM ((("public"."gladiators" "g"
     JOIN "public"."builds" "b" ON (("b"."gladiator_id" = "g"."id")))
     JOIN "public"."schedules" "s" ON (("s"."gladiator_id" = "g"."id")))
     JOIN "public"."wallets" "w" ON (("w"."gladiator_id" = "g"."id")));


ALTER VIEW "public"."owner_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."wallet_ledger" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "gladiator_id" "uuid" NOT NULL,
    "receipt_id" "uuid" NOT NULL,
    "money_delta" bigint NOT NULL,
    "renown_delta" bigint NOT NULL,
    "reason" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    CONSTRAINT "wallet_ledger_money_delta_check" CHECK ((("money_delta" >= '-9007199254740991'::bigint) AND ("money_delta" <= '9007199254740991'::bigint))),
    CONSTRAINT "wallet_ledger_renown_delta_check" CHECK ((("renown_delta" >= '-9007199254740991'::bigint) AND ("renown_delta" <= '9007199254740991'::bigint)))
);


ALTER TABLE "public"."wallet_ledger" OWNER TO "postgres";


ALTER TABLE ONLY "private"."command_attempts"
    ADD CONSTRAINT "command_attempts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."builds"
    ADD CONSTRAINT "builds_pkey" PRIMARY KEY ("gladiator_id");



ALTER TABLE ONLY "public"."gladiators"
    ADD CONSTRAINT "gladiators_normalized_name_key" UNIQUE ("normalized_name");



ALTER TABLE ONLY "public"."gladiators"
    ADD CONSTRAINT "gladiators_owner_id_key" UNIQUE ("owner_id");



ALTER TABLE ONLY "public"."gladiators"
    ADD CONSTRAINT "gladiators_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."item_instances"
    ADD CONSTRAINT "item_instances_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."operation_receipts"
    ADD CONSTRAINT "operation_receipts_pkey" PRIMARY KEY ("owner_id", "operation_id");



ALTER TABLE ONLY "public"."operation_receipts"
    ADD CONSTRAINT "operation_receipts_receipt_id_key" UNIQUE ("receipt_id");



ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_gladiator_id_operation_id_key" UNIQUE ("gladiator_id", "operation_id");



ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schedules"
    ADD CONSTRAINT "schedules_pkey" PRIMARY KEY ("gladiator_id");



ALTER TABLE ONLY "public"."wallet_ledger"
    ADD CONSTRAINT "wallet_ledger_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wallet_ledger"
    ADD CONSTRAINT "wallet_ledger_receipt_id_key" UNIQUE ("receipt_id");



ALTER TABLE ONLY "public"."wallets"
    ADD CONSTRAINT "wallets_pkey" PRIMARY KEY ("gladiator_id");



CREATE INDEX "command_attempts_actor_time_idx" ON "private"."command_attempts" USING "btree" ("actor_id", "is_creation", "attempted_at");



CREATE INDEX "item_instances_gladiator_idx" ON "public"."item_instances" USING "btree" ("gladiator_id");



CREATE INDEX "operation_receipts_gladiator_idx" ON "public"."operation_receipts" USING "btree" ("gladiator_id");



CREATE INDEX "wallet_ledger_gladiator_idx" ON "public"."wallet_ledger" USING "btree" ("gladiator_id");



ALTER TABLE ONLY "private"."command_attempts"
    ADD CONSTRAINT "command_attempts_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."builds"
    ADD CONSTRAINT "builds_gladiator_id_fkey" FOREIGN KEY ("gladiator_id") REFERENCES "public"."gladiators"("id");



ALTER TABLE ONLY "public"."gladiators"
    ADD CONSTRAINT "gladiators_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."item_instances"
    ADD CONSTRAINT "item_instances_gladiator_id_fkey" FOREIGN KEY ("gladiator_id") REFERENCES "public"."gladiators"("id");



ALTER TABLE ONLY "public"."operation_receipts"
    ADD CONSTRAINT "operation_receipts_gladiator_id_fkey" FOREIGN KEY ("gladiator_id") REFERENCES "public"."gladiators"("id");



ALTER TABLE ONLY "public"."operation_receipts"
    ADD CONSTRAINT "operation_receipts_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."reservations"
    ADD CONSTRAINT "reservations_gladiator_id_fkey" FOREIGN KEY ("gladiator_id") REFERENCES "public"."gladiators"("id");



ALTER TABLE ONLY "public"."schedules"
    ADD CONSTRAINT "schedules_gladiator_id_fkey" FOREIGN KEY ("gladiator_id") REFERENCES "public"."gladiators"("id");



ALTER TABLE ONLY "public"."wallet_ledger"
    ADD CONSTRAINT "wallet_ledger_gladiator_id_fkey" FOREIGN KEY ("gladiator_id") REFERENCES "public"."gladiators"("id");



ALTER TABLE ONLY "public"."wallet_ledger"
    ADD CONSTRAINT "wallet_ledger_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "public"."operation_receipts"("receipt_id");



ALTER TABLE ONLY "public"."wallets"
    ADD CONSTRAINT "wallets_gladiator_id_fkey" FOREIGN KEY ("gladiator_id") REFERENCES "public"."gladiators"("id");



CREATE POLICY "backend_only" ON "private"."command_attempts" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "private"."command_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."builds" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."gladiators" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."item_instances" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."operation_receipts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "owner_read" ON "public"."builds" FOR SELECT TO "authenticated" USING (("gladiator_id" IN ( SELECT "gladiators"."id"
   FROM "public"."gladiators"
  WHERE ("gladiators"."owner_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "owner_read" ON "public"."gladiators" FOR SELECT TO "authenticated" USING (("owner_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "owner_read" ON "public"."item_instances" FOR SELECT TO "authenticated" USING (("gladiator_id" IN ( SELECT "gladiators"."id"
   FROM "public"."gladiators"
  WHERE ("gladiators"."owner_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "owner_read" ON "public"."operation_receipts" FOR SELECT TO "authenticated" USING (("owner_id" = ( SELECT "auth"."uid"() AS "uid")));



CREATE POLICY "owner_read" ON "public"."reservations" FOR SELECT TO "authenticated" USING (("gladiator_id" IN ( SELECT "gladiators"."id"
   FROM "public"."gladiators"
  WHERE ("gladiators"."owner_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "owner_read" ON "public"."schedules" FOR SELECT TO "authenticated" USING (("gladiator_id" IN ( SELECT "gladiators"."id"
   FROM "public"."gladiators"
  WHERE ("gladiators"."owner_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "owner_read" ON "public"."wallet_ledger" FOR SELECT TO "authenticated" USING (("gladiator_id" IN ( SELECT "gladiators"."id"
   FROM "public"."gladiators"
  WHERE ("gladiators"."owner_id" = ( SELECT "auth"."uid"() AS "uid")))));



CREATE POLICY "owner_read" ON "public"."wallets" FOR SELECT TO "authenticated" USING (("gladiator_id" IN ( SELECT "gladiators"."id"
   FROM "public"."gladiators"
  WHERE ("gladiators"."owner_id" = ( SELECT "auth"."uid"() AS "uid")))));



ALTER TABLE "public"."reservations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."schedules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."wallet_ledger" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."wallets" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "private" TO "service_role";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































REVOKE ALL ON FUNCTION "public"."consume_command_rate"("actor_id" "uuid", "is_creation" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."consume_command_rate"("actor_id" "uuid", "is_creation" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_gladiator"("actor_id" "uuid", "operation_id" "uuid", "input" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_gladiator"("actor_id" "uuid", "operation_id" "uuid", "input" "jsonb") TO "service_role";


















GRANT SELECT,INSERT,DELETE ON TABLE "private"."command_attempts" TO "service_role";



GRANT SELECT ON TABLE "public"."builds" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."builds" TO "service_role";



GRANT SELECT ON TABLE "public"."gladiators" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."gladiators" TO "service_role";



GRANT SELECT ON TABLE "public"."item_instances" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."item_instances" TO "service_role";



GRANT SELECT ON TABLE "public"."operation_receipts" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."operation_receipts" TO "service_role";



GRANT SELECT ON TABLE "public"."reservations" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."reservations" TO "service_role";



GRANT SELECT ON TABLE "public"."schedules" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."schedules" TO "service_role";



GRANT SELECT ON TABLE "public"."wallets" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."wallets" TO "service_role";



GRANT SELECT ON TABLE "public"."owner_state" TO "authenticated";
GRANT SELECT ON TABLE "public"."owner_state" TO "service_role";



GRANT SELECT ON TABLE "public"."wallet_ledger" TO "authenticated";
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE "public"."wallet_ledger" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" REVOKE ALL ON FUNCTIONS FROM PUBLIC;




























drop extension if exists "pg_net";

revoke references on table "public"."builds" from "anon";

revoke trigger on table "public"."builds" from "anon";

revoke truncate on table "public"."builds" from "anon";

revoke references on table "public"."builds" from "authenticated";

revoke trigger on table "public"."builds" from "authenticated";

revoke truncate on table "public"."builds" from "authenticated";

revoke references on table "public"."builds" from "service_role";

revoke trigger on table "public"."builds" from "service_role";

revoke truncate on table "public"."builds" from "service_role";

revoke references on table "public"."gladiators" from "anon";

revoke trigger on table "public"."gladiators" from "anon";

revoke truncate on table "public"."gladiators" from "anon";

revoke references on table "public"."gladiators" from "authenticated";

revoke trigger on table "public"."gladiators" from "authenticated";

revoke truncate on table "public"."gladiators" from "authenticated";

revoke references on table "public"."gladiators" from "service_role";

revoke trigger on table "public"."gladiators" from "service_role";

revoke truncate on table "public"."gladiators" from "service_role";

revoke references on table "public"."item_instances" from "anon";

revoke trigger on table "public"."item_instances" from "anon";

revoke truncate on table "public"."item_instances" from "anon";

revoke references on table "public"."item_instances" from "authenticated";

revoke trigger on table "public"."item_instances" from "authenticated";

revoke truncate on table "public"."item_instances" from "authenticated";

revoke references on table "public"."item_instances" from "service_role";

revoke trigger on table "public"."item_instances" from "service_role";

revoke truncate on table "public"."item_instances" from "service_role";

revoke references on table "public"."operation_receipts" from "anon";

revoke trigger on table "public"."operation_receipts" from "anon";

revoke truncate on table "public"."operation_receipts" from "anon";

revoke references on table "public"."operation_receipts" from "authenticated";

revoke trigger on table "public"."operation_receipts" from "authenticated";

revoke truncate on table "public"."operation_receipts" from "authenticated";

revoke references on table "public"."operation_receipts" from "service_role";

revoke trigger on table "public"."operation_receipts" from "service_role";

revoke truncate on table "public"."operation_receipts" from "service_role";

revoke references on table "public"."reservations" from "anon";

revoke trigger on table "public"."reservations" from "anon";

revoke truncate on table "public"."reservations" from "anon";

revoke references on table "public"."reservations" from "authenticated";

revoke trigger on table "public"."reservations" from "authenticated";

revoke truncate on table "public"."reservations" from "authenticated";

revoke references on table "public"."reservations" from "service_role";

revoke trigger on table "public"."reservations" from "service_role";

revoke truncate on table "public"."reservations" from "service_role";

revoke references on table "public"."schedules" from "anon";

revoke trigger on table "public"."schedules" from "anon";

revoke truncate on table "public"."schedules" from "anon";

revoke references on table "public"."schedules" from "authenticated";

revoke trigger on table "public"."schedules" from "authenticated";

revoke truncate on table "public"."schedules" from "authenticated";

revoke references on table "public"."schedules" from "service_role";

revoke trigger on table "public"."schedules" from "service_role";

revoke truncate on table "public"."schedules" from "service_role";

revoke references on table "public"."wallet_ledger" from "anon";

revoke trigger on table "public"."wallet_ledger" from "anon";

revoke truncate on table "public"."wallet_ledger" from "anon";

revoke references on table "public"."wallet_ledger" from "authenticated";

revoke trigger on table "public"."wallet_ledger" from "authenticated";

revoke truncate on table "public"."wallet_ledger" from "authenticated";

revoke references on table "public"."wallet_ledger" from "service_role";

revoke trigger on table "public"."wallet_ledger" from "service_role";

revoke truncate on table "public"."wallet_ledger" from "service_role";

revoke references on table "public"."wallets" from "anon";

revoke trigger on table "public"."wallets" from "anon";

revoke truncate on table "public"."wallets" from "anon";

revoke references on table "public"."wallets" from "authenticated";

revoke trigger on table "public"."wallets" from "authenticated";

revoke truncate on table "public"."wallets" from "authenticated";

revoke references on table "public"."wallets" from "service_role";

revoke trigger on table "public"."wallets" from "service_role";

revoke truncate on table "public"."wallets" from "service_role";
