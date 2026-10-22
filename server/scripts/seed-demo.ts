import { pool, withTransaction } from "../lib/db";

// Fills a DEVELOPMENT database with three fictional studios and ten listed works so the site has
// something to show. The pictures are generated abstract SVGs stored inline, which is fine for a
// demo and wrong for production. Safe to run twice: it stops if the demo studios already exist.

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed demo data when NODE_ENV=production.");
  process.exit(1);
}

function picture(seed: number, w: number, h: number, palette: string[]): string {
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const r = Math.round;
  const shapes: string[] = [];
  for (let i = 0; i < 7; i++) {
    const fill = palette[1 + Math.floor(rnd() * (palette.length - 1))];
    shapes.push(
      i % 2 === 0
        ? `<circle cx="${r(rnd() * w)}" cy="${r(rnd() * h)}" r="${r((0.1 + rnd() * 0.28) * Math.min(w, h))}" fill="${fill}" opacity="0.88"/>`
        : `<rect x="${r(rnd() * w * 0.65)}" y="${r(rnd() * h * 0.65)}" width="${r((0.2 + rnd() * 0.5) * w)}" height="${r((0.1 + rnd() * 0.4) * h)}" fill="${fill}" opacity="0.82"/>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${palette[0]}"/>${shapes.join("")}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const studios = [
  { slug: "zuri", name: "Studio Zuri", city: "Nairobi", bio: "Paintings and drawings of Nairobi streets and markets." },
  { slug: "pwani", name: "Pwani Prints", city: "Mombasa", bio: "Coastal colour in print, paint and textile." },
  { slug: "mlima", name: "Mlima Works", city: "Kisumu", bio: "Landscape photography, ceramics and large canvases." },
];

type Piece = { studio: string; title: string; genre: string; kes: number; kind: "physical" | "digital"; edition?: number; w: number; h: number; palette: string[] };
const pieces: Piece[] = [
  { studio: "pwani", title: "Morning at Lamu Harbour", genre: "painting", kes: 45000, kind: "physical", w: 1200, h: 900, palette: ["#e9dcc3", "#1f5f8b", "#d9a441", "#b33f40"] },
  { studio: "zuri", title: "Acacia Study No. 2", genre: "drawing-illustration", kes: 12000, kind: "physical", w: 900, h: 1200, palette: ["#efeadf", "#3d3a36", "#8c7b66", "#c9bfae"] },
  { studio: "pwani", title: "Kikoy Pattern in Blue", genre: "textile-art", kes: 18500, kind: "physical", w: 1000, h: 1000, palette: ["#dfe8f2", "#1e3a8a", "#3b82c4", "#f2f2f2"] },
  { studio: "zuri", title: "Market Day, Gikomba", genre: "painting", kes: 78000, kind: "physical", w: 1400, h: 900, palette: ["#f1e2c8", "#c2410c", "#0f766e", "#facc15", "#7c2d12"] },
  { studio: "mlima", title: "Night Ferry", genre: "photography", kes: 9500, kind: "digital", edition: 50, w: 1500, h: 1000, palette: ["#0b1020", "#26324f", "#f2c14e", "#7aa2d6"] },
  { studio: "mlima", title: "Rift Valley, Late Light", genre: "photography", kes: 6500, kind: "digital", edition: 100, w: 900, h: 1350, palette: ["#f4c58a", "#d97a3d", "#6b3a2e", "#2f4858"] },
  { studio: "zuri", title: "Mama Sokoni", genre: "printmaking", kes: 22000, kind: "physical", w: 800, h: 1100, palette: ["#f3efe6", "#1d1d1b", "#a63d2f", "#d9c9a8"] },
  { studio: "mlima", title: "Clay Vessel IV", genre: "ceramics", kes: 34000, kind: "physical", w: 900, h: 1100, palette: ["#e8e1d6", "#8a5a3c", "#c28a5b", "#4b3426"] },
  { studio: "pwani", title: "Signal", genre: "digital-art", kes: 15000, kind: "digital", w: 1200, h: 1200, palette: ["#101828", "#2438c9", "#22d3ee", "#f43f5e"] },
  { studio: "mlima", title: "Baobab at Dusk", genre: "painting", kes: 120000, kind: "physical", w: 1000, h: 1300, palette: ["#f2d9b8", "#5b3a29", "#c1572b", "#2b2d42", "#e0a458"] },
];

const existing = await pool.query(`SELECT 1 FROM users WHERE email LIKE 'demo-%@example.invalid' LIMIT 1`);
if ((existing.rowCount ?? 0) > 0) {
  console.log("Demo data is already present. Nothing to do.");
  await pool.end();
  process.exit(0);
}

await withTransaction(async (client) => {
  const artistIds = new Map<string, string>();
  for (const s of studios) {
    const u = await client.query<{ id: string }>(
      `INSERT INTO users (email, full_name, role, email_verified) VALUES ($1, $2, 'artist', true) RETURNING id`,
      [`demo-${s.slug}@example.invalid`, s.name],
    );
    await client.query(
      `INSERT INTO artist_profiles (user_id, display_name, bio, location_city, kyc_status, kyc_verified_at)
       VALUES ($1, $2, $3, $4, 'verified', now())`,
      [u.rows[0].id, s.name, s.bio, s.city],
    );
    artistIds.set(s.slug, u.rows[0].id);
  }

  let n = 0;
  for (const p of pieces) {
    n += 1;
    const genre = await client.query<{ id: number }>(`SELECT id FROM genres WHERE slug = $1`, [p.genre]);
    if (genre.rowCount === 0) throw new Error(`Genre ${p.genre} is missing. Run npm run db:migrate first.`);
    const image = picture(n * 7919, p.w, p.h, p.palette);
    const digital = p.kind === "digital";
    const art = await client.query<{ id: string }>(
      `INSERT INTO artworks (artist_id, title, description, genre_id, price_cents, status, fulfillment_type,
                             edition_type, edition_size, primary_image_url, created_at)
       VALUES ($1, $2, $3, $4, $5, 'listed', $6, $7, $8, $9, now() - ($10 || ' hours')::interval)
       RETURNING id`,
      [
        artistIds.get(p.studio),
        p.title,
        `A demonstration piece for ${studios.find((s) => s.slug === p.studio)?.name}. The picture is generated, not real work.`,
        genre.rows[0].id,
        p.kes * 100,
        p.kind,
        digital ? (p.edition ? "limited" : "original") : null,
        digital ? (p.edition ?? 1) : null,
        image,
        String(n * 5),
      ],
    );
    await client.query(`INSERT INTO artwork_images (artwork_id, url, position) VALUES ($1, $2, 0)`, [art.rows[0].id, image]);
  }
});

console.log(`Created ${studios.length} demo studios and ${pieces.length} listed artworks.`);
await pool.end();
