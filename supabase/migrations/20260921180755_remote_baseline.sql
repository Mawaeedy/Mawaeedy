


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


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";





SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."availability_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "day_of_week" smallint,
    "start_time" time without time zone,
    "end_time" time without time zone,
    "label" "text",
    "enabled" boolean DEFAULT true NOT NULL,
    CONSTRAINT "availability_rules_day_of_week_check" CHECK ((("day_of_week" >= 0) AND ("day_of_week" <= 6)))
);


ALTER TABLE "public"."availability_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."booking_rules" (
    "owner_id" "uuid" NOT NULL,
    "minimum_notice_minutes" integer DEFAULT 60 NOT NULL,
    "maximum_days_ahead" integer DEFAULT 60 NOT NULL,
    "buffer_minutes" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "booking_rules_buffer_minutes_check" CHECK (("buffer_minutes" >= 0)),
    CONSTRAINT "booking_rules_maximum_days_ahead_check" CHECK (("maximum_days_ahead" > 0)),
    CONSTRAINT "booking_rules_minimum_notice_minutes_check" CHECK (("minimum_notice_minutes" >= 0))
);


ALTER TABLE "public"."booking_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bookings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "meeting_type_id" "uuid",
    "guest_name" "text" NOT NULL,
    "guest_email" "text" NOT NULL,
    "guest_timezone" "text",
    "starts_at" timestamp with time zone NOT NULL,
    "ends_at" timestamp with time zone NOT NULL,
    "notes" "text",
    "status" "text" DEFAULT 'confirmed'::"text" NOT NULL,
    "manage_token_hash" "text",
    "google_event_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "bookings_status_check" CHECK (("status" = ANY (ARRAY['confirmed'::"text", 'cancelled'::"text", 'rescheduled'::"text"])))
);


ALTER TABLE "public"."bookings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."integrations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "access_token_encrypted" "text",
    "refresh_token_encrypted" "text",
    "expires_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "integrations_provider_check" CHECK (("provider" = ANY (ARRAY['google'::"text", 'microsoft'::"text", 'apple'::"text", 'zoom'::"text", 'teams'::"text"])))
);


ALTER TABLE "public"."integrations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."meeting_types" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "name_ar" "text" NOT NULL,
    "name_en" "text" NOT NULL,
    "duration_minutes" integer DEFAULT 30 NOT NULL,
    "mode" "text" DEFAULT 'Google Meet'::"text" NOT NULL,
    "color" "text" DEFAULT '#2166f3'::"text" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "meeting_types_duration_minutes_check" CHECK ((("duration_minutes" >= 5) AND ("duration_minutes" <= 480)))
);


ALTER TABLE "public"."meeting_types" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_preferences" (
    "owner_id" "uuid" NOT NULL,
    "email" boolean DEFAULT true NOT NULL,
    "whatsapp" boolean DEFAULT false NOT NULL,
    "sms" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notification_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "booking_id" "uuid",
    "channel" "text" DEFAULT 'in-app'::"text" NOT NULL,
    "notification_type" "text" NOT NULL,
    "message" "text" NOT NULL,
    "status" "text" DEFAULT 'unread'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "name" "text" DEFAULT ''::"text" NOT NULL,
    "photo" "text",
    "bio" "text",
    "job_title" "text",
    "timezone" "text" DEFAULT 'Asia/Riyadh'::"text" NOT NULL,
    "slug" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


ALTER TABLE ONLY "public"."availability_rules"
    ADD CONSTRAINT "availability_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."booking_rules"
    ADD CONSTRAINT "booking_rules_pkey" PRIMARY KEY ("owner_id");



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."integrations"
    ADD CONSTRAINT "integrations_owner_id_provider_key" UNIQUE ("owner_id", "provider");



ALTER TABLE ONLY "public"."integrations"
    ADD CONSTRAINT "integrations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."meeting_types"
    ADD CONSTRAINT "meeting_types_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("owner_id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_slug_key" UNIQUE ("slug");



CREATE INDEX "bookings_owner_start_idx" ON "public"."bookings" USING "btree" ("owner_id", "starts_at");



