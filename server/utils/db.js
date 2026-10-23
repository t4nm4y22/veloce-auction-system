const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

// Helper to read JSON database safely
function readDB() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading db.json:', err.message);
    return { users: [], auctions: [], bids: [], walletTransactions: [], notifications: [] };
  }
}

// Helper to write updated state to JSON database
function writeDB(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing db.json:', err.message);
  }
}

module.exports = { readDB, writeDB };