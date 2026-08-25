export const ORDERS_QUEUE = 'orders';
export const ORDER_JOB = 'reserve-stock';

export interface OrderJobData {
  userId: string;
  productId: string;
}
