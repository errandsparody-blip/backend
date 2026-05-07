-- CreateEnum
CREATE TYPE "Role" AS ENUM ('VENDOR', 'VENDOR_SUB_USER', 'WAREHOUSE_OPERATOR', 'FINANCE_ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_EMAIL_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'REQUIRES_RESUBMISSION', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "VendorStatus" AS ENUM ('PENDING_KYC', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "StorageTier" AS ENUM ('SMALL', 'MEDIUM', 'LARGE', 'X_LARGE', 'PALLET');

-- CreateEnum
CREATE TYPE "SkuStatus" AS ENUM ('ACTIVE', 'RESERVED', 'DAMAGED', 'QUARANTINED', 'OUT_OF_STOCK');

-- CreateEnum
CREATE TYPE "PsnStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'AWAITING_RECEIPT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'DISCREPANCY', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PackagingExceptionResolution" AS ENUM ('PENDING', 'REPACKAGE', 'RETURN_TO_SENDER', 'HOLD');

-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'STORAGE_OVERDUE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('DEPOSIT', 'ONBOARDING', 'STORAGE', 'FULFILLMENT', 'SHIPPING', 'RETURN', 'MANUAL_CREDIT', 'MANUAL_DEBIT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'ERROR');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'ALLOCATED', 'LABEL_PURCHASED', 'PICKING', 'PACKED', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'EXCEPTION', 'CANCELLED', 'RETURNED');

