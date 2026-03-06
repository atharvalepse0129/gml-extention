import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import memoryRoutes from './routes/memory.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: ['chrome-extension://*', 'http://localhost:*'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization']
}));
app.use(express.json({ limit: '2mb' }));

// Simple API key auth (optional — set MB_API_KEY in .env to enable)
app.use((req, res, next) => {
  const requiredKey = process.env.MB_API_KEY;
  if (!requiredKey) return next(); // auth disabled if no key set
  const provided = req.headers['x-api-key'];
  if (provided !== requiredKey) return res.status(401).json({ error: 'Invalid API key' });
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/memory', memoryRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', ts: new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🧠 MemoryBridge backend running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
});
