import { render } from '@testing-library/react';
import { CartSummary } from './CartSummary';
import { useCart } from './useCart';

jest.mock('./useCart');

test('reads the cart', () => {
  (useCart as jest.Mock).mockReturnValue({ items: [], total: 0 });
  render(<CartSummary />);
  expect(useCart).toHaveBeenCalled();
});
