/**
 * AddressAutocompleteService — server-side Google Places proxy for checkout
 * address autocomplete (Migration: address autocomplete).
 *
 * The Google key lives only on the server (GOOGLE_PLACES_API_KEY), so the
 * browser never sees it. Two calls back the checkout typeahead:
 *   - suggest(q, country) → address predictions (legacy Places Autocomplete)
 *   - details(placeId)    → a structured, 2-letter-region address (Place Details)
 *
 * When the key is unset, both return empty results so buyers simply type the
 * address by hand (the manual fields keep working). Restricted to the two
 * countries the marketplace ships to (US, CA).
 */
import { Injectable, Logger } from "@nestjs/common";

import { loadConfig } from "../../common/config";

export interface AddressPrediction {
  description: string;
  placeId: string;
}

export interface StructuredAddress {
  line1: string;
  city: string;
  state: string; // 2-letter code
  postalCode: string;
  country: string; // 2-letter code
}

const SUPPORTED = new Set(["US", "CA"]);

@Injectable()
export class AddressAutocompleteService {
  private readonly log = new Logger(AddressAutocompleteService.name);
  private readonly cfg = loadConfig();

  get enabled(): boolean {
    return Boolean(this.cfg.GOOGLE_PLACES_API_KEY);
  }

  /** Address predictions for a partial query, restricted to US/CA. */
  async suggest(
    query: string,
    country: string,
    sessionToken?: string,
  ): Promise<AddressPrediction[]> {
    const key = this.cfg.GOOGLE_PLACES_API_KEY;
    const q = query.trim();
    if (!key || q.length < 3) return [];
    const cc = SUPPORTED.has(country) ? country : "US";
    const params = new URLSearchParams({
      input: q,
      key,
      types: "address",
      components: `country:${cc.toLowerCase()}`,
    });
    if (sessionToken) params.set("sessiontoken", sessionToken);
    try {
      const res = await this.fetchJson(
        `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params.toString()}`,
      );
      // Google returns HTTP 200 even for errors, with the reason in `status`
      // (e.g. REQUEST_DENIED when the legacy "Places API" isn't enabled or
      // billing is off). Log it so config problems aren't silent.
      const status = (res as { status?: string }).status;
      if (status && status !== "OK" && status !== "ZERO_RESULTS") {
        this.log.warn(
          { status, error: (res as { error_message?: string }).error_message },
          "address.autocomplete.google_status",
        );
      }
      const predictions = Array.isArray(res?.predictions) ? res.predictions : [];
      return predictions
        .filter((p: { description?: string; place_id?: string }) => p.description && p.place_id)
        .slice(0, 6)
        .map((p: { description: string; place_id: string }) => ({
          description: p.description,
          placeId: p.place_id,
        }));
    } catch (err) {
      this.log.warn({ err: `${err}` }, "address.autocomplete.suggest_failed");
      return [];
    }
  }

  /** Resolve a prediction into a structured, form-fillable address. */
  async details(placeId: string, sessionToken?: string): Promise<StructuredAddress | null> {
    const key = this.cfg.GOOGLE_PLACES_API_KEY;
    if (!key || !placeId) return null;
    const params = new URLSearchParams({
      place_id: placeId,
      key,
      fields: "address_component",
    });
    if (sessionToken) params.set("sessiontoken", sessionToken);
    try {
      const res = await this.fetchJson(
        `https://maps.googleapis.com/maps/api/place/details/json?${params.toString()}`,
      );
      const components = res?.result?.address_components;
      if (!Array.isArray(components)) return null;
      return this.parseComponents(components);
    } catch (err) {
      this.log.warn({ err: `${err}` }, "address.autocomplete.details_failed");
      return null;
    }
  }

  private parseComponents(
    components: Array<{ long_name: string; short_name: string; types: string[] }>,
  ): StructuredAddress {
    const get = (type: string, short = false): string => {
      const c = components.find((x) => x.types.includes(type));
      return c ? (short ? c.short_name : c.long_name) : "";
    };
    const streetNumber = get("street_number");
    const route = get("route");
    const line1 = [streetNumber, route].filter(Boolean).join(" ").trim();
    const city =
      get("locality") || get("postal_town") || get("sublocality") || get("administrative_area_level_2");
    return {
      line1,
      city,
      state: get("administrative_area_level_1", true),
      postalCode: get("postal_code"),
      country: get("country", true),
    };
  }

  private async fetchJson(url: string): Promise<Record<string, unknown> & { predictions?: unknown; result?: { address_components?: unknown } }> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`places_http_${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(t);
    }
  }
}
