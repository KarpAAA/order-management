// URI versioning: every route lives under /v1 (configureApi → enableVersioning).
export const V1 = '/v1';

export const workspacePath = (workspaceId: string): string => `${V1}/workspaces/${workspaceId}`;
export const ordersPath = (workspaceId: string): string => `${workspacePath(workspaceId)}/orders`;
export const orderPath = (workspaceId: string, orderId: string): string =>
  `${ordersPath(workspaceId)}/${orderId}`;
export const productsPath = (workspaceId: string): string =>
  `${workspacePath(workspaceId)}/products`;
export const productPath = (workspaceId: string, productId: string): string =>
  `${productsPath(workspaceId)}/${productId}`;
