const express = require('express');
const router = express.Router();
const { readDB, writeDB } = require('../utils/db');

// GET all auctions and global stats
router.get('/', (req, res) => {
  const db = readDB();
  res.json({
    auctions: db.auctions,
    bids: db.bids
  });
});

// POST create a new auction lot
router.post('/', (req, res) => {
  const { title, category, curator, description, imageUrl, startingPrice, minIncrement, durationMinutes } = req.body;

  if (!title || !startingPrice || !durationMinutes) {
    return res.status(400).json({ error: 'Title, starting price, and duration are required.' });
  }

  const db = readDB();
  const durationSec = Math.max(1, Number(durationMinutes)) * 60;
  const endTime = new Date(Date.now() + durationSec * 1000).toISOString();

  const newAuction = {
    id: `LOT-${800 + db.auctions.length + 1}`,
    title: title.trim(),
    category: category || 'Fine Collectibles',
    curator: curator || 'Private Vault Consignment',
    description: description || 'Authenticated collector grade lot accompanied by full provenance documentation.',
    imageUrl: imageUrl || 'https://images.unsplash.com/photo-1579783902614-a3fb3927b675?auto=format&fit=crop&w=900&q=80',
    startingPrice: Number(startingPrice),
    currentBid: Number(startingPrice),
    minIncrement: Number(minIncrement) || 2500,
    highestBidderId: null,
    highestBidderName: null,
    endTimeOffsetSec: durationSec,
    endTime,
    status: 'ACTIVE',
    bidCount: 0,
    featured: false,
    endingSoonNotified: false
  };

  db.auctions.unshift(newAuction);

  const notification = {
    id: `NTF-${Date.now()}`,
    userId: 'ALL',
    type: 'NEW_LOT',
    title: `New Lot Listed: ${newAuction.id}`,
    message: `${newAuction.title} opened for bidding at ₹${newAuction.startingPrice.toLocaleString('en-IN')}.`,
    auctionId: newAuction.id,
    read: false,
    timestamp: new Date().toISOString()
  };
  db.notifications.unshift(notification);

  writeDB(db);

  const io = req.app.get('io');
  if (io) {
    io.emit('auctionCreated', newAuction);
    io.emit('notification', notification);
  }

  res.status(201).json(newAuction);
});

