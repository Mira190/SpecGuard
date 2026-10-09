package session

import (
	"testing"
	"time"
)

var issued = time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)

func TestFreshTokenIsValid(t *testing.T) {
	if (Token{IssuedAt: issued}).Expired(issued.Add(time.Hour)) {
		t.Fatal("token should be valid after one hour")
	}
}

func TestTokenExpiresAtTTL(t *testing.T) {
	if !(Token{IssuedAt: issued}).Expired(issued.Add(24 * time.Hour)) {
		t.Fatal("token should expire after 24 hours")
	}
}

func TestTokenValidJustBeforeTTL(t *testing.T) {
	if (Token{IssuedAt: issued}).Expired(issued.Add(24*time.Hour - time.Second)) {
		t.Fatal("token should be valid just before 24 hours")
	}
}
