import { DocumentBuilder, getSchemaPath, SwaggerModule } from '@nestjs/swagger';

import { ErrorResponseDto, ValidationFieldErrorDto } from '../dto/error-response.dto';

import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';

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
  forbidUnknownBodyFields(document);
  documentBodyLimit(document);
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs-json' });
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null;

/**
 * The ValidationPipe runs with `forbidNonWhitelisted`: an unknown body field is a 400. Say so
 * in the document: `additionalProperties: false` on every object schema a request body
 * reaches, nested DTOs included.
 */
function forbidUnknownBodyFields(document: OpenAPIObject): void {
  const components: JsonObject = document.components?.schemas ?? {};
  const visited = new Set<string>();

  const visit = (schema: unknown): void => {
    if (Array.isArray(schema)) {
      schema.forEach(visit);
      return;
    }
    if (!isObject(schema)) return;
    if (typeof schema.$ref === 'string') {
      const name = schema.$ref.slice(schema.$ref.lastIndexOf('/') + 1);
      if (visited.has(name)) return;
      visited.add(name);
      visit(components[name]);
      return;
    }
    if (isObject(schema.properties)) {
      schema.additionalProperties = false;
      Object.values(schema.properties).forEach(visit);
    }
    for (const key of ['items', 'allOf', 'oneOf', 'anyOf']) visit(schema[key]);
  };

  for (const operation of operationsWithBody(document)) {
    const { content } = operation.requestBody as JsonObject;
    if (!isObject(content)) continue;
    for (const media of Object.values(content)) if (isObject(media)) visit(media.schema);
  }
}

/** The JSON body parser has a size limit (configure-api.ts): every body can be a 413. */
function documentBodyLimit(document: OpenAPIObject): void {
  for (const operation of operationsWithBody(document)) {
    const responses = isObject(operation.responses) ? operation.responses : {};
    responses['413'] = {
      description: 'Request body over the size limit (`PAYLOAD_TOO_LARGE`)',
      content: { 'application/json': { schema: { $ref: getSchemaPath(ErrorResponseDto) } } },
    };
    operation.responses = responses;
  }
}

function operationsWithBody(document: OpenAPIObject): JsonObject[] {
  return Object.values(document.paths)
    .flatMap((pathItem) => Object.values(pathItem as JsonObject))
    .filter(
      (operation): operation is JsonObject =>
        isObject(operation) && isObject(operation.requestBody),
    );
}
