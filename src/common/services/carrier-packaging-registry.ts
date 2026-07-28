/**
 * CarrierPackagingRegistry — static list of Shippo's built-in parcel
 * templates that the warehouse can select at pack time (Option A in
 * the Fulfillment v2 spec, page 5).
 *
 * These are NOT stored in the database because Shippo owns the truth
 * about what templates exist and what their canonical dimensions are.
 * If a template's dims ever change, Shippo will change them on their
 * side and we update this file to match. No admin can add or edit
 * these; they are code-controlled.
 *
 * Custom preset packaging that the admin creates lives in
 * `packaging_options` (migration 0043) and is edited via
 * PackagingLibraryService — that IS admin-editable.
 *
 * When an operator picks a carrier template at pack time, the
 * `template` id is passed to Shippo's rate request as
 * `parcel.template`, which unlocks flat-rate / one-rate / simple-rate
 * pricing for that carrier. Without the template, Shippo prices the
 * parcel by weight.
 *
 * SRP: this file has ONE job — expose the static list. It does not
 * touch the DB, does not compute rates, and does not interact with
 * Shippo directly (the shippo service reads from it if it needs to).
 *
 * OCP: adding a new template requires a code deploy (one entry
 * added). Removing one is safe because the pack UI queries this list
 * every time — a removed entry just disappears from the picker.
 */

import { Injectable } from "@nestjs/common";

export type PackagingTypeLabel = "POLY_MAILER" | "BOX";

export interface CarrierPackagingEntry {
  /** Which carrier this template is for. Drives grouping in the picker. */
  carrier: "USPS" | "UPS" | "FEDEX";
  /**
   * The exact Shippo template id. Case-sensitive. Passed verbatim to
   * `parcel.template` on the Shippo rate request.
   */
  template: string;
  /** Human-readable label for the picker. */
  label: string;
  /** Canonical dimensions (inches). Auto-populated on the pack form. */
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  /** POLY_MAILER for envelopes / paks; BOX for everything else. */
  packagingType: PackagingTypeLabel;
  /**
   * Empty-container weight added to the operator's goods weight before
   * the rate is fetched. Small (a few ounces) for most templates; may
   * matter for weight-cap eligibility on the Shippo side.
   */
  tareWeightOz: number;
}

/**
 * The full list. Order defines the display order in the picker within
 * each carrier group.
 *
 * Dimensions here are the OUTSIDE dims Shippo expects on the wire.
 * Weight limits are enforced by Shippo (70 lb for USPS flat rate;
 * 50 lb for USPS Priority Mail Padded Envelope; carrier-specific for
 * UPS Simple Rate + FedEx One Rate) — we don't duplicate them here.
 */
