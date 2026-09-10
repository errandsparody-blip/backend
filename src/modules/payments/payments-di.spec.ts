import { Test } from "@nestjs/testing";

import { FlutterwaveProcessor } from "./flutterwave.processor";
import { PaymentProcessorRegistry } from "./payment-processor.registry";
import { StripeConnectProcessor } from "./stripe-connect.processor";

/**
 * Regression guard for the Nest DI failure that broke the first marketplace
 * deploy: the processors' test-only optional constructor params (Stripe client /
 * secret / fetch) must be @Optional() so the container can construct them at
 * boot without trying to resolve them as providers. This resolves the exact
 * graph the way Nest does — if the @Optional() is dropped, .compile() throws.
 */
describe("Payments DI", () => {
  it("resolves the Stripe + Flutterwave processors and the registry", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [StripeConnectProcessor, FlutterwaveProcessor, PaymentProcessorRegistry],
    }).compile();

    expect(moduleRef.get(StripeConnectProcessor)).toBeInstanceOf(StripeConnectProcessor);
    expect(moduleRef.get(FlutterwaveProcessor)).toBeInstanceOf(FlutterwaveProcessor);
    expect(moduleRef.get(PaymentProcessorRegistry)).toBeInstanceOf(PaymentProcessorRegistry);
  });
});
