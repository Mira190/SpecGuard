package session

import "time"

const TokenTTLHours = 24

type Token struct {
	IssuedAt time.Time
}

func (t Token) Expired(now time.Time) bool {
	return now.Sub(t.IssuedAt) >= TokenTTLHours*time.Hour
}
