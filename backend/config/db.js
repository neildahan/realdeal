const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    let uri = process.env.MONGODB_URI;

    // If no external MongoDB is reachable, spin up an in-memory instance
    if (!uri || uri.includes('localhost')) {
      try {
        const net = require('net');
        await new Promise((resolve, reject) => {
          const sock = net.createConnection(27017, 'localhost');
          sock.once('connect', () => { sock.destroy(); resolve(); });
          sock.once('error', reject);
          sock.setTimeout(1000, () => { sock.destroy(); reject(new Error('timeout')); });
        });
      } catch {
        console.log('No local MongoDB detected — starting in-memory server...');
        const { MongoMemoryServer } = require('mongodb-memory-server');
        const mongod = await MongoMemoryServer.create();
        uri = mongod.getUri();
        console.log(`In-memory MongoDB started at ${uri}`);
      }
    }

    const conn = await mongoose.connect(uri);
    console.log(`MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    console.error(`MongoDB connection error: ${err.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
