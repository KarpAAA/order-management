// layered · L1 · CQS
import { Module } from '@nestjs/common';

import { MEMBERSHIP_READER } from '@shared/tenancy/membership-reader';

import { IdentityFacade } from './identity.facade';
import { IdentityPolicy } from './identity.policy';
import { IdentityService } from './identity.service';
import { IdentityQueryService } from './read/identity.query.service';

@Module({
  providers: [
    // write
    IdentityService,
    IdentityPolicy,
    // read
    IdentityQueryService,
    // facade — also serves the workspace access guard through the MembershipReader port
    IdentityFacade,
    { provide: MEMBERSHIP_READER, useExisting: IdentityFacade },
  ],
  // IdentityService/QueryService are exported to identity's own transport module only.
  exports: [IdentityFacade, MEMBERSHIP_READER, IdentityService, IdentityQueryService],
})
export class IdentityModule {}
