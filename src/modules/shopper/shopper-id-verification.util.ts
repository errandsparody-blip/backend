import type { Logger } from "@nestjs/common";

import type { PrismaService } from "../../common/prisma.service";

/** Admin config key (`configuration` table). */
export const WIRE_THRESHOLD_CONFIG_KEY = "shopper_wire_threshold_cents";

/** Used only when the config row is missing or invalid — not the live threshold. */
export const WIRE_THRESHOLD_FALLBACK_CENTS = 1_000_000;

export const WIRE_THRESHOLD_MAX_CENTS = 10_000_000;

export type IdGateRequest = {
  itemsActualSubtotalCents: number | null;
  itemsSubtotalCents: number;
  idVerificationStatus: string;
};

export function itemsSubtotalForIdGate(
  row: Pick<IdGateRequest, "itemsActualSubtotalCents" | "itemsSubtotalCents">,
): number {
  return row.itemsActualSubtotalCents ?? row.itemsSubtotalCents;
}

export function requiresIdVerificationAtSubtotal(
  subtotalCents: number,
  thresholdCents: number,
): boolean {
  return subtotalCents >= thresholdCents;
}

/** Whether the buyer thread should show the ID upload card. */
export function buyerIdVerificationRequired(
  row: Pick<IdGateRequest, "itemsActualSubtotalCents" | "itemsSubtotalCents">,
  thresholdCents: number,
): boolean {
  return requiresIdVerificationAtSubtotal(itemsSubtotalForIdGate(row), thresholdCents);
}

/**
 * Whether the buyer may proceed without an approved gov-ID packet.
 * `thresholdCents` must come from {@link loadWireThresholdCents} (admin config).
 */
export function buyerIdCheckPassed(row: IdGateRequest, thresholdCents: number): boolean {
  const subtotalCents = itemsSubtotalForIdGate(row);
  if (!requiresIdVerificationAtSubtotal(subtotalCents, thresholdCents)) {
    return true;
  }
  return row.idVerificationStatus === "APPROVED";
}

/** Reads `shopper_wire_threshold_cents` set on the admin shopper config page. */
export async function loadWireThresholdCents(
  prisma: PrismaService,
  logger?: Logger,
): Promise<number> {
  try {
    const row = await prisma.configuration.findUnique({
      where: { key: WIRE_THRESHOLD_CONFIG_KEY },
    });
    if (!row) return WIRE_THRESHOLD_FALLBACK_CENTS;
    const value = row.value as unknown;
    const cents = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(cents) || cents < 0 || cents > WIRE_THRESHOLD_MAX_CENTS) {
      logger?.warn(
        { value, max: WIRE_THRESHOLD_MAX_CENTS },
        "shopper_wire_threshold_cents: invalid; falling back to default",
      );
      return WIRE_THRESHOLD_FALLBACK_CENTS;
    }
    return Math.floor(cents);
  } catch (err) {
    logger?.error({ err }, "shopper.wire_threshold_load_failed");
    return WIRE_THRESHOLD_FALLBACK_CENTS;
  }
}
