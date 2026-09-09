/**
 * Storefront shipping presentation (Migration 0059).
 *
 * Buyers must NOT see carriers or a long rate list. We collapse the live Shippo
 * rates into at most two named speeds — "Standard (3–5 days)" and
 * "Express (1–3 days)" — each with a price. The carrier/service token is kept
 * server-side (persisted on the order for the warehouse) and never returned to
 * the buyer. Pure function so it's fully unit-tested without Shippo.
 */
import type { ShippingRate } from "../integrations/shippo/shippo.service";

export type ShippingSpeed = "STANDARD" | "EXPRESS";

export interface BuyerShippingOption {
  speed: ShippingSpeed;
  label: string;
  /** Fixed, buyer-friendly delivery window copy (no carrier, no dates). */
  deliveryWindow: string;
  costCents: number;
  /** Internal only — the chosen service, persisted for the warehouse. Not shown. */
  serviceToken: string;
  estimatedDeliveryDays: number;
}

/**
 * Collapse raw carrier rates into ≤2 buyer options.
 *   STANDARD = the cheapest rate.
 *   EXPRESS  = the fastest rate, shown only when it is strictly faster than
 *              standard (otherwise there's nothing distinct to upsell).
 */
export function bucketRates(rates: ShippingRate[]): BuyerShippingOption[] {
  if (rates.length === 0) return [];

  const byPrice = [...rates].sort((a, b) => a.costCents - b.costCents);
  const bySpeed = [...rates].sort(
    (a, b) =>
      a.estimatedDeliveryDays - b.estimatedDeliveryDays || a.costCents - b.costCents,
  );
  const cheapest = byPrice[0]!;
  const fastest = bySpeed[0]!;

  const options: BuyerShippingOption[] = [
    {
      speed: "STANDARD",
      label: "Standard",
      deliveryWindow: "3–5 business days",
      costCents: cheapest.costCents,
      serviceToken: cheapest.service,
      estimatedDeliveryDays: cheapest.estimatedDeliveryDays,
    },
  ];

  if (
    fastest.service !== cheapest.service &&
    fastest.estimatedDeliveryDays < cheapest.estimatedDeliveryDays
  ) {
    options.push({
      speed: "EXPRESS",
      label: "Express",
      deliveryWindow: "1–3 business days",
      costCents: fastest.costCents,
      serviceToken: fastest.service,
      estimatedDeliveryDays: fastest.estimatedDeliveryDays,
    });
  }

  return options;
}
