import { Test } from "@nestjs/testing";

import { PaymentProcessorRegistry } from "./payment-processor.registry";
import { PaystackProcessor } from "./paystack.processor";
import { StripeConnectProcessor } from "./stripe-connect.processor";

/**
 * Regression guard for the Nest DI failure that broke the first marketplace
 * deploy: the processors' test-only optional constructor params (Stripe client /
 * secret / fetch) must be @Optional() so the container can construct them at
 * boot without trying to resolve them as providers. This resolves the exact
 * graph the way Nest does — if the @Optional() is dropped, .compile() throws.
 */
describe("Payments DI", () => {
  it("resolves the Stripe + Paystack processors and the registry", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [StripeConnectProcessor, PaystackProcessor, PaymentProcessorRegistry],
    }).compile();

    expect(moduleRef.get(StripeConnectProcessor)).toBeInstanceOf(StripeConnectProcessor);
    expect(moduleRef.get(PaystackProcessor)).toBeInstanceOf(PaystackProcessor);
    expect(moduleRef.get(PaymentProcessorRegistry)).toBeInstanceOf(PaymentProcessorRegistry);
  });
});
