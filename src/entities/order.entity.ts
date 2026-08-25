import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('orders')
// Hard database guarantee that one user cannot hold two reservations for the
// same product, no matter how the Redis and queue layers behave.
@Unique('uq_orders_user_product', ['userId', 'productId'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'user_id', type: 'varchar', length: 64 })
  userId: string;

  @Index()
  @Column({ name: 'product_id', type: 'varchar', length: 32 })
  productId: string;

  @Column({ type: 'int', default: 1 })
  quantity: number;

  @Column({ type: 'varchar', length: 32, default: 'CONFIRMED' })
  status: string;

  @Column({ name: 'job_id', type: 'varchar', length: 64, nullable: true })
  jobId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
