def apply_coupon(total, code):
    if code == "HALF":
        return total / 2
    if code == "FIVEOFF":
        return total - 5
    raise ValueError("unknown coupon")
