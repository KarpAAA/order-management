import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { ErrorResponseDto, ValidationFieldErrorDto } from '../dto/error-response.dto';

import type { INestApplication } from '@nestjs/common';

/** UI at `/docs`, JSON at `/docs-json`. Step 1 fuzzes the API against this document. */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Order Management API')
    .setDescription(
      'Multi-tenant order management. Every workspace route is under `/v1/workspaces/{workspaceId}`; ' +
        'a caller who is not a member of that workspace always gets 404.',
    )
    .setVersion('0.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    operationIdFactory: (_controllerKey, methodKey) => methodKey,
    extraModels: [ErrorResponseDto, ValidationFieldErrorDto],
  });
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs-json' });
}
