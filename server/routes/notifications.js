const express = require('express');
const router = express.Router();
const { readDB, writeDB } = require('../utils/db');

// GET all notifications
router.get('/', (req, res) => {
  const db = readDB();
  res.json({ notifications: db.notifications });
});

// POST mark notifications read
router.post('/mark-read', (req, res) => {
  const { userId } = req.body;
  const db = readDB();

  db.notifications.forEach((n) => {
    if (!userId || n.userId === userId || n.userId === 'ALL') {
      n.read = true;
    }
  });

  writeDB(db);
  res.json({ notifications: db.notifications });
});

module.exports = router;