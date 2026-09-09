/**
 * PaymentProcessorRegistry — resolves a ProcessorKey to its implementation,
 * so callers (checkout, webhooks) depend on the abstraction and never on a
 * concrete processor. Adding a rail = register it here; callers don't change.
 */
import { BadRequestException, Injectable } from "@nestjs/common";

import {
  PaymentProcessor,
  type ProcessorKey,
} from "./payment-processor.interface";
import { PaystackProcessor } from "./paystack.processor";
import { StripeConnectProcessor } from "./stripe-connect.processor";

@Injectable()
export class PaymentProcessorRegistry {
  private readonly byKey: Record<ProcessorKey, PaymentProcessor>;

  constructor(
    stripe: StripeConnectProcessor,
    paystack: PaystackProcessor,
  ) {
    this.byKey = { STRIPE: stripe, PAYSTACK: paystack };
  }

  get(key: ProcessorKey): PaymentProcessor {
    const p = this.byKey[key];
    if (!p) {
      throw new BadRequestException({
        message: "Unsupported payment processor.",
        code: "unsupported_processor",
      });
    }
    return p;
  }

  /** Processors whose credentials are configured in this environment. */
  configuredKeys(): ProcessorKey[] {
    return (Object.keys(this.byKey) as ProcessorKey[]).filter((k) =>
      this.byKey[k].isConfigured(),
    );
  }
}
