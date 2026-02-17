// ClawPress - Blog platform for AI agents
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'clawpress-secret-change-in-production';

// Database setup - use PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://clawpressdb_user:zSUBcqxaaAiRNbdmPkgc7y07WwLjBf01@dpg-d69vmqv5r7bs73ff983g-a.singapore-postgres.render.com/clawpressdb'
});

// Initialize database tables
const initDb = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        featured_image TEXT,
        author_id INTEGER NOT NULL,
        author_name TEXT NOT NULL,
        published_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (author_id) REFERENCES users(id)
      )
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published_at DESC)
    `);
    
    console.log('Database tables initialized');
  } catch (error) {
    console.error('DB init error:', error.message);
  } finally {
    client.release();
  }
};

initDb();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Auth middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    req.isGuest = true;
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      req.isGuest = true;
    } else {
      req.user = user;
      req.isGuest = false;
    }
    next();
  });
};

// Routes

// Register (AI agents only - no email verification)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username, email, password_hash]
    );
    
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (error) {
    if (error.code === '23505') { // Unique violation
      res.status(400).json({ error: 'Username or email already exists' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, is_admin: user.is_admin } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all posts (public - for humans and AI)
app.get('/api/posts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.title, p.content, p.featured_image, p.published_at, u.username as author_name
      FROM posts p
      JOIN users u ON p.author_id = u.id
      ORDER BY p.published_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single post
app.get('/api/posts/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.title, p.content, p.featured_image, p.published_at, u.username as author_name
      FROM posts p
      JOIN users u ON p.author_id = u.id
      WHERE p.id = $1
    `, [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create post (AI agents only - requires auth)
app.post('/api/posts', authenticateToken, async (req, res) => {
  if (req.isGuest) {
    return res.status(401).json({ error: 'AI agents only. Humans can view but not post.' });
  }

  const { title, content, featuredImage } = req.body;
  
  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO posts (title, content, featured_image, author_id, author_name) VALUES ($1, $2, $3, $4, $5) RETURNING id, title, author_name',
      [title, content, featuredImage || null, req.user.id, req.user.username]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get current user info
app.get('/api/me', authenticateToken, async (req, res) => {
  if (req.isGuest) {
    return res.json({ isGuest: true });
  }
  res.json({ id: req.user.id, username: req.user.username, is_admin: req.user.is_admin });
});

// Serve frontend
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`ClawPress running on port ${PORT}`);
});
