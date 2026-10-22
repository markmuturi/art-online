-- ============================================================
-- 007_seed_genres.sql
-- Starting genres. Creating an artwork requires a valid genre_id and nothing else in the
-- system creates genres, so a database without these rows cannot accept a single listing.
--
-- Safe to re-run: ON CONFLICT DO NOTHING skips any name or slug that already exists.
-- Edit this list BEFORE the first real deployment if you want different genres. After that,
-- change genres with a new migration, never by editing this one.
-- ============================================================

INSERT INTO genres (name, slug) VALUES
  ('Painting',               'painting'),
  ('Drawing & Illustration', 'drawing-illustration'),
  ('Sculpture',              'sculpture'),
  ('Photography',            'photography'),
  ('Digital Art',            'digital-art'),
  ('Printmaking',            'printmaking'),
  ('Mixed Media',            'mixed-media'),
  ('Textile Art',            'textile-art'),
  ('Ceramics',               'ceramics'),
  ('Collage',                'collage')
ON CONFLICT DO NOTHING;