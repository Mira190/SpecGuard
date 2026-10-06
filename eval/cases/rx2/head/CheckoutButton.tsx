type CheckoutButtonProps = { itemCount: number; onCheckout: () => void };

export function CheckoutButton({ itemCount, onCheckout }: CheckoutButtonProps) {
  if (itemCount === 0) {
    return <button disabled>Cart is empty</button>;
  }
  return <button onClick={onCheckout}>Checkout</button>;
}
