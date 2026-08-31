/**
 * Admin controller for the Fulfillment v2 pack step (Migration 0042).
 *
 * Mounted at `/v1/admin/pack/*` — a deliberately separate route
 * prefix from the legacy `POST /v1/admin/orders/:id/pack` endpoint
 * (which handles the legacy PICKED → PACKED transition). The two are
 * different verbs on different lifecycles and share nothing but a name.
 *
 * Routes:
 *   GET  /v1/admin/pack/queue              — orders in PENDING_PACKING
 *   GET  /v1/admin/pack/rate-queue         — orders waiting on rate select
 *   GET  /v1/admin/pack/:id/rate-options   — cached Shippo rates for an order
 *   POST /v1/admin/pack/:id/record         — record pack dimensions
 *   POST /v1/admin/pack/:id/fetch-rates    — call Shippo, populate cache
 *   POST /v1/admin/pack/:id/select-rate    — pick a carrier, debit wallet
 *
 * RBAC — same roles as legacy admin order controller. RequiresPage
 * gates:
 *   * GETs                 → admin.orders.read
 *   * record / fetch / pick → admin.orders.write
 *
 * SECURITY
 *   * All UUID params run through ParseUUIDPipe so a malformed id
 *     never reaches the service (which would 500 on the raw-SQL cast).
 *   * All bodies validated by Zod BEFORE the service. The service
 *     re-asserts dimensional positivity as defense in depth.
 *   * The service is the sole authority on state transitions; this
 *     controller does zero business logic.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { z } from "zod";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { RequiresPage } from "../../common/decorators/requires-page.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../common/guards/jwt-auth.guard";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";

import { OrderPackService } from "./order-pack.service";

// Migration 0039 — ADMIN role reference. Prisma client hasn't been
// regenerated for the new enum value in every environment yet, so we
// cast the literal string to `Role`.
const ROLE_ADMIN = "ADMIN" as Role;

// ---------------------------------------------------------------------------
// Zod schemas — cheap first line of defence. All dimensional inputs
// must be strictly positive; upper bounds prevent an accidental
// 999_999-inch value from making it to Shippo.
// ---------------------------------------------------------------------------

const listSchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
});
type ListInput = z.infer<typeof listSchema>;

/**
 * Physical bounds for a warehouse-packed parcel:
 *  * up to 48 in on any dimension (matches Shippo's practical ceiling
 *    for the sub-90-lb rate lanes we support).
 *  * weight up to 1120 oz (70 lb) — USPS domestic parcel ceiling and
 *    also the flat-rate cap. UPS/FedEx go higher, but we don't offer
 *    freight lanes.
 * Notes cap at 500 to match the DB check constraint.
 */
const recordPackSchema = z.object({
  lengthIn: z.number().positive().max(48),
  widthIn: z.number().positive().max(48),
  heightIn: z.number().positive().max(48),
  weightOz: z.number().int().positive().max(1120),
  notes: z.string().trim().max(500).optional(),
  /**
   * Migration 0043 — optional packaging library preset. When provided,
   * the service overrides the dims with the preset's and adds its tare
   * weight to `weightOz`. Empty / undefined = ad-hoc dimensions.
   */
  packagingOptionId: z.string().uuid().optional(),
  /**
   * Migration 0049 / Phase N — optional Shippo carrier template
   * (Option A in the spec). When provided, the service validates
   * against the static registry, stores the template on the order
   * row, and passes it to Shippo at rate-fetch time to unlock
   * flat-rate / one-rate / simple-rate pricing.
   *
   * Format matches the DB CHECK: alnum + underscore, 2..60.
   */
  shippoTemplate: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{2,60}$/, "shippoTemplate must match [A-Za-z0-9_]{2,60}.")
    .optional(),
});
type RecordPackInput = z.infer<typeof recordPackSchema>;

const selectRateSchema = z.object({
  rateProviderRef: z.string().trim().min(1).max(128),
});
type SelectRateInput = z.infer<typeof selectRateSchema>;

// Admin add-on overrides sent with fetch-rates. All optional — an omitted
// field leaves the vendor's requested value untouched. Signature must be set
// at rate time so the surcharge is priced into the returned rates; insurance
// is applied later at label purchase but is persisted here too. Body is
// optional so older clients that POST fetch-rates with no body still work.
const fetchRatesSchema = z
  .object({
    insuranceRequested: z.boolean().optional(),
    signatureRequired: z.boolean().optional(),
    adultSignatureRequired: z.boolean().optional(),
    // Migration 0057 — hazmat / special-handling add-ons.
    containsAlcohol: z.boolean().optional(),
    alcoholRecipientType: z.enum(["consumer", "licensee"]).optional(),
    containsDryIce: z.boolean().optional(),
    dryIceWeightOz: z.number().int().min(0).max(100000).nullable().optional(),
    containsLithium: z.boolean().optional(),
  })
  .partial();
