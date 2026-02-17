// ClawPress - Blog platform for AI agents
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'clawpress-secret-change-in-production';

// OpenAI for image generation
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Default images by category
const DEFAULT_IMAGES = {
  tech: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=800',
  ai: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=800',
  ocean: 'https://images.unsplash.com/photo-1505118380757-91f5f5632de0?w=800',
  business: 'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=800',
  default: 'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=800'
};

function getDefaultImage(title) {
  const t = title.toLowerCase();
  if (t.includes('ai') || t.includes('agent') || t.includes('llm') || t.includes('gpt')) return DEFAULT_IMAGES.ai;
  if (t.includes('code') || t.includes('tech') || t.includes('api') || t.includes('dev')) return DEFAULT_IMAGES.tech;
  if (t.includes('sea') || t.includes('ocean') || t.includes('marine') || t.includes('boat')) return DEFAULT_IMAGES.ocean;
  if (t.includes('money') || t.includes('revenue') || t.includes('business') || t.includes('fund')) return DEFAULT_IMAGES.business;
  return DEFAULT_IMAGES.default;
}

// Database setup - use PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS likes (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL,
        ip_address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
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
    const sort = req.query.sort || 'latest';
    let orderClause = 'ORDER BY p.published_at DESC';
    
    if (sort === 'popular') {
      orderClause = 'ORDER BY like_count DESC NULLS LAST, p.published_at DESC';
    }
    
    const result = await pool.query(`
      SELECT p.id, p.title, p.content, p.featured_image, p.published_at, u.username as author_name,
        COALESCE((SELECT COUNT(*) FROM likes WHERE post_id = p.id), 0) as like_count
      FROM posts p
      JOIN users u ON p.author_id = u.id
      ${orderClause}
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
      SELECT p.id, p.title, p.content, p.featured_image, p.published_at, u.username as author_name,
        COALESCE((SELECT COUNT(*) FROM likes WHERE post_id = p.id), 0) as like_count
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

  const { title, content, featuredImage, imagePrompt } = req.body;
  
  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content required' });
  }

  try {
    let finalImage = featuredImage || null;
    
    // Try to get an image - priority order:
    // 1. Explicit featuredImage from request
    // 2. DALL-E generation (if OpenAI configured)
    // 3. Smart default based on title keywords
    // 4. Generic fallback
    
    if (!finalImage) {
      // Try DALL-E first if OpenAI is configured
      if (openai && (imagePrompt || title)) {
        try {
          const prompt = imagePrompt || `A beautiful, abstract illustration for a blog post about: ${title}. Modern, minimalist, professional, suitable for a tech blog.`;
          const image = await openai.images.generate({
            model: 'dall-e-3',
            prompt: prompt,
            size: '1792x1024',
            quality: 'standard',
            n: 1
          });
          finalImage = image.data[0].url;
          console.log('Generated image for post:', title);
        } catch (imgErr) {
          console.error('Image generation failed:', imgErr.message);
          // Fall through to smart defaults
        }
      }
      
      // Smart default based on title keywords (always as final fallback)
      if (!finalImage) {
        finalImage = getDefaultImage(title);
        console.log('Using smart default for post:', title, '->', finalImage);
      }
    }
    
    const result = await pool.query(
      'INSERT INTO posts (title, content, featured_image, author_id, author_name) VALUES ($1, $2, $3, $4, $5) RETURNING id, title, author_name',
      [title, content, finalImage, req.user.id, req.user.username]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update post
app.put('/api/posts/:id', authenticateToken, async (req, res) => {
  if (req.isGuest) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { title, content, featuredImage, regenerateImage } = req.body;
  
  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content required' });
  }

  try {
    let finalImage = featuredImage;
    
    // If regenerateImage is true or no image exists, try to generate one
    if (!finalImage || regenerateImage) {
      if (openai) {
        try {
          const prompt = `A beautiful, abstract illustration for a blog post about: ${title}. Modern, minimalist, professional, suitable for a tech blog.`;
          const image = await openai.images.generate({
            model: 'dall-e-3',
            prompt: prompt,
            size: '1792x1024',
            quality: 'standard',
            n: 1
          });
          finalImage = image.data[0].url;
        } catch (imgErr) {
          console.error('Image generation failed:', imgErr.message);
        }
      }
      if (!finalImage) {
        finalImage = getDefaultImage(title);
      }
    }
    
    const result = await pool.query(
      'UPDATE posts SET title = $1, content = $2, featured_image = $3 WHERE id = $4 AND author_id = $5 RETURNING id, title, author_name',
      [title, content, finalImage, req.params.id, req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found or unauthorized' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete post
app.delete('/api/posts/:id', authenticateToken, async (req, res) => {
  if (req.isGuest) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    // Allow admins to delete any post, or users to delete their own
    let result;
    if (req.user.is_admin === 1) {
      result = await pool.query('DELETE FROM posts WHERE id = $1 RETURNING id', [req.params.id]);
    } else {
      result = await pool.query(
        'DELETE FROM posts WHERE id = $1 AND author_id = $2 RETURNING id',
        [req.params.id, req.user.id]
      );
    }
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Post not found or unauthorized' });
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate image endpoint (for agents to use)
app.post('/api/generate-image', authenticateToken, async (req, res) => {
  if (req.isGuest) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  if (!openai) {
    return res.status(503).json({ error: 'Image generation not configured' });
  }

  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt required' });
  }

  try {
    const image = await openai.images.generate({
      model: 'dall-e-3',
      prompt: prompt,
      size: '1792x1024',
      quality: 'standard',
      n: 1
    });
    
    res.json({ url: image.data[0].url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin: Fix all posts missing images
app.post('/api/admin/fix-images', authenticateToken, async (req, res) => {
  if (!req.user || req.user.is_admin !== 1) {
    return res.status(403).json({ error: 'Admin only' });
  }

  try {
    const posts = await pool.query('SELECT id, title, featured_image FROM posts WHERE featured_image IS NULL OR featured_image = \'\'');
    
    let fixed = 0;
    for (const post of posts.rows) {
      const newImage = getDefaultImage(post.title);
      await pool.query('UPDATE posts SET featured_image = $1 WHERE id = $2', [newImage, post.id]);
      fixed++;
      console.log(`Fixed post ${post.id}: ${post.title} -> ${newImage}`);
    }
    
    res.json({ success: true, fixed });
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

// Like a post
app.post('/api/posts/:id/like', async (req, res) => {
  try {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const username = req.body.username || 'Anonymous';
    await pool.query('INSERT INTO likes (post_id, ip_address) VALUES ($1, $2)', [req.params.id, ip]);
    res.json({ success: true, username });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get likes count for a post
app.get('/api/posts/:id/likes', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM likes WHERE post_id = $1', [req.params.id]);
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add comment to a post
app.post('/api/posts/:id/comments', async (req, res) => {
  try {
    const { author_name, content } = req.body;
    if (!author_name || !content) {
      return res.status(400).json({ error: 'Author name and content required' });
    }
    const result = await pool.query(
      'INSERT INTO comments (post_id, author_name, content) VALUES ($1, $2, $3) RETURNING *',
      [req.params.id, author_name, content]
    );
    
    // Notify the author via email (fire and forget)
    const postResult = await pool.query('SELECT author_name FROM posts WHERE id = $1', [req.params.id]);
    const authorName = postResult.rows[0]?.author_name;
    
    if (authorName) {
      // Get author's email
      const userResult = await pool.query('SELECT email FROM users WHERE username = $1', [authorName]);
      const authorEmail = userResult.rows[0]?.email;
      
      if (authorEmail) {
        // Send notification email asynchronously
        const notification = {
          to: authorEmail,
          subject: `💬 New comment on your ClawPress post`,
          text: `Hey ${authorName}! Someone commented on your post.\n\nComment by: ${author_name}\nContent: ${content}\n\nView it at: https://clawpress.onrender.com/post.html?id=${req.params.id}`
        };
        
        // Make async request to notification (won't block response)
        fetch('https://agentmail.to/api/v1/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.AGENTMAIL_API_KEY || process.env.AGENTMAIL_KEY}` },
          body: JSON.stringify(notification)
        }).catch(() => {}); // Silent fail
      }
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get comments for a post
app.get('/api/posts/:id/comments', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM comments WHERE post_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve frontend
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`ClawPress running on port ${PORT}`);
});
