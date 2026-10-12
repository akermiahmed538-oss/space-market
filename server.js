const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // change it!

// ---------- Database ----------
const db = new Database(process.env.DB_FILE || path.join(__dirname, 'market.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT,
  category TEXT, price REAL NOT NULL, stock INTEGER DEFAULT 10, emoji TEXT DEFAULT '📦');
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL,
  address TEXT NOT NULL, total REAL NOT NULL, status TEXT DEFAULT 'New',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS order_items(
  order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER,
  name TEXT, qty INTEGER, price REAL);
`);

try { db.exec('ALTER TABLE products ADD COLUMN image TEXT'); } catch (e) { /* column already exists */ }

if (db.prepare('SELECT COUNT(*) c FROM products').get().c === 0) {
  const ins = db.prepare('INSERT INTO products(name,description,category,price,stock,emoji) VALUES(?,?,?,?,?,?)');
  [
    ['Galaxy Projector','Fills any room with slow-moving nebulae and stars. USB powered, 3 light modes.','Gadgets',39,15,'🌌'],
    ['Orbit Wireless Charger','15W fast wireless charging pad with a floating-planet design.','Gadgets',22,30,'🔋'],
    ['Moon Lamp','Rechargeable 3D-printed moon with touch dimmer and warm or cool light.','Home & Decor',29,20,'🌙'],
    ['Solar System Poster','60x90 cm matte print of every planet drawn to relative scale.','Home & Decor',12,50,'🪐'],
    ['Rocket Mug','Ceramic 350 ml mug, dishwasher safe, with a launch-pad handle.','Home & Decor',14,40,'🚀'],
    ['Constellation Hoodie','Heavy cotton hoodie with glow-in-the-dark star map. Unisex fit.','Apparel',49,12,'🧥'],
    ['Astronaut Socks (2 pairs)','Soft stretch socks with tiny rockets and planets.','Apparel',9,60,'🧦'],
    ['Beginner Telescope','70 mm refractor with tripod and moon filter. Ideal for first-time stargazers.','Science & Toys',89,8,'🔭'],
    ['Mars Rover Building Kit','320-piece snap-together rover with movable wheels and arm.','Science & Toys',59,10,'🤖'],
    ['Astronaut Ice Cream','Freeze-dried neapolitan ice cream, the classic space snack. Pack of 6.','Science & Toys',6,100,'🍦'],
    ['Meteorite Pendant','Genuine Campo del Cielo meteorite fragment on a steel chain.','Accessories',35,5,'☄️'],
    ['Cosmic Notebook','A5 hardcover, 192 dotted pages, foil-stamped nebula cover.','Accessories',9,45,'📓'],
  ].forEach(r => ins.run(...r));
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const admin = (req, res, next) =>
  req.get('x-admin-password') === ADMIN_PASSWORD ? next() : res.status(401).json({ error: 'Wrong admin password' });

const withItems = rows => {
  const q = db.prepare('SELECT name, qty, price FROM order_items WHERE order_id=?');
  return rows.map(o => ({ ...o, items: q.all(o.id) }));
};

// Products
app.get('/api/products', (req, res) =>
  res.json(db.prepare('SELECT * FROM products ORDER BY id').all()));

app.post('/api/products', admin, (req, res) => {
  const { name, description, category, price, stock, emoji, image } = req.body || {};
  if (!name || !(+price > 0)) return res.status(400).json({ error: 'Name and a positive price are required' });
  const img = typeof image === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(image) && image.length < 450000 ? image : null;
  if (image && !img) return res.status(400).json({ error: 'Image must be JPG, PNG or WebP and under ~300 KB' });
  const r = db.prepare('INSERT INTO products(name,description,category,price,stock,emoji,image) VALUES(?,?,?,?,?,?,?)')
    .run(String(name).slice(0, 120), String(description || '').slice(0, 400), String(category || 'Gadgets').slice(0, 60),
      +price, Math.max(0, Math.floor(+stock || 0)), String(emoji || '📦').slice(0, 8), img);
  res.json({ id: r.lastInsertRowid });
});

app.patch('/api/products/:id', admin, (req, res) => {
  const stock = Math.floor(+req.body.stock);
  if (!(stock >= 0)) return res.status(400).json({ error: 'Invalid stock' });
  db.prepare('UPDATE products SET stock=? WHERE id=?').run(stock, +req.params.id);
  res.json({ ok: true });
});

app.delete('/api/products/:id', admin, (req, res) => {
  db.prepare('DELETE FROM products WHERE id=?').run(+req.params.id);
  res.json({ ok: true });
});

// Orders
app.post('/api/orders', (req, res) => {
  const { name, email, address, items } = req.body || {};
  if (!name || !/^\S+@\S+\.\S+$/.test(email || '') || !address || !Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'Please fill in all fields with a valid email' });
  const get = db.prepare('SELECT * FROM products WHERE id=?');
  let total = 0;
  const rows = [];
  for (const it of items) {
    const p = get.get(+it.id), qty = Math.floor(+it.qty);
    if (!p || !(qty > 0 && qty <= 50)) return res.status(400).json({ error: 'Invalid item in cart' });
    if (p.stock < qty) return res.status(400).json({ error: `Not enough stock for ${p.name} (${p.stock} left)` });
    total += p.price * qty; // price always comes from the database
    rows.push([p, qty]);
  }
  const create = db.transaction(() => {
    const id = db.prepare('INSERT INTO orders(name,email,address,total) VALUES(?,?,?,?)')
      .run(String(name).slice(0, 100), String(email).toLowerCase().slice(0, 120), String(address).slice(0, 200), total).lastInsertRowid;
    const ins = db.prepare('INSERT INTO order_items(order_id,product_id,name,qty,price) VALUES(?,?,?,?,?)');
    const dec = db.prepare('UPDATE products SET stock=stock-? WHERE id=?');
    rows.forEach(([p, q]) => { ins.run(id, p.id, p.name, q, p.price); dec.run(q, p.id); });
    return id;
  });
  res.json({ id: create() });
});

app.get('/api/orders', (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter the email used for the order' });
  res.json(withItems(db.prepare('SELECT * FROM orders WHERE email=? ORDER BY id DESC').all(email)));
});

app.get('/api/admin/orders', admin, (req, res) =>
  res.json(withItems(db.prepare('SELECT * FROM orders ORDER BY id DESC').all())));

app.patch('/api/orders/:id', admin, (req, res) => {
  const st = req.body && req.body.status;
  if (!['New', 'Packed', 'Shipped', 'Delivered'].includes(st)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(st, +req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Space Market running on http://localhost:${PORT}`));
