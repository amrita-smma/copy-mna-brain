-- add_is_deal_related_to_topics
ALTER TABLE "topics" ADD COLUMN "is_deal_related" boolean NOT NULL DEFAULT false;
