const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { readDB, writeDB } = require('./utils/db');

const auctionRoutes = require('./routes/auctions');
const walletRoutes = require('./routes/wallet');
const notificationRoutes = require('./routes/notifications');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.set('io', io);
app.use(cors());
app.use(express.json());

// Initialize fresh demo endTimes on server boot so countdowns are always active
function initializeAuctionTimers() {
  const db = readDB();
  let updated = false;

  db.auctions.forEach((auction) => {
    const endMs = auction.endTime ? new Date(auction.endTime).getTime() : 0;
    if (!auction.endTime || endMs <= Date.now() || auction.status === 'ENDED') {
      const offset = auction.endTimeOffsetSec || 300;
      auction.endTime = new Date(Date.now() + offset * 1000).toISOString();
      auction.status = 'ACTIVE';
      auction.endingSoonNotified = false;
      updated = true;
    }
  });

  if (updated) {
    writeDB(db);
  }
}

initializeAuctionTimers();

// Mount REST Routes
app.use('/api/auctions', auctionRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/notifications', notificationRoutes);

// Real-Time Auction Lifecycle Engine (Checks countdowns every 1 second)
setInterval(() => {
  const db = readDB();
  let changed = false;
  const now = Date.now();

  db.auctions.forEach((auction) => {
    if (auction.status !== 'ACTIVE') return;

    const remainingMs = new Date(auction.endTime).getTime() - now;

    // 1. Trigger "Ending Soon (< 60s)" urgency notification once per lot
    if (remainingMs > 0 && remainingMs <= 60000 && !auction.endingSoonNotified) {
      auction.endingSoonNotified = true;
      changed = true;

      const urgentNote = {
        id: `NTF-${Date.now()}-${auction.id}`,
        userId: 'ALL',
        type: 'ENDING_SOON',
        title: `Final 60 Seconds: ${auction.id}`,
        message: `"${auction.title}" is about to close! Current bid: ₹${auction.currentBid.toLocaleString('en-IN')}.`,
        auctionId: auction.id,
        read: false,
        timestamp: new Date().toISOString()
      };
      db.notifications.unshift(urgentNote);
      io.emit('notification', urgentNote);
    }

    // 2. Settle auction when countdown hits zero
    if (remainingMs <= 0) {
      auction.status = 'ENDED';
      changed = true;

      if (auction.highestBidderId) {
        const winner = db.users.find((u) => u.id === auction.highestBidderId);
        if (winner) {
          winner.lockedBalance = Math.max(0, winner.lockedBalance - auction.currentBid);
          db.walletTransactions.unshift({
            id: `WTX-${Date.now()}-WIN`,
            userId: winner.id,
            userName: winner.name,
            type: 'AUCTION_SETTLED',
            amount: auction.currentBid,
            description: `Final settlement for winning ${auction.id} (${auction.title})`,
            timestamp: new Date().toISOString()
          });
        }

        const winNote = {
          id: `NTF-${Date.now()}-WIN`,
          userId: auction.highestBidderId,
          type: 'AUCTION_WON',
          title: `Gavel Down! Lot ${auction.id} Sold`,
          message: `${auction.highestBidderName} won "${auction.title}" for ₹${auction.currentBid.toLocaleString('en-IN')}!`,
          auctionId: auction.id,
          read: false,
          timestamp: new Date().toISOString()
        };
        db.notifications.unshift(winNote);
        io.emit('notification', winNote);
      } else {
        const unsoldNote = {
          id: `NTF-${Date.now()}-EXP`,
          userId: 'ALL',
          type: 'AUCTION_ENDED',
          title: `Lot ${auction.id} Closed Unsold`,
          message: `"${auction.title}" reached time limit with no reserve bids.`,
          auctionId: auction.id,
          read: false,
          timestamp: new Date().toISOString()
        };
        db.notifications.unshift(unsoldNote);
        io.emit('notification', unsoldNote);
      }

      io.emit('auctionEnded', {
        auction,
        users: db.users,
        walletTransactions: db.walletTransactions.slice(0, 30)
      });
    }
  });

  if (changed) {
    writeDB(db);
  }
}, 1000);

io.on('connection', (socket) => {
  console.log(`⚡ Bidder connected to Live Floor: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`Bidder disconnected: ${socket.id}`);
  });
});

const PORT = 5000;
server.listen(PORT, () => {
  console.log(`🏛️ VELOCE Live Auction Server running on http://localhost:${PORT}`);
});