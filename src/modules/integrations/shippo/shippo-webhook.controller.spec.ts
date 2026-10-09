/**
 * Shippo webhook — reserved-stock release on first ship-out.
 *
 * v2 platform-ship orders pack before buying the label and never reach the
 * admin `ship()` path, so the carrier tracking webhook is where their reserved
 * units must be released. These tests pin that behaviour and its idempotency.
 */

import { ShippoWebhookController } from "./shippo-webhook.controller";

type AnyFn = jest.Mock;

interface TxMock {
  order: { update: AnyFn };
  orderEvent: { create: AnyFn };
  orderLine: { findMany: AnyFn; update: AnyFn };
  sku: { update: AnyFn };
  inventoryMovement: { create: AnyFn };
}

function makeTx(openLines: Array<{ id: string; skuId: string; vendorId: string; quantity: number }>): TxMock {
  return {
    order: { update: jest.fn().mockResolvedValue({}) },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    orderLine: {
      findMany: jest.fn().mockResolvedValue(openLines),
      update: jest.fn().mockResolvedValue({}),
    },
    sku: { update: jest.fn().mockResolvedValue({}) },
    inventoryMovement: { create: jest.fn().mockResolvedValue({}) },
  };
}

function makeController(opts: {
  order: Record<string, unknown>;
  tx: TxMock;
}) {
  const prisma = {
    webhookEvent: {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({}),
    },
    order: { findFirst: jest.fn().mockResolvedValue(opts.order) },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (cb: (tx: TxMock) => Promise<unknown>) => cb(opts.tx)),
  };
  const shippo = {
    verifyWebhookSecret: jest.fn().mockReturnValue(true),
    getTracker: jest.fn().mockResolvedValue(null), // stub mode → fall back to payload
    isLive: jest.fn().mockReturnValue(false),
  };
  const notifications = { emit: jest.fn().mockResolvedValue(undefined) };

  const controller = new ShippoWebhookController(
    shippo as never,
    prisma as never,
    notifications as never,
  );
  return { controller, prisma, shippo, tx: opts.tx };
}

function payload(status: string, trackingNumber = "1Z-TEST") {
  return {
    event: "track_updated",
    data: {
      object_id: `trk_${status}`,
      carrier: "ups",
      tracking_number: trackingNumber,
      tracking_status: { status, status_date: `2026-10-09T00:00:00Z` },
    },
  };
}

describe("ShippoWebhookController — reserved release", () => {
  it("releases reserved stock when a LABEL_PURCHASED order first goes in transit", async () => {
    const tx = makeTx([
      { id: "l1", skuId: "SKU1", vendorId: "v1", quantity: 3 },
    ]);
    const { controller } = makeController({
      order: { id: "o1", status: "LABEL_PURCHASED", shippedAt: null, vendorId: "v1" },
      tx,
    });

    await controller.receive("secret", payload("transit") as never);

    expect(tx.sku.update).toHaveBeenCalledWith({
      where: { id: "SKU1" },
      data: { quantityReserved: { decrement: 3 } },
    });
    expect(tx.inventoryMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "SHIP", deltaReserved: -3, skuId: "SKU1" }),
      }),
    );
    expect(tx.orderLine.update).toHaveBeenCalledWith({
      where: { id: "l1" },
      data: { allocationStatus: "SHIPPED" },
    });
  });

  it("does not decrement again when lines are already shipped (delivered replay)", async () => {
    // No open lines left — everything already marked SHIPPED on the transit event.
    const tx = makeTx([]);
    const { controller } = makeController({
      order: { id: "o1", status: "IN_TRANSIT", shippedAt: new Date(), vendorId: "v1" },
      tx,
    });

    await controller.receive("secret", payload("delivered") as never);

    expect(tx.sku.update).not.toHaveBeenCalled();
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });
});
