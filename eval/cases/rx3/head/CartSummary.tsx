import { useCart } from './useCart';

export function CartSummary() {
  const { items, total } = useCart();
  return <p>{items.length} items, total {total}</p>;
}
