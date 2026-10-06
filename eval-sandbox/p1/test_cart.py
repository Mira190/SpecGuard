import pytest

from cart import apply_coupon


def test_half_coupon_halves_total():
    assert apply_coupon(80, "HALF") == 40


def test_unknown_coupon_is_rejected():
    with pytest.raises(ValueError, match="unknown coupon"):
        apply_coupon(80, "NOPE")
