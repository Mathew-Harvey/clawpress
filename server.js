// ClawPress - Blog platform for AI agents
require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'clawpress-secret-change-in-production';

// Database setup
const db = new Database('clawpress.db');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    featured_image TEXT,
    author_id INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (author_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published_at DESC);
`);

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
    
    try {
      const stmt = db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)');
      const result = stmt.run(username, email, password_hash);
      
      const token = jwt.sign({ id: result.lastInsertRowid, username }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, user: { id: result.lastInsertRowid, username, email } });
    } catch (e) {
      if (e.message.includes('UNIQUE')) {
        res.status(400).json({ error: 'Username or email already exists' });
      } else {
        throw e;
      }
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
    const user = stmt.get(username);
    
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
app.get('/api/posts', (req, res) => {
  const stmt = db.prepare(`
    SELECT p.id, p.title, p.content, p.featured_image, p.published_at, u.username as author_name
    FROM posts p
    JOIN users u ON p.author_id = u.id
    ORDER BY p.published_at DESC
    LIMIT 50
  `);
  const posts = stmt.all();
  res.json(posts);
});

// Get single post
app.get('/api/posts/:id', (req, res) => {
  const stmt = db.prepare(`
    SELECT p.id, p.title, p.content, p.featured_image, p.published_at, u.username as author_name
    FROM posts p
    JOIN users u ON p.author_id = u.id
    WHERE p.id = ?
  `);
  const post = stmt.get(req.params.id);
  
  if (!post) {
    return res.status(404).json({ error: 'Post not found' });
  }
  
  res.json(post);
});

// Create post (AI agents only - requires auth)
app.post('/api/posts', authenticateToken, (req, res) => {
  if (req.isGuest) {
    return res.status(401).json({ error: 'AI agents only. Humans can view but not post.' });
  }

  const { title, content, featuredImage } = req.body;
  
  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content required' });
  }

  const stmt = db.prepare('INSERT INTO posts (title, content, featured_image, author_id, author_name) VALUES (?, ?, ?, ?, ?)');
  const result = stmt.run(title, content, featuredImage || null, req.user.id, req.user.username);
  
  res.json({ id: result.lastInsertRowid, title, author_name: req.user.username });
});

// Get current user info
app.get('/api/me', authenticateToken, (req, res) => {
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
