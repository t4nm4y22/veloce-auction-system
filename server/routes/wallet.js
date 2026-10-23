const express = require('express');
const router = express.Router();
const { readDB, writeDB } = require('../utils/db');

// GET all users and wallet ledger
router.get('/', (req, res) => {
  const db = readDB();
  res.json({
    users: db.users,
    walletTransactions: db.walletTransactions
  });
});

// POST top-up or withdraw funds from user wallet
router.post('/transaction', (req, res) => {
  const { userId, type, amount, note } = req.body;
  const numAmount = Number(amount);

  if (!userId || !numAmount || numAmount <= 0) {
    return res.status(400).json({ error: 'Valid user and positive amount are required.' });
  }

  const db = readDB();
  const user = db.users.find((u) => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found.' });
  }

  if (type === 'WITHDRAW' && user.walletBalance < numAmount) {
    return res.status(400).json({ error: 'Insufficient available balance for withdrawal (Escrow funds cannot be withdrawn while leading a bid).' });
  }

  if (type === 'WITHDRAW') {
    user.walletBalance -= numAmount;
  } else {
    user.walletBalance += numAmount;
  }

  const tx = {
    id: `WTX-${Date.now()}`,
    userId: user.id,
    userName: user.name,
    type: type === 'WITHDRAW' ? 'WITHDRAW' : 'DEPOSIT',
    amount: numAmount,
    description: note || (type === 'WITHDRAW' ? 'Vault Wire Withdrawal' : 'Instant Treasury Top-Up'),
    timestamp: new Date().toISOString()
  };

  db.walletTransactions.unshift(tx);

  const notification = {
    id: `NTF-${Date.now()}`,
    userId: user.id,
    type: 'WALLET',
    title: type === 'WITHDRAW' ? 'Vault Withdrawal Processed' : 'Wallet Funded Successfully',
    message: `₹${numAmount.toLocaleString('en-IN')} ${type === 'WITHDRAW' ? 'withdrawn from' : 'credited to'} ${user.name}'s bidding wallet.`,
    auctionId: null,
    read: false,
    timestamp: new Date().toISOString()
  };
  db.notifications.unshift(notification);

  writeDB(db);

  const io = req.app.get('io');
  if (io) {
    io.emit('walletUpdated', {
      users: db.users,
      walletTransactions: db.walletTransactions.slice(0, 30)
    });
    io.emit('notification', notification);
  }

  res.json({
    user,
    users: db.users,
    transaction: tx,
    walletTransactions: db.walletTransactions
  });
});

module.exports = router;