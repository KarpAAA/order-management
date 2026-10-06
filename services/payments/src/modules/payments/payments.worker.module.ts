// transport · worker
import { Module } from '@nestjs/common';

import { PaymentsConsumer } from './payments.consumer';
import { PaymentsModule } from './payments.module';

@Module({
  imports: [PaymentsModule],
  providers: [PaymentsConsumer],
})
export class PaymentsWorkerModule {}
