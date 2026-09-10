import { Module } from "@nestjs/common";

import { FlutterwaveProcessor } from "./flutterwave.processor";
import { PaymentProcessorRegistry } from "./payment-processor.registry";
import { PayoutAccountController } from "./payout-account.controller";
import { PayoutAccountService } from "./payout-account.service";
import { StripeConnectProcessor } from "./stripe-connect.processor";

// PrismaModule is @Global. The processors are self-contained (they read their
// own credentials from the environment). The registry + payout service are
// exported so the checkout (Layer 5) and webhook (Layer 6) modules can use them.
@Module({
  controllers: [PayoutAccountController],
  providers: [
    StripeConnectProcessor,
    FlutterwaveProcessor,
    PaymentProcessorRegistry,
    PayoutAccountService,
  ],
  exports: [
    StripeConnectProcessor,
    FlutterwaveProcessor,
    PaymentProcessorRegistry,
    PayoutAccountService,
  ],
})
export class PaymentsModule {}
