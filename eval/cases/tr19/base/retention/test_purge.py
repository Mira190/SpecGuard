import unittest
from datetime import datetime, timedelta

from purge import RETENTION_DAYS, is_expired, purge

NOW = datetime(2025, 6, 1)


class PurgeTest(unittest.TestCase):
    def test_retention_period(self):
        self.assertEqual(RETENTION_DAYS, 90)

    def test_recent_entry_kept(self):
        self.assertFalse(is_expired(NOW - timedelta(days=10), NOW))

    def test_old_entry_expired(self):
        self.assertTrue(is_expired(NOW - timedelta(days=91), NOW))

    def test_purge_drops_expired(self):
        entries = [{"created_at": NOW - timedelta(days=200)}, {"created_at": NOW}]
        self.assertEqual(len(purge(entries, NOW)), 1)


if __name__ == "__main__":
    unittest.main()