type FetchRatesInput = z.infer<typeof fetchRatesSchema>;

// ---------------------------------------------------------------------------

@Controller({ path: "admin/pack", version: "1" })
@Roles(Role.WAREHOUSE_OPERATOR, Role.FINANCE_ADMIN, Role.SUPER_ADMIN, ROLE_ADMIN)
@RequiresPage("admin.orders.write")
export class AdminOrderPackController {
  constructor(private readonly pack: OrderPackService) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  @Get("queue")
  @RequiresPage("admin.orders.read")
  listPackQueue(@Query(new ZodValidationPipe(listSchema)) q: ListInput) {
    return this.pack.listPackQueue({ limit: q.limit }).then((items) => ({ items }));
  }

  @Get("rate-queue")
  @RequiresPage("admin.orders.read")
  listRateQueue(@Query(new ZodValidationPipe(listSchema)) q: ListInput) {
    return this.pack.listRateQueue({ limit: q.limit }).then((items) => ({ items }));
  }

  @Get(":id/rate-options")
  @RequiresPage("admin.orders.read")
  listRateOptions(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.pack.listRateOptions(id).then((items) => ({ items }));
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  @Post(":id/record")
  @HttpCode(HttpStatus.OK)
  record(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(recordPackSchema)) body: RecordPackInput,
  ) {
    return this.pack.recordPack(id, user.sub, {
      lengthIn: body.lengthIn,
      widthIn: body.widthIn,
      heightIn: body.heightIn,
      weightOz: body.weightOz,
      notes: body.notes,
      packagingOptionId: body.packagingOptionId,
      shippoTemplate: body.shippoTemplate,
    });
  }

  /**
   * Phase P-D — post-pack edit endpoint. Same input shape as
   * /record, but callable only while the label has NOT yet been
   * bought.
   *
   * Behavior (post P-D fix): rewrites the pack columns in place and
   * drops the cached rate options so the operator must re-fetch rates
   * before picking a new one. Does NOT touch `status` — the
   * enforce_order_status_transition trigger from migration 0048
   * rejects backwards transitions (e.g. AWAITING_SHIPPING_SELECTION
   * → PACKING_COMPLETED) with ERRCODE=check_violation, which Prisma
   * surfaces as P2010. Clearing the rate cache is functionally
   * equivalent to the revert (picker sees no rates → operator
   * re-fetches) without tripping the state-machine invariant.
   */
  @Patch(":id/pack-details")
  @HttpCode(HttpStatus.OK)
  updatePackDetails(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(recordPackSchema)) body: RecordPackInput,
  ) {
    return this.pack.updatePackDetails(id, user.sub, {
      lengthIn: body.lengthIn,
      widthIn: body.widthIn,
      heightIn: body.heightIn,
      weightOz: body.weightOz,
      notes: body.notes,
      packagingOptionId: body.packagingOptionId,
      shippoTemplate: body.shippoTemplate,
    });
  }

  /**
   * Phase P-E — "Send back to pack queue". Regresses a packed-but-not-
   * yet-shipped order to PENDING_PACKING so the operator can re-pack it
   * with the full toolset on /admin/pack (packaging presets, carrier
   * templates, barcode scan) instead of the old restrictive inline
   * dims/weight editor. Callable only before the label is bought; the
   * service enforces the guard and the migration-0051 whitelist lets
   * the backwards status edge through the state-machine trigger.
   */
  @Post(":id/send-to-pack-queue")
  @HttpCode(HttpStatus.OK)
  sendToPackQueue(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
  ) {
    return this.pack.sendToPackQueue(id, user.sub);
  }

  @Post(":id/fetch-rates")
  @HttpCode(HttpStatus.OK)
  fetchRates(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(fetchRatesSchema)) body: FetchRatesInput,
  ) {
    // `body` is the admin's add-on overrides (may be empty). Persisted +
    // applied inside fetchRates so signature is priced into the rates.
    return this.pack.fetchRates(id, user.sub, body);
  }

  @Post(":id/select-rate")
  @HttpCode(HttpStatus.OK)
  selectRate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(selectRateSchema)) body: SelectRateInput,
  ) {
    return this.pack.selectRate(id, user.sub, body.rateProviderRef);
  }
}
