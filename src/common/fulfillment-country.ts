/**
 * Fulfillment-country helpers — USA + Canada backbone (migration 0077).
 *
 * The platform fulfils from two country-scoped stock pools, US and CA. An
 * order's *destination* country (`order.shipCountry`) decides which pool it
 * draws from: a Canada delivery pulls Canada stock, everything else pulls USA
 * stock. These helpers are the single place that mapping lives, so allocation,
 * inventory views and reporting all agree.
 *
 * Only US and CA are supported today; any other/absent value resolves to US.
 */

export type FulfillmentCountry = "US" | "CA";

/** Normalise any country-ish string to a supported fulfillment country. */
export function toFulfillmentCountry(value: string | null | undefined): FulfillmentCountry {
  return (value ?? "US").toUpperCase() === "CA" ? "CA" : "US";
}

/** The stock country an order should allocate against, from its destination. */
export function fulfillmentCountryForShipTo(
  shipCountry: string | null | undefined,
): FulfillmentCountry {
  return toFulfillmentCountry(shipCountry);
}

/**
 * Configuration-table key for the master country-routing switch. While this is
 * OFF (the default until the Canada rollout completes — admins, migration and
 * Canada stock all in place), allocation does NOT filter by country, so the
 * platform behaves exactly as it does today. Phase 2 reads this flag before
 * constraining a line to same-country stock.
 */
export const COUNTRY_ROUTING_CONFIG_KEY = "country_routing_enabled";