// POST place a live bid on an auction lot
router.post('/:id/bid', (req, res) => {
  const { id } = req.params;
  const { userId, amount } = req.body;
  const bidAmount = Number(amount);

  const db = readDB();
  const auction = db.auctions.find((a) => a.id === id);
  if (!auction) {
    return res.status(404).json({ error: 'Auction lot not found.' });
  }

  if (auction.status !== 'ACTIVE' || new Date(auction.endTime).getTime() <= Date.now()) {
    return res.status(400).json({ error: 'This auction has already closed.' });
  }

  const user = db.users.find((u) => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: 'Bidder profile not found.' });
  }

  if (auction.highestBidderId === userId) {
    return res.status(400).json({ error: 'You are already the highest bidder on this lot!' });
  }

  const requiredMinBid = auction.bidCount === 0
    ? auction.startingPrice
    : auction.currentBid + auction.minIncrement;

  if (bidAmount < requiredMinBid) {
    return res.status(400).json({
      error: `Minimum valid bid is ₹${requiredMinBid.toLocaleString('en-IN')} ( Increment: ₹${auction.minIncrement.toLocaleString('en-IN')} )`
    });
  }

  if (user.walletBalance < bidAmount) {
    return res.status(400).json({
      error: `Insufficient available wallet balance. You need ₹${bidAmount.toLocaleString('en-IN')}, available: ₹${user.walletBalance.toLocaleString('en-IN')}.`
    });
  }

  const nowIso = new Date().toISOString();
  const previousBidderId = auction.highestBidderId;
  const previousBidAmount = auction.currentBid;

  // 1. Refund previous highest bidder's locked escrow
  let outbidNotification = null;
  if (previousBidderId) {
    const prevUser = db.users.find((u) => u.id === previousBidderId);
    if (prevUser) {
      prevUser.lockedBalance = Math.max(0, prevUser.lockedBalance - previousBidAmount);
      prevUser.walletBalance += previousBidAmount;

      db.walletTransactions.unshift({
        id: `WTX-${Date.now()}-R`,
        userId: prevUser.id,
        userName: prevUser.name,
        type: 'BID_REFUND',
        amount: previousBidAmount,
        description: `Escrow released after being outbid on ${auction.id} (${auction.title})`,
        timestamp: nowIso
      });

      outbidNotification = {
        id: `NTF-${Date.now()}-O`,
        userId: prevUser.id,
        type: 'OUTBID',
        title: `You Were Outbid on ${auction.id}!`,
        message: `${user.name} bid ₹${bidAmount.toLocaleString('en-IN')} on "${auction.title}". Your ₹${previousBidAmount.toLocaleString('en-IN')} escrow has been unlocked.`,
        auctionId: auction.id,
        read: false,
        timestamp: nowIso
      };
      db.notifications.unshift(outbidNotification);
    }
  }

  // 2. Lock new bidder's funds in escrow
  user.walletBalance -= bidAmount;
  user.lockedBalance += bidAmount;

  db.walletTransactions.unshift({
    id: `WTX-${Date.now()}-L`,
    userId: user.id,
    userName: user.name,
    type: 'BID_LOCK',
    amount: bidAmount,
    description: `Escrow hold for leading bid on ${auction.id} (${auction.title})`,
    timestamp: nowIso
  });

  // 3. Anti-Sniping Soft-Close Rule: If < 30 seconds left, extend by 30 seconds
  const remainingMs = new Date(auction.endTime).getTime() - Date.now();
  let timeExtended = false;
  if (remainingMs > 0 && remainingMs < 30000) {
    auction.endTime = new Date(Date.now() + 45000).toISOString();
    timeExtended = true;
  }

  // 4. Update Auction Lot
  auction.currentBid = bidAmount;
  auction.highestBidderId = user.id;
  auction.highestBidderName = user.name;
  auction.bidCount += 1;

  // 5. Record Bid in History
  const newBid = {
    id: `BID-${9000 + db.bids.length + 1}`,
    auctionId: auction.id,
    auctionTitle: auction.title,
    userId: user.id,
    userName: user.name,
    amount: bidAmount,
    previousBid: previousBidAmount,
    timeExtended,
    timestamp: nowIso
  };
  db.bids.unshift(newBid);

  // 6. Broadcast Global High Bid Notification
  const globalNotification = {
    id: `NTF-${Date.now()}-G`,
    userId: 'ALL',
    type: 'HIGH_BID',
    title: `New High Bid on ${auction.id}`,
    message: `${user.name} bid ₹${bidAmount.toLocaleString('en-IN')} on "${auction.title}"${timeExtended ? ' (+Anti-Snipe Time Extended!)' : ''}`,
    auctionId: auction.id,
    read: false,
    timestamp: nowIso
  };
  db.notifications.unshift(globalNotification);

  writeDB(db);

  // 7. Emit Real-Time Socket.io Events
  const io = req.app.get('io');
  if (io) {
    io.emit('bidPlaced', {
      auction,
      bid: newBid,
      users: db.users,
      walletTransactions: db.walletTransactions.slice(0, 30)
    });
    if (outbidNotification) {
      io.emit('notification', outbidNotification);
    }
    io.emit('notification', globalNotification);
  }

  res.json({
    auction,
    bid: newBid,
    users: db.users
  });
});

// POST reset/extend ended demo auctions so user can test anytime
router.post('/reset-timers', (req, res) => {
  const db = readDB();
  db.auctions.forEach((auction, index) => {
    const offsets = [180, 95, 420, 720, 1200];
    const sec = offsets[index % offsets.length];
    auction.endTime = new Date(Date.now() + sec * 1000).toISOString();
    auction.status = 'ACTIVE';
    auction.endingSoonNotified = false;
  });
  writeDB(db);

  const io = req.app.get('io');
  if (io) {
    io.emit('auctionsUpdated', db.auctions);
  }

  res.json({ auctions: db.auctions });
});

module.exports = router;