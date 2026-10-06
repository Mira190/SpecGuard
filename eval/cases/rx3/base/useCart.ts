import { useState } from 'react';

export type CartItem = { id: string; name: string; price: number };

export function useCart() {
  const [items, setItems] = useState<CartItem[]>([]);
  const add = (item: CartItem) => setItems((prev) => [...prev, item]);
  const total = items.reduce((sum, item) => sum + item.price, 0);
  return { items, add, total };
}
