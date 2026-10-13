import { render, screen } from '@testing-library/react';
import { PriceTag } from './PriceTag';

test('shows the plain price without a discount', () => {
  render(<PriceTag price={100} />);
  expect(screen.getByText('$100.00')).toBeTruthy();
});

test('shows the original and the discounted price', () => {
  render(<PriceTag price={100} discountPercent={20} />);
  expect(screen.getByText('$100.00')).toBeTruthy();
  expect(screen.getByText('$80.00')).toBeTruthy();
});

test('rounds the discounted price to cents', () => {
  render(<PriceTag price={19.99} discountPercent={15} />);
  expect(screen.getByText('$16.99')).toBeTruthy();
});

test('formats other currencies', () => {
  render(<PriceTag price={50} discountPercent={10} currency="EUR" />);
  expect(screen.getByText('€45.00')).toBeTruthy();
});
