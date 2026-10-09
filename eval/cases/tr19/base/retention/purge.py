from datetime import datetime, timedelta

RETENTION_DAYS = 90


def is_expired(created_at, now):
    return now - created_at > timedelta(days=RETENTION_DAYS)


def purge(entries, now):
    return [e for e in entries if not is_expired(e["created_at"], now)]
