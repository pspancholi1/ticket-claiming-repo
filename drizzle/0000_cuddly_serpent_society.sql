CREATE TYPE "public"."claim_event_type" AS ENUM('claimed', 'expired');--> statement-breakpoint
CREATE TABLE "claim_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticket_id" bigint NOT NULL,
	"agent_id" integer NOT NULL,
	"type" "claim_event_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"title" varchar(255) NOT NULL,
	"customer_email" varchar(255) NOT NULL,
	"claimed_by_agent_id" integer,
	"claimed_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_fields_consistent" CHECK (("tickets"."claimed_by_agent_id" IS NULL AND "tickets"."claimed_at" IS NULL AND "tickets"."last_activity_at" IS NULL)
       OR ("tickets"."claimed_by_agent_id" IS NOT NULL AND "tickets"."claimed_at" IS NOT NULL AND "tickets"."last_activity_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_claim_events_ticket" ON "claim_events" USING btree ("ticket_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_claim_events_type_created" ON "claim_events" USING btree ("type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ix_tickets_unclaimed" ON "tickets" USING btree ("created_at") WHERE "tickets"."claimed_by_agent_id" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_tickets_claimed_activity" ON "tickets" USING btree ("last_activity_at") WHERE "tickets"."claimed_by_agent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_tickets_by_agent" ON "tickets" USING btree ("claimed_by_agent_id") WHERE "tickets"."claimed_by_agent_id" IS NOT NULL;