CREATE INDEX "meeting_types_owner_idx" ON "public"."meeting_types" USING "btree" ("owner_id", "active");



CREATE INDEX "profiles_slug_idx" ON "public"."profiles" USING "btree" ("slug");



ALTER TABLE ONLY "public"."availability_rules"
    ADD CONSTRAINT "availability_rules_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."booking_rules"
    ADD CONSTRAINT "booking_rules_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_meeting_type_id_fkey" FOREIGN KEY ("meeting_type_id") REFERENCES "public"."meeting_types"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bookings"
    ADD CONSTRAINT "bookings_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."integrations"
    ADD CONSTRAINT "integrations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."meeting_types"
    ADD CONSTRAINT "meeting_types_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE "public"."availability_rules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."booking_rules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."bookings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."integrations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."meeting_types" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "owners manage availability" ON "public"."availability_rules" USING (("auth"."uid"() = "owner_id")) WITH CHECK (("auth"."uid"() = "owner_id"));



CREATE POLICY "owners manage booking rules" ON "public"."booking_rules" USING (("auth"."uid"() = "owner_id")) WITH CHECK (("auth"."uid"() = "owner_id"));



CREATE POLICY "owners manage integrations" ON "public"."integrations" USING (("auth"."uid"() = "owner_id")) WITH CHECK (("auth"."uid"() = "owner_id"));



CREATE POLICY "owners manage meeting types" ON "public"."meeting_types" USING (("auth"."uid"() = "owner_id")) WITH CHECK (("auth"."uid"() = "owner_id"));



CREATE POLICY "owners manage notification preferences" ON "public"."notification_preferences" USING (("auth"."uid"() = "owner_id")) WITH CHECK (("auth"."uid"() = "owner_id"));



CREATE POLICY "owners read bookings" ON "public"."bookings" FOR SELECT USING (("auth"."uid"() = "owner_id"));



CREATE POLICY "owners read notifications" ON "public"."notifications" FOR SELECT USING (("auth"."uid"() = "owner_id"));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles owner write" ON "public"."profiles" USING (("auth"."uid"() = "id")) WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "profiles public read by slug" ON "public"."profiles" FOR SELECT USING (true);





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";





































































































































































GRANT ALL ON TABLE "public"."availability_rules" TO "anon";
GRANT ALL ON TABLE "public"."availability_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."availability_rules" TO "service_role";



GRANT ALL ON TABLE "public"."booking_rules" TO "anon";
GRANT ALL ON TABLE "public"."booking_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."booking_rules" TO "service_role";



GRANT ALL ON TABLE "public"."bookings" TO "anon";
GRANT ALL ON TABLE "public"."bookings" TO "authenticated";
GRANT ALL ON TABLE "public"."bookings" TO "service_role";



GRANT ALL ON TABLE "public"."integrations" TO "anon";
GRANT ALL ON TABLE "public"."integrations" TO "authenticated";
GRANT ALL ON TABLE "public"."integrations" TO "service_role";



GRANT ALL ON TABLE "public"."meeting_types" TO "anon";
GRANT ALL ON TABLE "public"."meeting_types" TO "authenticated";
GRANT ALL ON TABLE "public"."meeting_types" TO "service_role";



GRANT ALL ON TABLE "public"."notification_preferences" TO "anon";
GRANT ALL ON TABLE "public"."notification_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































drop extension if exists "pg_net";

CREATE TRIGGER protect_bucket_control_insert BEFORE INSERT ON storage.buckets FOR EACH ROW EXECUTE FUNCTION storage.protect_bucket_control_columns('service_role');

CREATE TRIGGER protect_bucket_control_update BEFORE UPDATE OF lifecycle_configuration, lifecycle_configuration_generation ON storage.buckets FOR EACH ROW EXECUTE FUNCTION storage.protect_bucket_control_columns();

CREATE TRIGGER protect_bucket_control_update_role AFTER UPDATE OF lifecycle_configuration, lifecycle_configuration_generation ON storage.buckets FOR EACH ROW EXECUTE FUNCTION storage.enforce_bucket_lifecycle_service_role('service_role');
