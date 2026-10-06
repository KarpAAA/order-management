// layered · L1 · together
import { Module } from '@nestjs/common';

import { gatewayConfig } from '@config/configuration';
import type { GatewayConfig } from '@config/configuration';

import { ChargePaymentService } from './charge-payment.service';
import { FakePaymentGateway } from './infrastructure/fake-payment-gateway.adapter';
import { HttpPaymentGateway } from './infrastructure/http-payment-gateway.adapter';
import { RabbitPaymentEventsPublisher } from './infrastructure/rabbit-payment-events.adapter';
import { PaymentsPolicy } from './payments.policy';
import { PAYMENT_EVENTS_PUBLISHER } from './ports/payment-events-publisher.port';
import { PAYMENT_GATEWAY } from './ports/payment-gateway.port';

@Module({
  providers: [
    // write
    ChargePaymentService,
    PaymentsPolicy,
    {
      provide: PAYMENT_GATEWAY,
      inject: [gatewayConfig.KEY, HttpPaymentGateway, FakePaymentGateway],
      useFactory: (config: GatewayConfig, http: HttpPaymentGateway, fake: FakePaymentGateway) =>
        config.gateway === 'http' ? http : fake,
    },
    HttpPaymentGateway,
    FakePaymentGateway,
    { provide: PAYMENT_EVENTS_PUBLISHER, useClass: RabbitPaymentEventsPublisher },
  ],
  // No facade: no other module exists. The use case is exported to the module's own transport
  // module only (Nest needs it exported to inject it into the consumer).
  exports: [ChargePaymentService],
})
export class PaymentsModule {}
