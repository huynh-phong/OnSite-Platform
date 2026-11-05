import type { Principal } from '../../auth.js';
import type { Config } from '../../config.js';
import { decryptField } from '../../crypto.js';
import type { Db } from '../../db.js';
import type { InventoryService } from '../inventory/inventory.service.js';
import * as repo from './catalog.repository.js';

export function decryptAddress(site: repo.SiteRow, config: Config): string {
  return decryptField(
    { ciphertext: site.address_enc, nonce: site.address_nonce, tag: site.address_tag, keyId: site.key_id },
    { country: config.countryCode, table: 'sites', rowId: site.site_id, field: 'address_enc' },
    config.dataKey,
  );
}

export class CatalogService {
  constructor(
    private readonly pool: Db,
    private readonly config: Config,
    private readonly inventory: InventoryService,
  ) {}

  listStores() {
    return repo.listStores(this.pool);
  }

  /**
   * Customers see only ACTIVE products and whether the product can be supplied. Quantities per node are
   * for staff and admins. An unverified inventory view is reported as UNKNOWN rather than as stock.
   */
  async listProducts(principal: Principal, includePending: boolean) {
    const internal = principal.role !== 'customer';
    const products = await repo.listProducts(this.pool, includePending && internal);
    const [stock, freshness] = await Promise.all([this.inventory.usableStock(), this.inventory.freshness()]);
    const bySku = new Map<string, typeof stock>();
    for (const row of stock) bySku.set(row.sku_id, [...(bySku.get(row.sku_id) ?? []), row]);

    return products.map((product) => {
      const rows = bySku.get(product.sku_id) ?? [];
      const total = rows.reduce((sum, row) => sum + row.usable, 0);
      return {
        sku_id: product.sku_id,
        name: product.name,
        category: product.category,
        base_unit: product.base_unit,
        pack_size_kg: product.pack_size_verified === null ? null : Number(product.pack_size_verified),
        unit_price_sek: Number(product.unit_price),
        status: product.status,
        availability: !freshness.trusted ? 'UNKNOWN' : total > 0 ? 'AVAILABLE' : 'UNAVAILABLE',
        inventory_as_of: freshness.lastSuccessfulSyncAt?.toISOString() ?? null,
        ...(internal
          ? {
              usable_by_node: rows
                .filter((row) => row.usable > 0)
                .map((row) => ({ node_id: row.node_id, usable: row.usable })),
            }
          : {}),
      };
    });
  }

  /** A customer's own sites; admins see all. Addresses are decrypted only here, for those callers. */
  async listSites(principal: Principal) {
    const sites = await repo.listCustomerSites(this.pool, principal.role === 'customer' ? principal.customer_id : undefined);
    return sites.map((site) => ({
      site_id: site.site_id,
      customer_id: site.customer_id,
      lat: site.lat,
      lng: site.lng,
      address: decryptAddress(site, this.config),
    }));
  }
}
