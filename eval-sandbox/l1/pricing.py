TIER_DISCOUNT = {"gold": 0.15, "silver": 0.05}


def quote_total(items, tier):
    subtotal = sum(i["price"] * i["qty"] for i in items)
    rate = TIER_DISCOUNT.get(tier, 0)
    discount = round(subtotal * rate, 2)
    if subtotal > 500:
        discount += 10
    return round(subtotal - discount, 2)
