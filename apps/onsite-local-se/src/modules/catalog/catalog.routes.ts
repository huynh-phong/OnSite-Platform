import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { principalOf, requireRole, type AuthOptions } from '../../auth.js';
import { bearer, errors, Nullable, Timestamp } from '../routes-common.js';
import type { CatalogService } from './catalog.service.js';

export function registerCatalogRoutes(app: FastifyInstance, auth: AuthOptions, catalog: CatalogService): void {
  app.get(
    '/api/v1/stores',
    {
      onRequest: requireRole(auth),
      schema: {
        tags: ['catalog'],
        security: bearer,
        summary: 'The 10 stores and the hub',
        response: {
          200: Type.Array(
            Type.Object({
              store_id: Type.String(),
              name: Type.String(),
              type: Type.String(),
              lat: Type.Number(),
              lng: Type.Number(),
              prep_minutes: Type.Integer(),
              status: Type.String(),
            }),
          ),
          ...errors(401),
        },
      },
    },
    async () => catalog.listStores(),
  );

  app.get<{ Querystring: { include_pending?: boolean } }>(
    '/api/v1/products',
    {
      onRequest: requireRole(auth),
      schema: {
        tags: ['catalog'],
        security: bearer,
        summary: 'ACTIVE products with availability. Staff and admins also get usable stock per node.',
        querystring: Type.Object({
          include_pending: Type.Optional(
            Type.Boolean({ description: 'Staff and admins only: also list products awaiting normalization' }),
          ),
        }),
        response: {
          200: Type.Array(
            Type.Object({
              sku_id: Type.String(),
              name: Type.String(),
              category: Nullable(Type.String()),
              base_unit: Nullable(Type.String()),
              pack_size_kg: Nullable(Type.Number()),
              unit_price_sek: Type.Number(),
              status: Type.String(),
              availability: Type.Union([Type.Literal('AVAILABLE'), Type.Literal('UNAVAILABLE'), Type.Literal('UNKNOWN')]),
              inventory_as_of: Nullable(Timestamp),
              usable_by_node: Type.Optional(
                Type.Array(Type.Object({ node_id: Type.String(), usable: Type.Integer() })),
              ),
            }),
          ),
          ...errors(401),
        },
      },
    },
    async (request) => catalog.listProducts(principalOf(request), request.query.include_pending ?? false),
  );

  app.get(
    '/api/v1/sites',
    {
      onRequest: requireRole(auth, 'customer', 'admin'),
      schema: {
        tags: ['catalog'],
        security: bearer,
        summary: "The customer's construction sites, for placing an order",
        response: {
          200: Type.Array(
            Type.Object({
              site_id: Type.String(),
              customer_id: Type.String(),
              lat: Type.Number(),
              lng: Type.Number(),
              address: Type.String(),
            }),
          ),
          ...errors(401, 403),
        },
      },
    },
    async (request) => catalog.listSites(principalOf(request)),
  );
}
