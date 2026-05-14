-- Migration 0028 — pricing-guide lead capture.
--
-- Public marketing /pricing page hosts a "Get Our Full Price Guide" form
-- that emails the visitor the PDF. We store every submission so sales can
-- follow up and we can rate-limit / triage spam. Independent of users +
-- vendors (these are pre-conversion prospects).

CREATE TABLE "pricing_guide_leads" (
    "id"             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "business_name"  TEXT         NOT NULL,
    "email"          TEXT         NOT NULL,
    "country"        VARCHAR(2)   NOT NULL,
    "source_ip"      TEXT,
    "user_agent"     TEXT,
    "email_sent_at"  TIMESTAMPTZ,
    "created_at"     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX "pricing_guide_leads_email_idx"      ON "pricing_guide_leads" ("email");
CREATE INDEX "pricing_guide_leads_created_at_idx" ON "pricing_guide_leads" ("created_at");
