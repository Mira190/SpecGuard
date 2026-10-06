type PriceTagProps = { price: number; discountPercent?: number; currency?: string };

export function PriceTag({ price, discountPercent = 0, currency = 'USD' }: PriceTagProps) {
  const discounted = Math.round(price * (1 - discountPercent / 100) * 100) / 100;
  const format = new Intl.NumberFormat('en-US', { style: 'currency', currency });

  if (discountPercent <= 0) {
    return <span>{format.format(price)}</span>;
  }
  return (
    <span>
      <s>{format.format(price)}</s> <strong>{format.format(discounted)}</strong>
    </span>
  );
}
