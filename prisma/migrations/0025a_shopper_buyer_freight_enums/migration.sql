-- Migration 0025a — additions to the ShopperShippingMethod and
-- ShopperRequestStatus enums. Split from the column changes (0025) because
-- Postgres rejects "ALTER TYPE ... ADD VALUE" in the same transaction as a
-- subsequent DDL that uses the new value (error 55P04). The split + sequential
-- migration files mirror the pattern established by migration 0023a / 0023.

-- New shipping method — buyer provides their own carrier label (we ship on
-- it but don't price freight). The existing BUYER_FORWARDER stays for the
-- "we ship to your forwarder address" flow.
ALTER TYPE "ShopperShippingMethod" ADD VALUE IF NOT EXISTS 'BUYER_FREIGHT';

-- New terminal-readiness status for the PICKUP flow. PLATFORM_FREIGHT /
-- BUYER_FORWARDER / BUYER_FREIGHT continue to use READY_TO_SHIP since they
-- all transition to SHIPPED next. PICKUP transitions from READY_FOR_PICKUP
-- to DELIVERED when the admin marks the package picked up.
ALTER TYPE "ShopperRequestStatus" ADD VALUE IF NOT EXISTS 'READY_FOR_PICKUP';
