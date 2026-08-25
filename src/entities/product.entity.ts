import { Column, Entity, PrimaryColumn, VersionColumn } from 'typeorm';

// numeric/bigint come back from pg as strings; keep the API contract numeric.
const numeric = {
  to: (v: number) => v,
  from: (v: string | null) => (v === null ? null : Number(v)),
};

@Entity('products')
export class Product {
  @PrimaryColumn({ name: 'product_id', type: 'varchar', length: 32 })
  productId: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ type: 'numeric', precision: 12, scale: 2, transformer: numeric })
  price: number;

  @Column({ name: 'available_stock', type: 'int' })
  availableStock: number;

  @Column({ name: 'remaining_stock', type: 'int' })
  remainingStock: number;

  @Column({ name: 'is_flash_sale_active', type: 'boolean', default: false })
  isFlashSaleActive: boolean;

  // Enables optimistic locking as a second line of defence; the worker's
  // conditional UPDATE is what actually keeps stock from going negative.
  @VersionColumn()
  version: number;
}