-- CreateEnum
CREATE TYPE "OrderCancelReason" AS ENUM ('VENDOR_REQUEST', 'OUT_OF_STOCK', 'ADDRESS_INVALID', 'CARRIER_REFUSED', 'FRAUD_HOLD', 'OTHER');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('REQUESTED', 'AUTHORIZED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'RESTOCKED', 'DISPOSED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('NOT_AS_DESCRIBED', 'DEFECTIVE', 'WRONG_ITEM', 'CHANGED_MIND', 'ARRIVED_DAMAGED', 'NEVER_DELIVERED', 'OTHER');

-- CreateEnum
CREATE TYPE "VendorInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "email_verify_token_hash" TEXT,
    "email_verify_expires_at" TIMESTAMP(3),
    "role" "Role" NOT NULL DEFAULT 'VENDOR',
    "vendor_id" UUID,
    "mfa_enrolled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret_encrypted" TEXT,
    "mfa_enrolled_at" TIMESTAMP(3),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_EMAIL_VERIFICATION',
    "password_reset_token_hash" TEXT,
    "password_reset_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" UUID NOT NULL,
    "business_name" TEXT NOT NULL,
    "country" CHAR(2) NOT NULL,
    "kyc_status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "kyc_provider_id" TEXT,
    "kyc_submitted_at" TIMESTAMP(3),
    "kyc_approved_at" TIMESTAMP(3),
    "agreement_accepted_at" TIMESTAMP(3),
    "agreement_version" TEXT,
    "status" "VendorStatus" NOT NULL DEFAULT 'PENDING_KYC',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "rotated_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "user_agent" TEXT,
    "ip" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "variant" TEXT NOT NULL DEFAULT 'STD',
    "hs_code" TEXT,
    "country_of_origin" CHAR(2) NOT NULL,
    "declared_value_cents" INTEGER NOT NULL,
    "weight_oz" DOUBLE PRECISION NOT NULL,
    "length_in" DOUBLE PRECISION NOT NULL,
    "width_in" DOUBLE PRECISION NOT NULL,
    "height_in" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skus" (
    "id" TEXT NOT NULL,
    "vendor_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant" TEXT NOT NULL,
    "quantity_available" INTEGER NOT NULL DEFAULT 0,
    "quantity_reserved" INTEGER NOT NULL DEFAULT 0,
    "storage_tier" "StorageTier" NOT NULL DEFAULT 'SMALL',
    "warehouse_location" TEXT,
    "status" "SkuStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "psns" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "status" "PsnStatus" NOT NULL DEFAULT 'DRAFT',
    "expected_arrival_date" TIMESTAMP(3),
    "carrier" TEXT,
    "master_tracking" TEXT,
    "declared_box_counts" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "onboarding_fee_cents" INTEGER,
    "onboarding_fee_paid_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "psns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "psn_lines" (
    "id" UUID NOT NULL,
    "psn_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku_id" TEXT,
    "declared_qty" INTEGER NOT NULL,
    "received_qty" INTEGER NOT NULL DEFAULT 0,
    "accepted_qty" INTEGER NOT NULL DEFAULT 0,
    "damaged_qty" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "psn_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packaging_exceptions" (
    "id" UUID NOT NULL,
    "psn_id" UUID NOT NULL,
    "resolution" "PackagingExceptionResolution" NOT NULL DEFAULT 'PENDING',
    "fee_cents" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "packaging_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "sku_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "delta_available" INTEGER NOT NULL DEFAULT 0,
    "delta_reserved" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "actor_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "vendor_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_log_entries" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_role" "Role",
    "on_behalf_of_vendor_id" UUID,
    "source_ip" TEXT,
    "user_agent" TEXT,
    "correlation_id" TEXT,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "before_state" JSONB,
    "after_state" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "balance_cents" INTEGER NOT NULL DEFAULT 0,
    "low_balance_threshold_cents" INTEGER NOT NULL DEFAULT 5000,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "balance_after_cents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "idempotency_key" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "vendor_id" UUID,
    "user_id" UUID,
    "type" TEXT NOT NULL,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "href" TEXT,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "external_reference" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "recipient_name" TEXT NOT NULL,
    "recipient_phone" TEXT,
    "recipient_email" TEXT,
    "ship_address_line1" TEXT NOT NULL,
    "ship_address_line2" TEXT,
    "ship_city" TEXT NOT NULL,
    "ship_state" TEXT NOT NULL,
    "ship_postal_code" TEXT NOT NULL,
    "ship_country" CHAR(2) NOT NULL DEFAULT 'US',
    "address_validation_status" TEXT NOT NULL DEFAULT 'PENDING',
    "address_validation_detail" JSONB,
    "carrier" TEXT,
    "carrier_service" TEXT,
    "tracking_number" TEXT,
    "label_url" TEXT,
    "rate_provider_ref" TEXT,
    "rate_purchased_ref" TEXT,
    "items_declared_value_cents" INTEGER NOT NULL DEFAULT 0,
    "shipping_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "shipping_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "fulfillment_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "insurance_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "total_charged_cents" INTEGER NOT NULL DEFAULT 0,
    "reassessment_delta_cents" INTEGER NOT NULL DEFAULT 0,
    "reassessed_at" TIMESTAMP(3),
    "cancel_reason" "OrderCancelReason",
    "cancel_note" TEXT,
    "submitted_at" TIMESTAMP(3),
    "allocated_at" TIMESTAMP(3),
    "label_purchased_at" TIMESTAMP(3),
    "picking_started_at" TIMESTAMP(3),
    "packed_at" TIMESTAMP(3),
    "shipped_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku_id" TEXT NOT NULL,
    "product_code" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "declared_value_cents" INTEGER NOT NULL,
    "allocation_status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "source" TEXT NOT NULL DEFAULT 'SYSTEM',
    "actor_id" UUID,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "returns" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "rma_code" TEXT NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" "ReturnReason" NOT NULL,
    "inbound_tracking" TEXT,
    "inbound_carrier" TEXT,
    "inbound_label_url" TEXT,
    "refund_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "restock_fee_cents" INTEGER NOT NULL DEFAULT 0,
    "inspector_notes" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authorized_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "inspected_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_lines" (
    "id" UUID NOT NULL,
    "return_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "sku_id" TEXT NOT NULL,
    "requested_qty" INTEGER NOT NULL,
    "received_qty" INTEGER NOT NULL DEFAULT 0,
    "restocked_qty" INTEGER NOT NULL DEFAULT 0,
    "damaged_qty" INTEGER NOT NULL DEFAULT 0,
    "disposed_qty" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_invitations" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "role_at_accept" "Role" NOT NULL DEFAULT 'VENDOR_SUB_USER',
    "status" "VendorInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invited_by" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configuration" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updated_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "configuration_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_vendor_id_idx" ON "users"("vendor_id");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "vendors_status_idx" ON "vendors"("status");

-- CreateIndex
CREATE INDEX "vendors_kyc_status_idx" ON "vendors"("kyc_status");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_refresh_token_hash_idx" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "recovery_codes_user_id_idx" ON "recovery_codes"("user_id");

-- CreateIndex
CREATE INDEX "products_vendor_id_status_idx" ON "products"("vendor_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "products_vendor_id_code_key" ON "products"("vendor_id", "code");

-- CreateIndex
CREATE INDEX "skus_vendor_id_status_idx" ON "skus"("vendor_id", "status");

-- CreateIndex
CREATE INDEX "skus_product_id_idx" ON "skus"("product_id");

-- CreateIndex
CREATE INDEX "psns_vendor_id_status_idx" ON "psns"("vendor_id", "status");

-- CreateIndex
CREATE INDEX "psns_status_created_at_idx" ON "psns"("status", "created_at");

-- CreateIndex
CREATE INDEX "psn_lines_psn_id_idx" ON "psn_lines"("psn_id");

-- CreateIndex
CREATE INDEX "packaging_exceptions_psn_id_idx" ON "packaging_exceptions"("psn_id");

-- CreateIndex
CREATE INDEX "inventory_movements_vendor_id_created_at_idx" ON "inventory_movements"("vendor_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_movements_sku_id_created_at_idx" ON "inventory_movements"("sku_id", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_vendor_id_endpoint_idx" ON "idempotency_keys"("vendor_id", "endpoint");

-- CreateIndex
CREATE INDEX "audit_log_entries_actor_id_created_at_idx" ON "audit_log_entries"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_entries_resource_type_resource_id_idx" ON "audit_log_entries"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_log_entries_action_created_at_idx" ON "audit_log_entries"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_entries_created_at_idx" ON "audit_log_entries"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_vendor_id_key" ON "wallets"("vendor_id");

-- CreateIndex
CREATE INDEX "ledger_entries_vendor_id_created_at_idx" ON "ledger_entries"("vendor_id", "created_at");

-- CreateIndex
CREATE INDEX "ledger_entries_type_created_at_idx" ON "ledger_entries"("type", "created_at");

-- CreateIndex
CREATE INDEX "ledger_entries_reference_type_reference_id_idx" ON "ledger_entries"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "notifications_vendor_id_read_at_created_at_idx" ON "notifications"("vendor_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE INDEX "notifications_type_created_at_idx" ON "notifications"("type", "created_at");

-- CreateIndex
CREATE INDEX "webhook_events_provider_processed_at_idx" ON "webhook_events"("provider", "processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_event_id_key" ON "webhook_events"("provider", "event_id");

-- CreateIndex
CREATE INDEX "orders_vendor_id_status_created_at_idx" ON "orders"("vendor_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "orders_tracking_number_idx" ON "orders"("tracking_number");

-- CreateIndex
CREATE INDEX "orders_carrier_status_idx" ON "orders"("carrier", "status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_vendor_id_external_reference_key" ON "orders"("vendor_id", "external_reference");

-- CreateIndex
CREATE INDEX "order_lines_order_id_idx" ON "order_lines"("order_id");

-- CreateIndex
CREATE INDEX "order_lines_sku_id_idx" ON "order_lines"("sku_id");

-- CreateIndex
CREATE INDEX "order_lines_vendor_id_idx" ON "order_lines"("vendor_id");

-- CreateIndex
CREATE INDEX "order_events_order_id_occurred_at_idx" ON "order_events"("order_id", "occurred_at");

-- CreateIndex
CREATE INDEX "order_events_type_occurred_at_idx" ON "order_events"("type", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "returns_rma_code_key" ON "returns"("rma_code");

-- CreateIndex
CREATE INDEX "returns_vendor_id_status_created_at_idx" ON "returns"("vendor_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "returns_order_id_idx" ON "returns"("order_id");

-- CreateIndex
CREATE INDEX "returns_status_created_at_idx" ON "returns"("status", "created_at");

-- CreateIndex
CREATE INDEX "return_lines_return_id_idx" ON "return_lines"("return_id");

-- CreateIndex
CREATE INDEX "return_lines_order_line_id_idx" ON "return_lines"("order_line_id");

-- CreateIndex
CREATE INDEX "vendor_invitations_vendor_id_status_created_at_idx" ON "vendor_invitations"("vendor_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "vendor_invitations_email_idx" ON "vendor_invitations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_invitations_token_hash_key" ON "vendor_invitations"("token_hash");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skus" ADD CONSTRAINT "skus_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skus" ADD CONSTRAINT "skus_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psns" ADD CONSTRAINT "psns_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psn_lines" ADD CONSTRAINT "psn_lines_psn_id_fkey" FOREIGN KEY ("psn_id") REFERENCES "psns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psn_lines" ADD CONSTRAINT "psn_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "psn_lines" ADD CONSTRAINT "psn_lines_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packaging_exceptions" ADD CONSTRAINT "packaging_exceptions_psn_id_fkey" FOREIGN KEY ("psn_id") REFERENCES "psns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log_entries" ADD CONSTRAINT "audit_log_entries_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