export const CARRIER_PACKAGING_REGISTRY: ReadonlyArray<CarrierPackagingEntry> =
  [
    // ---- USPS ----------------------------------------------------------
    {
      carrier: "USPS",
      template: "USPS_FlatRateEnvelope",
      label: "USPS Flat Rate Envelope",
      lengthIn: 12.5,
      widthIn: 9.5,
      heightIn: 0.75,
      packagingType: "POLY_MAILER",
      tareWeightOz: 1,
    },
    {
      carrier: "USPS",
      template: "USPS_PaddedFlatRateEnvelope",
      label: "USPS Padded Flat Rate Envelope",
      lengthIn: 12.5,
      widthIn: 9.5,
      heightIn: 1,
      packagingType: "POLY_MAILER",
      tareWeightOz: 2,
    },
    {
      carrier: "USPS",
      template: "USPS_SmallFlatRateBox",
      label: "USPS Small Flat Rate Box",
      lengthIn: 8.625,
      widthIn: 5.375,
      heightIn: 1.625,
      packagingType: "BOX",
      tareWeightOz: 4,
    },
    {
      carrier: "USPS",
      template: "USPS_MediumFlatRateBox1",
      label: "USPS Medium Flat Rate Box",
      lengthIn: 11,
      widthIn: 8.5,
      heightIn: 5.5,
      packagingType: "BOX",
      tareWeightOz: 8,
    },
    {
      carrier: "USPS",
      template: "USPS_LargeFlatRateBox",
      label: "USPS Large Flat Rate Box",
      lengthIn: 12,
      widthIn: 12,
      heightIn: 5.5,
      packagingType: "BOX",
      tareWeightOz: 16,
    },

    // ---- UPS Simple Rate ----------------------------------------------
    // Shippo template ids for UPS Simple Rate; interior dims per UPS spec.
    {
      carrier: "UPS",
      template: "UPS_ExpressBox_XSmall_Simple",
      label: "UPS Simple Rate — XS",
      lengthIn: 13,
      widthIn: 11,
      heightIn: 2,
      packagingType: "BOX",
      tareWeightOz: 4,
    },
    {
      carrier: "UPS",
      template: "UPS_ExpressBox_Small_Simple",
      label: "UPS Simple Rate — Small",
      lengthIn: 13,
      widthIn: 11,
      heightIn: 2,
      packagingType: "BOX",
      tareWeightOz: 6,
    },
    {
      carrier: "UPS",
      template: "UPS_ExpressBox_Medium_Simple",
      label: "UPS Simple Rate — Medium",
      lengthIn: 15,
      widthIn: 11,
      heightIn: 3,
      packagingType: "BOX",
      tareWeightOz: 10,
    },
    {
      carrier: "UPS",
      template: "UPS_ExpressBox_Large_Simple",
      label: "UPS Simple Rate — Large",
      lengthIn: 18,
      widthIn: 13,
      heightIn: 3,
      packagingType: "BOX",
      tareWeightOz: 14,
    },
    {
      carrier: "UPS",
      template: "UPS_ExpressBox_XLarge_Simple",
      label: "UPS Simple Rate — XL",
      lengthIn: 24,
      widthIn: 18,
      heightIn: 6,
      packagingType: "BOX",
      tareWeightOz: 24,
    },

    // ---- FedEx One Rate -----------------------------------------------
    {
      carrier: "FEDEX",
      template: "FedEx_Envelope",
      label: "FedEx One Rate — Envelope",
      lengthIn: 12.5,
      widthIn: 9.5,
      heightIn: 0.5,
      packagingType: "POLY_MAILER",
      tareWeightOz: 1,
    },
    {
      carrier: "FEDEX",
      template: "FedEx_Pak_1",
      label: "FedEx One Rate — Pak",
      lengthIn: 15.5,
      widthIn: 12,
      heightIn: 1,
      packagingType: "POLY_MAILER",
      tareWeightOz: 2,
    },
    {
      carrier: "FEDEX",
      template: "FedEx_Box_Small_1",
      label: "FedEx One Rate — Small Box",
      lengthIn: 10.875,
      widthIn: 1.5,
      heightIn: 12.375,
      packagingType: "BOX",
      tareWeightOz: 6,
    },
    {
      carrier: "FEDEX",
      template: "FedEx_Box_Medium_1",
      label: "FedEx One Rate — Medium Box",
      lengthIn: 11.5,
      widthIn: 2.375,
      heightIn: 13.25,
      packagingType: "BOX",
      tareWeightOz: 10,
    },
    {
      carrier: "FEDEX",
      template: "FedEx_Box_Large_1",
      label: "FedEx One Rate — Large Box",
      lengthIn: 12.375,
      widthIn: 3,
      heightIn: 17.875,
      packagingType: "BOX",
      tareWeightOz: 14,
    },
    {
      carrier: "FEDEX",
      template: "FedEx_Box_Extra_Large_1",
      label: "FedEx One Rate — XL Box",
      lengthIn: 11.875,
      widthIn: 10.75,
      heightIn: 11,
      packagingType: "BOX",
      tareWeightOz: 20,
    },
    {
      carrier: "FEDEX",
      template: "FedEx_Tube",
      label: "FedEx One Rate — Tube",
      lengthIn: 38,
      widthIn: 6,
      heightIn: 6,
      packagingType: "BOX",
      tareWeightOz: 12,
    },
  ] as const;

/**
 * Set of every template id known to the registry. Callers use this to
 * validate a client-supplied template value before passing it to
 * Shippo — an unrecognised template gets rejected as invalid input
 * rather than as a Shippo API error later.
 */
export const KNOWN_CARRIER_TEMPLATES: ReadonlySet<string> = new Set(
  CARRIER_PACKAGING_REGISTRY.map((e) => e.template),
);

@Injectable()
export class CarrierPackagingRegistryService {
  /** Return all entries. UI groups them by `carrier`. */
  list(): ReadonlyArray<CarrierPackagingEntry> {
    return CARRIER_PACKAGING_REGISTRY;
  }

  /**
   * Resolve a template id → entry. Returns undefined for anything not
   * in the registry (custom / library-preset templates are stored in
   * the packaging_options.shippo_template column and are looked up
   * there separately).
   */
  getByTemplate(template: string): CarrierPackagingEntry | undefined {
    return CARRIER_PACKAGING_REGISTRY.find((e) => e.template === template);
  }

  /**
   * Cheap validator for controllers / DTOs. True if the string matches
   * one of the KNOWN_CARRIER_TEMPLATES; false otherwise. Case-sensitive.
   */
  isKnown(template: string): boolean {
    return KNOWN_CARRIER_TEMPLATES.has(template);
  }
}
