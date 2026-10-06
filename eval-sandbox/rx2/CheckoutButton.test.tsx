import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { CheckoutButton } from './CheckoutButton';

test('is enabled and checks out when the cart has items', () => {
  const onCheckout = jest.fn();
  render(<CheckoutButton itemCount={2} onCheckout={onCheckout} />);
  const button = screen.getByRole('button', { name: 'Checkout' });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(onCheckout).toHaveBeenCalledTimes(1);
});
